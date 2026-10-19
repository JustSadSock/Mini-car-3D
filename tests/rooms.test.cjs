const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {createRoomManager}=require('../multiplayer/rooms.cjs');
class Socket extends EventEmitter{
  constructor(){super();this.readyState=1;this.out=[];}
  send(s){this.out.push(JSON.parse(s));}
  receive(value){this.emit('message',Buffer.from(JSON.stringify(value)));}
  last(type){return this.out.filter(x=>x.type===type).at(-1);}
  close(){this.readyState=3;this.emit('close');}
}
function harness(){
 let clock=100000;
 let codeNum=0;
 const codes=['ABC234','DEF567','GHJ789'];
 const m=createRoomManager({now:()=>clock,codeFactory:()=>codes[codeNum++]});
 const make=()=>{const ws=new Socket();m.connect(ws);return ws;};
 return {m,make,advance:ms=>clock+=ms};
}
function enterRoom(h){
 const a=h.make();a.receive({type:'name',name:'Lead'});
 a.receive({type:'create-room'});
 return {a,code:a.last('room').code,id:a.last('welcome').id};
}
test('rooms are isolated and players cannot leak state across them',()=>{
 const h=harness(),{a,code,id}=enterRoom(h);
 const b=h.make(),c=h.make();
 b.receive({type:'join-room',code});c.receive({type:'create-room'});
 const bId=b.last('welcome').id;
 a.receive({type:'state',state:{p:[1,.6,2],y:0,s:1,st:0,b:false}});
 assert.equal(b.last('peer-state').id,id);
 assert.equal(c.last('peer-state'),undefined);
 assert.equal(a.last('room').members.length,2);
 assert.equal(c.last('room').members.length,1);
 b.receive({type:'leave-room'});
 assert.ok(a.last('peer-left').id===bId);
 assert.equal(b.last('left').type,'left');
});
test('private rooms fill to four, join errors do not evict current room',()=>{
 const h=harness(),first=enterRoom(h);
 for(let i=0;i<3;i++){
   const ws=h.make();ws.receive({type:'join-room',code:first.code});
   assert.equal(ws.last('room').code,first.code);
 }
 const extra=h.make();extra.receive({type:'create-room'});
 const own=extra.last('room').code;
 extra.receive({type:'join-room',code:first.code});
 assert.equal(extra.last('error').code,'room_full');
 assert.equal(h.m.clients.get(extra.last('welcome').id).room,own);
});
test('room host migrates after explicit leave, empty room gets deleted',()=>{
 const h=harness(),{a,code}=enterRoom(h);
 const b=h.make();b.receive({type:'join-room',code});
 a.receive({type:'leave-room'});
 assert.equal(b.last('room').host,b.last('welcome').id);
 b.receive({type:'leave-room'});
 assert.equal(h.m.rooms.has(code),false);
});
test('disconnect retains seat, authenticated resume restores same id',()=>{
 const h=harness(),{a,code,id}=enterRoom(h);
 const token=a.last('welcome').token;
 const b=h.make();b.receive({type:'join-room',code});
 a.close();
 assert.equal(b.last('peer-offline').id,id);
 const re=h.make();re.receive({type:'resume',token});
 assert.equal(re.last('welcome').id,id);
 assert.equal(re.last('welcome').resumed,true);
 assert.equal(re.last('room').code,code);
 assert.equal(re.last('room').members.length,2);
 re.close();h.advance(26000);h.m.cleanup();
 assert.equal(h.m.rooms.get(code).members.size,1);
});
test('convoy race needs host and partner, everybody must reach each checkpoint',()=>{
 const h=harness(),{a,code,id}=enterRoom(h);
 a.receive({type:'start-race'});
 assert.equal(a.last('error').code,'need_partner');
 const b=h.make();b.receive({type:'join-room',code});
 b.receive({type:'start-race'});
 assert.equal(b.last('error').code,'not_host');
 a.receive({type:'start-race'});
 assert.equal(a.last('race-start').stage,0);
 const start=h.m.constants.CHECKPOINTS[0];
 a.receive({type:'state',state:{p:[start.x,.6,start.z],y:0,s:2,st:0,b:false}});
 assert.equal(b.last('race-progress').stage,0);
 assert.equal(b.last('race-progress').reached.length,1);
 b.receive({type:'state',state:{p:[start.x,.6,start.z],y:0,s:2,st:0,b:false}});
 assert.equal(a.last('race-progress').stage,1);
 assert.equal(a.last('race-progress').reached.length,0);
 assert.equal(h.m.rooms.get(code).race.stage,1);
});
test('snapshots reject NaN, infinity and implausible teleports',()=>{
 const h=harness(),{a,code}=enterRoom(h);
 const b=h.make();b.receive({type:'join-room',code});
 a.receive({type:'state',state:{p:[1,0,1],y:0}});
 assert.equal(a.last('error'),undefined);
 h.advance(60);
 a.receive({type:'state',state:{p:[100,0,100],y:0}});
 assert.equal(a.last('error').code,'invalid_state');
 h.advance(60);
 a.receive({type:'state',state:{p:[null,0,0],y:0}});
 assert.equal(a.last('error').code,'invalid_state');
});

test('convoy finishes only after every car visits all four gates in order',()=>{
 const h=harness(),first=enterRoom(h);
 const b=h.make();b.receive({type:'join-room',code:first.code});
 first.a.receive({type:'start-race'});
 const targets=h.m.constants.CHECKPOINTS;
 for(let stage=0;stage<targets.length;stage++){
   h.advance(2000);
   const p=targets[stage],state={p:[p.x,.6,p.z],y:0,s:6,st:0,b:false};
   first.a.receive({type:'state',state});
   assert.equal(h.m.rooms.get(first.code).race.stage,stage);
   b.receive({type:'state',state});
   if(stage<targets.length-1)
     assert.equal(h.m.rooms.get(first.code).race.stage,stage+1);
 }
 assert.equal(h.m.rooms.get(first.code).race,null);
 assert.equal(b.last('race-finish').players,2);
 assert.ok(b.last('race-finish').duration>=6);
});
test('departing a convoy cancels shared stage rather than awarding false victory',()=>{
 const h=harness(),first=enterRoom(h);
 const b=h.make();b.receive({type:'join-room',code:first.code});
 first.a.receive({type:'start-race'});
 b.receive({type:'leave-room'});
 assert.equal(h.m.rooms.get(first.code).race,null);
 assert.equal(first.a.last('race-cancel').type,'race-cancel');
});
