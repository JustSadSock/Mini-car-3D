const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const RAPIER=require("@dimforge/rapier3d-compat");
const THREE=require("three");
const source=fs.readFileSync(path.join(__dirname,"../src/vehicle-physics.js"),"utf8");
const api=new Function(source.replace(/^export /gm,"")+
  "\nreturn {normalizeWheels,createVehicleDynamics};")();

function setup(x=0,z=0) {
  const world=new RAPIER.World({x:0,y:-12.8,z:0});
  const floor=world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(RAPIER.ColliderDesc.cuboid(110,.1,110)
    .setTranslation(0,-.05,0).setFriction(.28),floor);
  const body=world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(x,.44,z).setCanSleep(false)
    .setLinearDamping(.24).setAngularDamping(1.25));
  body.setGravityScale(1.2,true);
  const collider=world.createCollider(RAPIER.ColliderDesc.cuboid(.65,.3,1)
    .setFriction(.18).setDensity(.72),body);
  const points=api.normalizeWheels([],.5,.75,-.13);
  const vehicle=api.createVehicleDynamics({
    RAPIER,THREE,world,body,collider,wheelRadius:.25,wheelPoints:points
  });
  return {world,body,vehicle};
}
function simulate(state,seconds,throttle=0,steer=0) {
  const frames=Math.round(seconds*60);
  let report;
  for(let i=0;i<frames;i++){
    report=state.vehicle.step(1/60,steer,throttle);
    state.world.step();
  }
  return report;
}
test("real Rapier suspension settles and supports chassis without falling through",async()=>{
  await RAPIER.init();
  const state=setup();
  const telemetry=simulate(state,2.5);
  assert.ok(telemetry.contacts>=2,"wheels have stable support: "+telemetry.contacts);
  const y=state.body.translation().y;
  assert.ok(y>.29 && y<1.3,"chassis should rest on springs, y="+y);
  state.world.free();
});
test("real Rapier: forward throttle only moves while tires touch ground",async()=>{
  await RAPIER.init();
  const supported=setup();
  simulate(supported,1.2);
  simulate(supported,1.0,1,0);
  assert.ok(supported.body.translation().z>1.2,"throttle must move the car forward");
  supported.world.free();

  const airborne=setup();
  airborne.body.setTranslation({x:0,y:7,z:0},true);
  simulate(airborne,.1,1,1);
  const p=airborne.body.translation();
  assert.ok(Math.abs(p.z)<.03 && Math.abs(p.x)<.03,
    "airborne throttle and steering must not accelerate the chassis");
  airborne.world.free();
});
test("real Rapier: ice has measurably less acceleration than asphalt",async()=>{
  await RAPIER.init();
  const asphalt=setup(0,0);
  const ice=setup(-28,17);
  simulate(asphalt,.5);
  simulate(ice,.5);
  simulate(asphalt,.38,1);
  simulate(ice,.38,1);
  const speedA=asphalt.body.linvel().z;
  const speedI=ice.body.linvel().z;
  assert.ok(speedA>speedI+.4,
    "asphalt="+speedA+" ice="+speedI);
  asphalt.world.free();
  ice.world.free();
});
