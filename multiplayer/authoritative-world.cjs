'use strict';
const RAPIER=require('@dimforge/rapier3d-compat');
const THREE=require('three');

const STEP=1/60;
const BROADCAST_EVERY=3;
const SPEED_LIMIT=19;
const BOXES=Object.freeze([
  {id:'cargo-a',p:[5,.65,8],half:[.72,.65,.72],color:0xcc9e6e},
  {id:'cargo-b',p:[7,.65,8.5],half:[.72,.65,.72],color:0xc78654},
  {id:'cargo-c',p:[6,.65,11],half:[.72,.65,.72],color:0x768f9b}
]);
const FINITE=(x)=>Number.isFinite(x)?x:0;
function safeInput(input) {
  if(!input||typeof input!=='object'||
    !Number.isFinite(input.x)||!Number.isFinite(input.y)||
    !Number.isSafeInteger(input.seq)||input.seq<0)return null;
  if(Math.abs(input.x)>1.01||Math.abs(input.y)>1.01)return null;
  return {x:Math.max(-1,Math.min(1,input.x)),y:Math.max(-1,Math.min(1,input.y)),seq:input.seq};
}
function createAuthoritativeWorld({now=Date.now}={}) {
  // RAPIER.init() must have completed before constructing worlds.
  const world=new RAPIER.World({x:0,y:-12.8});
  world.timestep=STEP;
  const floor=world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(RAPIER.ColliderDesc.cuboid(110,.10,110)
    .setTranslation(0,-.10,0).setFriction(.7).setRestitution(.04),floor);
  for(const side of [-1,1]){
    const wall=world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    world.createCollider(RAPIER.ColliderDesc.cuboid(.75,2.3,110)
      .setTranslation(side*109,1.5,0),wall);
    world.createCollider(RAPIER.ColliderDesc.cuboid(110,2.3,.75)
      .setTranslation(0,1.5,side*109),wall);
  }
  for(const ramp of [{x:-45,z:-39,angle:-.18},{x:46,z:38,angle:-.24}]){
    const q=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),ramp.angle);
    const width=7.4,depth=11,thickness=.5;
    const y=depth/2*Math.sin(-ramp.angle)-thickness/2*Math.cos(ramp.angle);
    const rb=world.createRigidBody(RAPIER.RigidBodyDesc.fixed()
      .setTranslation(ramp.x,y,ramp.z).setRotation({x:q.x,y:q.y,z:q.z,w:q.w}));
    world.createCollider(RAPIER.ColliderDesc.cuboid(width/2,thickness/2,depth/2)
      .setFriction(.65),rb);
  }
  const props=new Map(),cars=new Map();
  for(const item of BOXES){
    const rb=world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(...item.p).setLinearDamping(.9).setAngularDamping(1.25));
    world.createCollider(RAPIER.ColliderDesc.cuboid(...item.half)
      .setDensity(.4).setFriction(.8).setRestitution(.08),rb);
    props.set(item.id,{body:rb,...item});
  }
  let frame=0,closed=false;
  function spawnPosition(index=0){
    return {x:-3+(index%4)*2.15,y:.85,z:-6};
  }
  const v=(p)=>new THREE.Vector3(p.x,p.y,p.z);
  const obj=(p)=>({x:p.x,y:p.y,z:p.z});
  function addPlayer(id,slot){
    if(closed||cars.has(id))return;
    const pos=spawnPosition(slot);
    const body=world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(pos.x,pos.y,pos.z).setCanSleep(false)
      .setLinearDamping(.24).setAngularDamping(1.35));
    body.setGravityScale(1.2,true);
    const collider=world.createCollider(RAPIER.ColliderDesc.cuboid(.7,.3,1.05)
      .setDensity(.72).setFriction(.18).setRestitution(.07),body);
    body.enableCcd(true);
    const mass=body.mass();
    cars.set(id,{body,collider,mass,command:{x:0,y:0,seq:0},lastInputAt:0,
      lastSequence:-1,applied:-1,steer:0,throttle:0});
  }
  function removePlayer(id){
    const car=cars.get(id);
    if(!car)return;
    world.removeRigidBody(car.body);cars.delete(id);
  }
  function input(id,value){
    const car=cars.get(id),command=safeInput(value);
    if(!car||!command||command.seq<=car.lastSequence)return false;
    car.command=command;
    car.lastSequence=command.seq;
    car.lastInputAt=now();
    return true;
  }
  function recover(id){
    const car=cars.get(id);
    if(!car)return false;
    const p=car.body.translation(),q=car.body.rotation();
    const f=new THREE.Vector3(0,0,1).applyQuaternion(new THREE.Quaternion(q.x,q.y,q.z,q.w));
    const angle=Math.atan2(f.x,f.z);
    const yaw=Number.isFinite(angle)?angle:0;
    const quaternion=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),yaw);
    const bad=p.y<-6||Math.abs(p.x)>105||Math.abs(p.z)>105;
    const spawn=bad?spawnPosition(0):{x:p.x,y:Math.max(1.15,p.y+1.2),z:p.z};
    car.body.setTranslation(spawn,true);
    car.body.setRotation(quaternion,true);
    car.body.setLinvel({x:0,y:0,z:0},true);
    car.body.setAngvel({x:0,y:0,z:0},true);
    return true;
  }
  function resetAll(){
    let index=0;
    for(const [id,car] of cars){
      const pos=spawnPosition(index++);
      car.body.setTranslation(pos,true);
      car.body.setRotation({x:0,y:0,z:0,w:1},true);
      car.body.setLinvel({x:0,y:0,z:0},true);
      car.body.setAngvel({x:0,y:0,z:0},true);
      car.command={x:0,y:0,seq:car.lastSequence+1};
      car.lastInputAt=0;
    }
  }
  function drive(car,dt){
    const rb=car.body;
    const fresh=car.lastInputAt>0&&now()-car.lastInputAt<=350;
    const x=fresh?car.command.x:0,y=fresh?car.command.y:0;
    car.steer+=(x-car.steer)*Math.min(1,dt*7);
    car.throttle+=(y-car.throttle)*Math.min(1,dt*7);
    car.applied=car.command.seq;
    const rot=rb.rotation();
    const q=new THREE.Quaternion(rot.x,rot.y,rot.z,rot.w);
    const up=new THREE.Vector3(0,1,0).applyQuaternion(q);
    const forward=new THREE.Vector3(0,0,1).applyQuaternion(q);
    forward.y=0;if(forward.lengthSq()<.05)forward.set(0,0,1);
    forward.normalize();
    const center=v(rb.translation()),linear=v(rb.linvel()),angular=v(rb.angvel());
    const speed=linear.dot(forward);
    const ang=car.steer*.43*(1-.3*Math.min(1,Math.abs(speed)/SPEED_LIMIT));
    const front=forward.clone().applyAxisAngle(new THREE.Vector3(0,1,0),ang);
    const right=(d)=>new THREE.Vector3(d.z,0,-d.x);
    const quarter=car.mass/4,weight=car.mass*12.8*1.2;
    const spring=weight/(4*.12);
    const damp=2*Math.sqrt(spring*quarter)*.77;
    let contacts=0;
    for(const [x,z,isFront] of [[-.55, .82,true],[.55,.82,true],
                                 [-.55,-.82,false],[.55,-.82,false]]){
      const attach=new THREE.Vector3(x,.1,z).applyQuaternion(q).add(center);
      const dir=up.clone().negate().normalize();
      const hit=world.castRayAndGetNormal(
        new RAPIER.Ray(obj(attach),obj(dir)),.97,true,
        undefined,undefined,car.collider,rb);
      const toi=hit?.toi??hit?.timeOfImpact;
      if(!Number.isFinite(toi)||!hit.normal||hit.normal.y<.5||up.y<.35)continue;
      const compression=Math.max(0,Math.min(.32,.69-toi));
      if(compression<=0)continue;
      const location=attach.clone().addScaledVector(dir,toi);
      const velocity=linear.clone().add(angular.clone().cross(location.clone().sub(center)));
      const support=Math.max(0,spring*compression-damp*velocity.dot(up));
      if(support<=0)continue;
      contacts++;
      rb.applyImpulseAtPoint(obj(up.clone().multiplyScalar(support*dt)),obj(attach),true);
      const dirForward=isFront?front:forward;
      const dirRight=right(dirForward);
      const lateral=-velocity.dot(dirRight)*quarter*.9;
      const grip=1.12;
      const cap=support*grip*dt;
      rb.applyImpulseAtPoint(obj(dirRight.multiplyScalar(
        Math.max(-cap,Math.min(cap,lateral)))),obj(location),true);
      let accel=car.throttle>=0?12.5:7;
      if(speed*car.throttle<-.5)accel=19;
      let thrust=car.mass*accel*car.throttle*dt/4;
      if(Math.abs(speed)>(speed>=0?18.5:8.5)&&Math.sign(speed)===Math.sign(car.throttle)){
        thrust=0;
      }
      rb.applyImpulseAtPoint(obj(dirForward.multiplyScalar(
        Math.max(-cap,Math.min(cap,thrust)))),obj(location),true);
    }
    if(contacts>=2){
      const force=Math.min(car.mass*7,car.mass*.019*speed*speed);
      rb.applyImpulse({x:0,y:-force*dt,z:0},true);
    }
    car.grounded=contacts>=2;
  }
  function step(){
    if(closed)return;
    for(const car of cars.values())drive(car,STEP);
    world.step();frame++;
    for(const [id,car] of cars){
      const p=car.body.translation();
      if(p.y<-9||Math.abs(p.x)>115||Math.abs(p.z)>115)recover(id);
    }
  }
  const snapshotBody=(body)=>{
    const p=body.translation(),q=body.rotation(),v=body.linvel();
    return {p:[FINITE(p.x),FINITE(p.y),FINITE(p.z)],
      q:[FINITE(q.x),FINITE(q.y),FINITE(q.z),FINITE(q.w)],
      v:[FINITE(v.x),FINITE(v.y),FINITE(v.z)]};
  };
  function snapshot(){
    return {type:'physics',tick:frame,serverTime:now(),
      players:[...cars].map(([id,car])=>{
        const b=snapshotBody(car.body),rot=car.body.rotation();
        const forward=new THREE.Vector3(0,0,1).applyQuaternion(
          new THREE.Quaternion(rot.x,rot.y,rot.z,rot.w));
        return {id,...b,s:car.body.linvel().z,st:car.steer,
          b:car.throttle<-.2,ack:car.applied};
      }),
      props:[...props].map(([id,prop])=>({id,...snapshotBody(prop.body)}))};
  }
  function position(id){
    const car=cars.get(id);return car?car.body.translation():null;
  }
  function dispose(){
    if(closed)return;closed=true;
    cars.clear();props.clear();world.free();
  }
  return {addPlayer,removePlayer,input,recover,resetAll,step,snapshot,position,
    dispose,cars,props,constants:{STEP,BROADCAST_EVERY,BOXES}};
}
module.exports={createAuthoritativeWorld,safeInput,BOXES,STEP,BROADCAST_EVERY};
