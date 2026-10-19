const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const RAPIER=require('@dimforge/rapier3d-compat');
const {createAuthoritativeWorld}=require('../multiplayer/authoritative-world.cjs');
const {createRoomManager}=require('../multiplayer/rooms.cjs');
class Peer extends EventEmitter{
 constructor(){super();this.readyState=1;this.messages=[];}
 send(raw){this.messages.push(JSON.parse(raw));}
 receive(value){this.emit('message',Buffer.from(JSON.stringify(value)));}
 last(type){return this.messages.filter(x=>x.type===type).at(-1);}
 close(){this.readyState=3;this.emit('close');}
}
test('one authoritative simulation drives two clients, ignores position spoof, owns shared cargo',async()=>{
 await RAPIER.init();
 let time=100000;
 const manager=createRoomManager({
   now:()=>time,
   codeFactory:()=> 'ABC234',
   physicsFactory:()=>createAuthoritativeWorld({now:()=>time})
 });
 const host=new Peer();manager.connect(host);
 host.receive({type:'create-room'});
 assert.equal(host.last('room').authoritative,true);
 const guest=new Peer();manager.connect(guest);
 guest.receive({type:'join-room',code:'ABC234'});
 const id=host.last('welcome').id;
 const room=manager.rooms.get('ABC234');
 assert.equal(room.physics.cars.size,2);
 const start=room.physics.position(id);
 host.receive({type:'state',state:{p:[100,.7,100],y:0,s:40}});
 assert.equal(room.physics.position(id).x,start.x);
 for(let i=0;i<130;i++){
   time+=17;
   if(i%3===0)host.receive({type:'input',input:{x:0,y:1,seq:i+1}});
   manager.advance();
 }
 const position=room.physics.position(id);
 assert.ok(position.z>start.z+1.8,
   'server must move driver from input, not from supplied position: '+position.z);
 const frame=guest.last('physics');
 assert.equal(frame.players.length,2);
 assert.equal(frame.props.length,3);
 assert.ok(frame.players.find(p=>p.id===id)?.q.length===4);
 assert.equal(frame.tick%3,0);
 host.receive({type:'start-race'});
 const race=room.race;
 assert.ok(race,'host starts real co-op stage');
 guest.receive({type:'leave-room'});
 assert.equal(room.race,null,'departing peer cancels convoy');
 assert.equal(room.physics.cars.size,1,'leaving car body freed');
 host.receive({type:'leave-room'});
 assert.equal(manager.rooms.size,0,'empty room and physics world disposed');
});
