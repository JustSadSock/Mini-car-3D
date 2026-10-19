const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const THREE=require('three');
const RAPIER=require('@dimforge/rapier3d-compat');
const source=fs.readFileSync(path.join(__dirname,'../src/online-visuals.js'),'utf8');
const createOnlineWorldView=new Function(source.replace(/^export /gm,'')+
  '\nreturn createOnlineWorldView;')();

test('network mode swaps rigid-body authority and displays real shared crate snapshots',async()=>{
  await RAPIER.init();
  const world=new RAPIER.World({x:0,y:-12.8,z:0});
  const body=world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0,.8,0));
  world.createCollider(RAPIER.ColliderDesc.cuboid(.65,.3,1),body);
  const scene=new THREE.Scene(),car=new THREE.Group();
  const view=createOnlineWorldView(THREE,RAPIER,scene,{getBody:()=>body,getCar:()=>car});
  view.enabled(true);
  assert.equal(body.bodyType(),RAPIER.RigidBodyType.KinematicPositionBased);
  view.snapshot({type:'physics',tick:3,
    players:[{id:'self',p:[5,.8,8],q:[0,0,0,1],v:[0,0,4],ack:17}],
    props:[{id:'cargo-a',p:[2,.65,5],q:[0,0,0,1]}]},'self');
  assert.equal(view.cargoCount,1);
  const first=body.translation().z;
  view.step();world.step();
  assert.ok(body.translation().z>first,'authoritative correction moves local view');
  assert.ok(Number.isFinite(car.userData.lastSpeed));
  view.snapshot({type:'physics',tick:2,
    players:[{id:'self',p:[99,.8,99],q:[0,0,0,1],v:[0,0,0]}],
    props:[]},'self');
  assert.equal(view.lastTick,3,'stale snapshots rejected');
  view.enabled(false);
  assert.equal(view.cargoCount,0);
  assert.equal(body.bodyType(),RAPIER.RigidBodyType.Dynamic);
  world.free();
});
