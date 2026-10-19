'use strict';
const {randomBytes,randomUUID}=require('node:crypto');
const CODE_ALPHABET='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CHECKPOINTS=Object.freeze([
  Object.freeze({x:0,z:14}),
  Object.freeze({x:26,z:21}),
  Object.freeze({x:19,z:-20}),
  Object.freeze({x:-29,z:-11})
]);
const MAX_PLAYERS=4, GRACE_MS=25000, MAX_PAYLOAD=4096;
const errors={
  room_not_found:'Комната не найдена',
  room_full:'Комната заполнена (максимум 4 игрока)',
  race_active:'Испытание уже идёт',
  not_in_room:'Вы не находитесь в комнате',
  not_host:'Начать испытание может только ведущий',
  invalid_message:'Некорректный запрос',
  invalid_state:'Некорректная позиция',
};
function sanitizeName(value){
  const name=typeof value==='string'?value.replace(/[<>\u0000-\u001f]/g,'').trim().slice(0,18):'';
  return name||'Водитель';
}
function safeState(value,clock=Date.now()){
  if(!value||!Array.isArray(value.p)||value.p.length!==3||
     !value.p.every(v=>typeof v==='number'&&Number.isFinite(v)))return null;
  const finite=(v,min,max)=>typeof v==='number'&&Number.isFinite(v)?
    Math.min(max,Math.max(min,v)):0;
  return {p:value.p.map(v=>finite(v,-110,110)),
    y:finite(value.y,-7,7),s:finite(value.s,-40,40),
    st:finite(value.st,-1,1),b:value.b===true,t:clock};
}
function createRoomManager({now=Date.now,codeFactory=null,physicsFactory=null}={}){
  const clients=new Map(),rooms=new Map(),tokens=new Map();
  function send(ws,msg){
    if(ws&&ws.readyState===1){
      try{ws.send(JSON.stringify(msg));}catch(_){}
    }
  }
  function fail(client,code){send(client.ws,{type:'error',code,
    message:errors[code]||errors.invalid_message});}
  function idCode(){
    if(codeFactory)return codeFactory();
    let value='';
    const bytes=randomBytes(6);
    for(const b of bytes)value+=CODE_ALPHABET[b%CODE_ALPHABET.length];
    return value;
  }
  function makeCode(){
    for(let n=0;n<25;n++){
      const code=idCode();
      if(/^[A-Z2-9]{6}$/.test(code)&&!rooms.has(code))return code;
    }
    throw Error('room code generator exhausted');
  }
  const findRoom=client=>client.room?rooms.get(client.room):null;
  function active(room){return [...room.members].map(id=>clients.get(id))
    .filter(c=>c&&!!c.ws);}
  function publicMember(c){
    const room=findRoom(c);
    const authoritative=room?.physics?.snapshot().players.find(p=>p.id===c.id);
    const state=authoritative?
      {p:authoritative.p,y:0,s:authoritative.s,st:authoritative.st,
        b:authoritative.b,q:authoritative.q,ack:authoritative.ack}:
      (room?.physics?null:c.state);
    return {id:c.id,name:c.name,connected:Boolean(c.ws),state};
  }
  function announce(room,msg,skipId){
    for(const id of room.members){
      if(id===skipId)continue;
      const c=clients.get(id);
      if(c)send(c.ws,msg);
    }
  }
  function stateOf(room){
    return {type:'room',code:room.code,host:room.host,
      authoritative:Boolean(room.physics),
      members:[...room.members].map(id=>clients.get(id))
        .filter(Boolean).map(publicMember),
      race:room.race?{
        phase:'running',stage:room.race.stage,targets:CHECKPOINTS,
        reached:[...room.race.reached],startedAt:room.race.startedAt
      }:null};
  }
  function publish(room){announce(room,stateOf(room));}
  function pickHost(room){
    const present=active(room);
    room.host=present[0]?.id||[...room.members][0]||null;
  }
  function cancelRace(room,reason='Испытание отменено'){
    if(!room.race)return;
    room.race=null;
    announce(room,{type:'race-cancel',reason});publish(room);
  }
  function leave(client,{notify=true}={}){
    const room=findRoom(client);
    if(!room){client.room=null;return;}
    if(room.race)cancelRace(room,'Участник покинул совместное испытание');
    room.members.delete(client.id);client.room=null;
    room.physics?.removePlayer(client.id);
    if(!room.members.size){
      room.physics?.dispose();
      rooms.delete(room.code);
    }
    else {
      if(room.host===client.id)pickHost(room);
      announce(room,{type:'peer-left',id:client.id});
      publish(room);
    }
    if(notify)send(client.ws,{type:'left'});
  }
  function enter(client,room){
    if(client.room!==room.code)leave(client,{notify:false});
    if(!room.members.has(client.id)){
      if(room.race){fail(client,'race_active');return;}
      if(room.members.size>=MAX_PLAYERS){fail(client,'room_full');return;}
      room.members.add(client.id);
    }
    client.room=room.code;
    room.physics?.addPlayer(client.id,room.members.size-1);
    client.state=null;
    client.lastStateAt=0;
    send(client.ws,stateOf(room));
    announce(room,{type:'peer-joined',member:publicMember(client)},client.id);
    publish(room);
  }
  function create(client){
    if(rooms.size>=64){
      send(client.ws,{type:'error',code:'server_busy',
        message:'Сервер временно заполнен. Повторите позже.'});
      return;
    }
    leave(client,{notify:false});
    const code=makeCode();
    const room={code,host:client.id,members:new Set(),race:null,
      physics:physicsFactory?.(code)||null};
    rooms.set(code,room);enter(client,room);
  }
  function join(client,raw){
    const code=typeof raw==='string'?raw.trim().toUpperCase():'';
    const room=rooms.get(code);
    if(!room){fail(client,'room_not_found');return;}
    if(room.code===client.room){send(client.ws,stateOf(room));return;}
    // Validate destination before leaving the existing room.
    if(room.race){fail(client,'race_active');return;}
    if(room.members.size>=MAX_PLAYERS){fail(client,'room_full');return;}
    enter(client,room);
  }
  function startRace(client){
    const room=findRoom(client);
    if(!room){fail(client,'not_in_room');return;}
    if(room.host!==client.id){fail(client,'not_host');return;}
    if(room.race){fail(client,'race_active');return;}
    const members=active(room);
    if(members.length<2){send(client.ws,{
      type:'error',code:'need_partner',message:'Нужен хотя бы один напарник'});return;}
    if(members.length!==room.members.size){send(client.ws,{
      type:'error',code:'absent_player',message:'Подождите возвращения всех участников'});return;}
    // All drivers reposition at their workshop spawn when the race begins.
    // Clear stale pre-race poses so legitimate respawns aren't flagged as teleports.
    for(const member of members){member.state=null;member.lastStateAt=0;}
    room.physics?.resetAll();
    room.race={stage:0,reached:new Set(),startedAt:now()};
    announce(room,{type:'race-start',stage:0,targets:CHECKPOINTS,
      startedAt:room.race.startedAt});
    publish(room);
  }
  function receiveState(client,state){
    const room=findRoom(client);if(!room)return;
    // Older snapshots must NEVER influence a server-authoritative room.
    if(room.physics)return;
    const time=now();const normalized=safeState(state,time);
    if(!normalized){fail(client,'invalid_state');return;}
    if(time-client.lastStateAt<35)return;
    // Reject implausible movement without treating a physics rollover as cheating.
    // A new stage does not teleport cars, so all race updates are continuous.
    if(client.state&&client.lastStateAt){
      const dt=Math.min(2,(time-client.lastStateAt)/1000);
      const dx=normalized.p[0]-client.state.p[0],
        dz=normalized.p[2]-client.state.p[2];
      if(Math.hypot(dx,dz)>3+48*dt){fail(client,'invalid_state');return;}
    }
    client.state=normalized;client.lastStateAt=time;
    announce(room,{type:'peer-state',id:client.id,state:normalized},client.id);
    const race=room.race;
    if(!race||race.reached.has(client.id))return;
    const target=CHECKPOINTS[race.stage];
    const distance=Math.hypot(state.p[0]-target.x,state.p[2]-target.z);
    if(distance>5)return;
    race.reached.add(client.id);
    announce(room,{type:'race-progress',stage:race.stage,
      reached:[...race.reached],targets:CHECKPOINTS});
    if(race.reached.size===room.members.size){
      race.stage++;
      race.reached.clear();
      if(race.stage>=CHECKPOINTS.length){
        const duration=Math.max(0,(time-race.startedAt)/1000);
        announce(room,{type:'race-finish',duration,players:room.members.size});
        room.race=null;
      }else announce(room,{type:'race-progress',stage:race.stage,
        reached:[],targets:CHECKPOINTS});
      publish(room);
    }
  }
  function receiveInput(client,command){
    const room=findRoom(client);
    if(!room||!room.physics)return;
    if(!room.physics.input(client.id,command))fail(client,'invalid_message');
  }
  // Server-only state advances; checkpoint progress reads Rapier positions,
  // never coordinates provided by a remote browser.
  function advance(){
    for(const room of rooms.values()){
      if(!room.physics)continue;
      room.physics.step();
      const state=room.physics.snapshot();
      if(state.tick%3===0)announce(room,state);
      const race=room.race;
      if(!race)continue;
      const target=CHECKPOINTS[race.stage];
      for(const id of room.members){
        if(race.reached.has(id))continue;
        const position=room.physics.position(id);
        if(position&&Math.hypot(position.x-target.x,position.z-target.z)<=5){
          race.reached.add(id);
          announce(room,{type:'race-progress',stage:race.stage,
            reached:[...race.reached],targets:CHECKPOINTS});
        }
      }
      if(race.reached.size===room.members.size){
        race.stage++;race.reached.clear();
        if(race.stage>=CHECKPOINTS.length){
          announce(room,{type:'race-finish',
            duration:Math.max(0,(now()-race.startedAt)/1000),
            players:room.members.size});
          room.race=null;
        }else announce(room,{type:'race-progress',stage:race.stage,
          reached:[],targets:CHECKPOINTS});
        publish(room);
      }
    }
  }
  function resume(client,token){
    if(typeof token!=='string'||token.length>96)return false;
    const oldId=tokens.get(token),old=oldId&&clients.get(oldId);
    if(!old||old.ws||!old.detachedAt||now()-old.detachedAt>GRACE_MS)return false;
    // Provisional connection identity is discarded; the original seat returns.
    clients.delete(client.id);tokens.delete(client.token);
    old.ws=client.ws;old.detachedAt=null;
    old.wsClientId=old.id;
    const room=findRoom(old);
    send(old.ws,{type:'welcome',id:old.id,token:old.token,resumed:true});
    if(room) {
      send(old.ws,stateOf(room));
      publish(room);
    }
    return true;
  }
  function connect(ws){
    const client={id:randomUUID(),token:randomBytes(24).toString('hex'),
      ws,name:'Водитель',state:null,lastStateAt:0,room:null,
      detachedAt:null};
    clients.set(client.id,client);tokens.set(client.token,client.id);
    send(ws,{type:'welcome',id:client.id,token:client.token,resumed:false});
    function resolve(){
      for(const c of clients.values())if(c.ws===ws)return c;
      return null;
    }
    function message(raw){
      if(Buffer.byteLength(raw)>MAX_PAYLOAD)return;
      let data;
      try{data=JSON.parse(raw.toString());}catch(_){return;}
      const current=resolve();
      if(!current||!data||typeof data!=='object'||Array.isArray(data))return;
      if(data.type==='resume'){
        if(!resume(current,data.token))send(current.ws,{type:'resume-failed'});
        return;
      }
      if(data.type==='name') {
        current.name=sanitizeName(data.name);
        const room=findRoom(current);if(room)publish(room);
      }else if(data.type==='create-room')create(current);
      else if(data.type==='join-room')join(current,data.code);
      else if(data.type==='leave-room')leave(current);
      else if(data.type==='reset-position'){
        const room=findRoom(current);
        if(room&&!room.race){
          if(room.physics)room.physics.recover(current.id);
          else {current.state=null;current.lastStateAt=0;}
        }
      }
      else if(data.type==='recover'){
        const room=findRoom(current);
        if(room)room.physics?.recover(current.id);
      }
      else if(data.type==='input')receiveInput(current,data.input);
      else if(data.type==='start-race')startRace(current);
      else if(data.type==='state')receiveState(current,data.state);
    }
    function disconnect(){
      const current=resolve();if(!current)return;
      current.ws=null;current.detachedAt=now();
      const room=findRoom(current);
      if(room){
        announce(room,{type:'peer-offline',id:current.id});
        publish(room);
      }else{
        clients.delete(current.id);tokens.delete(current.token);
      }
    }
    ws.on('message',message);
    ws.on('close',disconnect);
    ws.on('error',()=>{});
    return client.id;
  }
  function cleanup(){
    const time=now();
    for(const client of [...clients.values()]){
      if(client.ws||client.detachedAt===null||time-client.detachedAt<=GRACE_MS)continue;
      leave(client,{notify:false});
      clients.delete(client.id);tokens.delete(client.token);
    }
  }
  return {connect,cleanup,advance,rooms,clients,receiveState,
    constants:{MAX_PLAYERS,GRACE_MS,CHECKPOINTS}};
}
module.exports={createRoomManager,safeState,sanitizeName,CHECKPOINTS,MAX_PLAYERS,GRACE_MS};
