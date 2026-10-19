// Explicitly opt-in multiplayer transport. No passive cross-site auto-connect.
// Protocol v2: session welcome -> create/join -> room-scoped peer traffic.
export function createRoomConnection({
  location=globalThis.location,
  WebSocketImpl=globalThis.WebSocket,
  session=globalThis.sessionStorage,
  onRoom=()=>{},onStatus=()=>{},onEvent=()=>{}
}={}) {
  const key="tiny-motor-club:room-session";
  const read=()=>{try{return JSON.parse(session?.getItem(key)||"null");}catch(_){return null;}};
  const save=value=>{try{session?.setItem(key,JSON.stringify(value));}catch(_){}};
  const clear=()=>{try{session?.removeItem(key);}catch(_){}};
  let socket=null,id=null,token=read()?.token||null;
  let room=null,status="offline",pending=null,desired=false;
  let reconnectTimer=null,retry=0,lastSend=-Infinity,sequence=0,
    connectionEpoch=0,resuming=false;
  let nickname="Водитель";
  let serverOverride=new URLSearchParams(location.search||"").get("server")||"";
  const getState=()=>({id,room,status,desired,nickname});
  const notify=()=>onStatus(getState());
  function emit(message){onEvent(message);}
  function setStatus(s){status=s;notify();}
  function url() {
    // Full URL or hostname. Explicit override required for cross-origin server.
    let origin;
    try {
      origin=serverOverride?new URL(serverOverride.includes("://")?serverOverride:
        location.protocol+"//"+serverOverride):new URL(location.href);
    } catch(_){origin=new URL(location.href);}
    const scheme=origin.protocol==="https:"?"wss:":"ws:";
    return scheme+"//"+origin.host+"/ws";
  }
  function send(value){
    if(!socket||socket.readyState!==1)return false;
    socket.send(JSON.stringify(value));return true;
  }
  function flush(){
    if(!pending)return;
    const command=pending;pending=null;
    send({type:"name",name:nickname});
    send(command);
  }
  function schedule(){
    if(!desired||reconnectTimer)return;
    const delay=Math.min(10000,750*Math.pow(1.65,retry++));
    reconnectTimer=setTimeout(()=>{
      reconnectTimer=null;connect(true);
    },delay);
  }
  function disconnect({keepRoom=false}={}){
    if(reconnectTimer){clearTimeout(reconnectTimer);reconnectTimer=null;}
    desired=false;connectionEpoch++;
    const old=socket;socket=null;
    if(old){old.onopen=old.onmessage=old.onclose=old.onerror=null;old.close();}
    if(!keepRoom){room=null;id=null;token=null;clear();onRoom(null);}
    setStatus("offline");
  }
  function connect(reconnecting=false){
    if(!WebSocketImpl){
      setStatus("unavailable");
      emit({type:"error",message:"WebSocket недоступен в этом браузере"});
      return;
    }
    const epoch=++connectionEpoch;
    if(socket){socket.onopen=socket.onmessage=socket.onclose=socket.onerror=null;socket.close();}
    socket=new WebSocketImpl(url());
    resuming=false;
    setStatus(reconnecting?"reconnecting":"connecting");
    const ws=socket;
    ws.onopen=()=>{if(epoch!==connectionEpoch)return;retry=0;};
    ws.onmessage=({data})=>{
      if(epoch!==connectionEpoch)return;
      let msg;
      try{msg=JSON.parse(data);}catch(_){return;}
      if(msg.type==="welcome"){
        id=msg.id;
        if(msg.resumed){
          token=msg.token;
          resuming=false;
          save({token,roomCode:room?.code||read()?.roomCode||null,nickname});
          setStatus("online");
          send({type:"name",name:nickname});
          if(pending?.type==="join-room"&&pending.code===room?.code)pending=null;
          flush();
        }else if(reconnecting&&token&&!resuming){
          resuming=true;
          send({type:"resume",token});
        }else{
          token=msg.token;save({token,roomCode:null,nickname});
          setStatus("online");flush();
        }
      }else if(msg.type==="resume-failed"){
        resuming=false;token=null;clear();
        setStatus("online");
        if(!pending&&room?.code)pending={type:"join-room",code:room.code};
        flush();
      }else if(msg.type==="room"){
        room=msg;
        save({token,roomCode:msg.code,nickname});
        setStatus("in-room");
        onRoom(msg);
      }else if(msg.type==="left"){
        room=null;clear();
        token=null;
        onRoom(null);
        disconnect();
      }else if(msg.type==="error"){
        emit(msg);
      }else{
        if(msg.type==="peer-left" || msg.type==="peer-joined" ||
          msg.type==="peer-offline") {
          // Server follows with canonical room roster; do not infer members.
        }
        emit(msg);
      }
    };
    ws.onerror=()=>{if(epoch===connectionEpoch)setStatus("connection-error");};
    ws.onclose=()=>{
      if(epoch!==connectionEpoch)return;
      socket=null;
      if(desired){
        setStatus("reconnecting");
        schedule();
      }else setStatus("offline");
    };
  }
  function go(command,name="Водитель"){
    nickname=String(name||"Водитель").trim().slice(0,18)||"Водитель";
    desired=true;
    pending=command;
    if(socket&&socket.readyState===1){
      flush();return;
    }
    connect(false);
  }
  function setServer(value){
    const raw=String(value||"").trim();
    if(!raw){serverOverride="";return true;}
    try{
      const parsed=new URL(raw.includes("://")?raw:location.protocol+"//"+raw);
      const local=["localhost","127.0.0.1"].includes(parsed.hostname);
      if(!["https:","http:"].includes(parsed.protocol) ||
         (location.protocol==="https:"&&parsed.protocol!=="https:"&&!local) ||
         parsed.username || parsed.password || !parsed.host)throw Error();
      serverOverride=parsed.origin;return true;
    }catch(_){
      emit({type:"error",message:"Укажите адрес HTTPS-сервера, например https://car.example"});
      return false;
    }
  }
  function create(name){go({type:"create-room"},name);}
  function join(code,name){
    const cleaned=String(code||"").trim().toUpperCase();
    if(!/^[A-HJ-NP-Z2-9]{6}$/.test(cleaned)){
      emit({type:"error",message:"Код комнаты: 6 символов без O, 0, I и 1"});
      return;
    }
    go({type:"join-room",code:cleaned},name);
  }
  function leave(){
    desired=false;
    if(reconnectTimer){clearTimeout(reconnectTimer);reconnectTimer=null;}
    if(socket?.readyState===1 && room){
      send({type:"leave-room"});
      setStatus("leaving");
    }else disconnect();
  }
  function startRace(){return send({type:"start-race"});}
  function sendInput(x,y){
    if(!room||status!=="in-room")return false;
    const t=performance.now();
    if(t-lastSend<48)return false;
    lastSend=t;
    return send({type:"input",input:{
      x:Math.max(-1,Math.min(1,Number(x)||0)),
      y:Math.max(-1,Math.min(1,Number(y)||0)),
      seq:++sequence}});
  }
  // Kept for compatibility with older optional room servers; production
  // authority never accepts positional states supplied by browsers.
  function sendState(state){
    if(!room||status!=="in-room")return false;
    const t=performance.now();
    if(t-lastSend<50)return false;
    lastSend=t;return send({type:"state",state});
  }
  return {create,join,leave,disconnect,startRace,sendInput,sendState,
    getState,send,url,setServer};
}
