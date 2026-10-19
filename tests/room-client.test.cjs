const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../src/room-client.js'),'utf8');
const {createRoomConnection}=new Function(source.replace(/^export /gm,'')+
  '\nreturn {createRoomConnection};')();
class Socket {
  static instances=[];
  constructor(url){this.url=url;this.readyState=1;this.sent=[];
    Socket.instances.push(this);}
  send(text){this.sent.push(JSON.parse(text));}
  close(){this.readyState=3;this.onclose?.();}
  receive(data){this.onmessage?.({data:JSON.stringify(data)});}
}
const origin={protocol:'http:',search:'',href:'http://localhost:3000/'};
function make(){
  Socket.instances.length=0;
  const notes=[],rooms=[],store=new Map();
  const session={getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)};
  const client=createRoomConnection({location:origin,WebSocketImpl:Socket,session,
    onEvent:e=>notes.push(e),onRoom:r=>rooms.push(r)});
  return {client,notes,rooms,store};
}
test('transport does not connect before the user chooses a room',()=>{
  const x=make();assert.equal(Socket.instances.length,0);
  x.client.create('Jane');
  assert.equal(Socket.instances.length,1);
  const ws=Socket.instances[0];
  assert.equal(ws.url,'ws://localhost:3000/ws');
  ws.receive({type:'welcome',id:'a',token:'safe-token',resumed:false});
  assert.equal(ws.sent[0].type,'name');
  assert.equal(ws.sent[1].type,'create-room');
  assert.equal(ws.sent[0].name,'Jane');
});
test('client joins by code and sends room state only while connected',()=>{
  const x=make();
  x.client.join('abc234','Sam');
  const ws=Socket.instances[0];
  ws.receive({type:'welcome',id:'a',token:'token1',resumed:false});
  assert.deepEqual(ws.sent[1],{type:'join-room',code:'ABC234'});
  ws.receive({type:'room',code:'ABC234',host:'a',members:[{id:'a',connected:true}],race:null});
  assert.equal(x.client.getState().status,'in-room');
  assert.equal(x.client.sendState({p:[1,0,2],y:0}),true);
  assert.equal(ws.sent.at(-1).type,'state');
  x.client.leave();
  assert.equal(ws.sent.at(-1).type,'leave-room');
  ws.receive({type:'left'});
  assert.equal(x.client.getState().status,'offline');
  assert.equal(x.rooms.at(-1),null);
});
test('invalid code and unsafe endpoint never open a socket',()=>{
  const x=make();
  x.client.join('broken');
  assert.equal(Socket.instances.length,0);
  assert.equal(x.notes.at(-1).type,'error');
  assert.equal(x.client.setServer('ftp://example.com'),false);
  assert.equal(x.client.setServer('https://room.example'),true);
  x.client.create('Driver');
  assert.equal(Socket.instances[0].url,'wss://room.example/ws');
});
