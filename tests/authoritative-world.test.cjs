const test=require('node:test');
const assert=require('node:assert/strict');
const RAPIER=require('@dimforge/rapier3d-compat');
const {createAuthoritativeWorld,safeInput,BOXES}=require('../multiplayer/authoritative-world.cjs');

test('server accepts only finite, bounded and sequenced driver commands',()=>{
  assert.deepEqual(safeInput({x:.5,y:1,seq:0}),{x:.5,y:1,seq:0});
  for(const cmd of [{x:2,y:0,seq:1},{x:0,y:NaN,seq:1},
    {x:0,y:0,seq:-1},{x:0,y:0,seq:1.2},{x:0,y:0}]){
    assert.equal(safeInput(cmd),null);
  }
});

test('real room owns dynamic Rapier cars and movable cargo with fixed identities',async()=>{
  await RAPIER.init();
  const room=createAuthoritativeWorld();
  room.addPlayer('a',0);room.addPlayer('b',1);
  assert.equal(room.cars.size,2);
  assert.equal(room.props.size,3);
  const start=room.snapshot();
  assert.equal(start.players.length,2);
  assert.equal(start.props.length,BOXES.length);
  for(const p of start.props)assert.equal(p.q.length,4);
  for(let i=0;i<90;i++)room.step();
  const settled=room.snapshot();
  assert.ok(settled.players.every(p=>p.p.every(Number.isFinite)),
    'cars should not become NaN');
  assert.ok(settled.props.every(p=>p.p[1]>.3 && p.p[1]<2),
    'physical crates settle on ground');
  room.removePlayer('b');
  assert.equal(room.cars.size,1);
  room.dispose();
});

test('server moves car from input, rejects client-supplied positions',async()=>{
  await RAPIER.init();
  let time=100000;
  const room=createAuthoritativeWorld({now:()=>time});
  room.addPlayer('a',0);
  for(let i=0;i<40;i++){time+=17;room.step();}
  const before=room.position('a');
  const initial={x:before.x,z:before.z};
  for(let i=0;i<150;i++){
    if(i%3===0)assert.equal(room.input('a',{x:0,y:1,seq:i+1}),true);
    time+=17;room.step();
  }
  const after=room.position('a');
  assert.ok(after.z>initial.z+2,
    'server-authoritative throttle advances +Z; displacement '+(after.z-initial.z));
  assert.equal(room.input('a',{x:0,y:1,seq:1}),false,'replayed input must fail');
  room.dispose();
});

test('two cars collide as dynamic bodies rather than intersecting ghosts',async()=>{
  await RAPIER.init();
  const room=createAuthoritativeWorld();
  room.addPlayer('a',0);room.addPlayer('b',1);
  const a=room.cars.get('a').body,b=room.cars.get('b').body;
  a.setTranslation({x:0,y:.75,z:0},true);
  b.setTranslation({x:0,y:.75,z:2.3},true);
  a.setLinvel({x:0,y:0,z:8},true);
  b.setLinvel({x:0,y:0,z:0},true);
  for(let i=0;i<75;i++)room.step();
  assert.ok(b.translation().z>2.35,'rammed car should move forward');
  const dx=b.translation().x-a.translation().x,
    dz=b.translation().z-a.translation().z;
  assert.ok(Math.hypot(dx,dz)>.9,'car bodies must not pass through each other');
  room.dispose();
});

test('authored physical cargo takes momentum from the cars',async()=>{
  await RAPIER.init();
  const room=createAuthoritativeWorld();
  room.addPlayer('a',0);
  const car=room.cars.get('a').body,box=room.props.get('cargo-a').body;
  car.setTranslation({x:5,y:.85,z:5.4},true);
  car.setLinvel({x:0,y:0,z:8},true);
  const origin=box.translation().z;
  for(let i=0;i<85;i++)room.step();
  assert.ok(box.translation().z>origin+.3,
    'shared crate receives momentum from physical car');
  room.dispose();
});
