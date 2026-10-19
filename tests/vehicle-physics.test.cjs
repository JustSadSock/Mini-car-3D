const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../src/vehicle-physics.js"), "utf8");
const api = new Function(source.replace(/^export /gm, "") +
  "\nreturn {SURFACES,SURFACE_PATCHES,TUNING,surfaceAt,suspensionForce,tractionImpulse,normalizeWheels,createVehicleDynamics};")();

class Vector3 {
  constructor(x=0,y=0,z=0) { Object.assign(this,{x,y,z}); }
  clone() { return new Vector3(this.x,this.y,this.z); }
  set(x,y,z) { Object.assign(this,{x,y,z}); return this; }
  add(v) { this.x+=v.x;this.y+=v.y;this.z+=v.z;return this; }
  sub(v) { this.x-=v.x;this.y-=v.y;this.z-=v.z;return this; }
  multiplyScalar(v) { this.x*=v;this.y*=v;this.z*=v;return this; }
  addScaledVector(v,k) {return this.add(v.clone().multiplyScalar(k));}
  lengthSq() {return this.x*this.x+this.y*this.y+this.z*this.z;}
  length() {return Math.sqrt(this.lengthSq());}
  normalize() {const d=this.length()||1;return this.multiplyScalar(1/d);}
  negate() {return this.multiplyScalar(-1);}
  dot(v) {return this.x*v.x+this.y*v.y+this.z*v.z;}
  cross(v) {const x=this.y*v.z-this.z*v.y,y=this.z*v.x-this.x*v.z,z=this.x*v.y-this.y*v.x;return this.set(x,y,z);}
  applyQuaternion(q) {
    const {x,y,z}=this, {x:qx,y:qy,z:qz,w:qw}=q;
    const ix=qw*x+qy*z-qz*y,iy=qw*y+qz*x-qx*z,iz=qw*z+qx*y-qy*x,iw=-qx*x-qy*y-qz*z;
    return this.set(ix*qw+iw*-qx+iy*-qz-iz*-qy,
      iy*qw+iw*-qy+iz*-qx-ix*-qz,
      iz*qw+iw*-qz+ix*-qy-iy*-qx);
  }
  applyAxisAngle(axis,theta) {
    const s=Math.sin(theta),c=Math.cos(theta), dot=this.dot(axis);
    const cross=axis.clone().cross(this);
    return this.multiplyScalar(c).add(cross.multiplyScalar(s)).addScaledVector(axis,dot*(1-c));
  }
}
class Quaternion {
  constructor(x=0,y=0,z=0,w=1) {Object.assign(this,{x,y,z,w});}
}
class Ray { constructor(origin,dir) {this.origin=origin;this.dir=dir;} }
const RAPIER={Ray};
const THREE={Vector3,Quaternion};

function vehicle(x=0,y=.48,z=0) {
  const p=new Vector3(x,y,z),lin=new Vector3(),ang=new Vector3();
  const applied=[];
  const body={
    mass:()=>10,
    translation:()=>p,
    rotation:()=>({x:0,y:0,z:0,w:1}),
    linvel:()=>lin,
    angvel:()=>ang,
    applyImpulse(impulse){ applied.push(impulse); },
    applyImpulseAtPoint(impulse,point) {applied.push(impulse);},
    applyTorqueImpulse(impulse){applied.push(impulse);}
  };
  const world={
    castRayAndGetNormal(ray,max) {
      if(ray.dir.y >= -0.1)return null;
      const distance=-ray.origin.y/ray.dir.y;
      if(distance<0 || distance>max)return null;
      return {toi:distance,normal:{x:0,y:1,z:0}};
    }
  };
  const wheelPoints=api.normalizeWheels([],0.65,1,-0.25);
  const controller=api.createVehicleDynamics({
    RAPIER,THREE,world,body,collider:{},wheelRadius:.25,wheelPoints
  });
  return {controller,p,lin,ang,applied};
}

test("road patches have actual and distinct tire grip",()=>{
  assert.equal(api.surfaceAt(0,0),"asphalt");
  assert.equal(api.surfaceAt(20,-18),"dirt");
  assert.equal(api.surfaceAt(-28,17),"ice");
  assert.equal(api.surfaceAt(9,34),"rubber");
  assert.ok(api.SURFACES.ice.grip < api.SURFACES.dirt.grip);
  assert.ok(api.SURFACES.dirt.grip < api.SURFACES.asphalt.grip);
  assert.ok(api.SURFACES.asphalt.grip < api.SURFACES.rubber.grip);
});

test("springs resist compression and damp downward velocity",()=>{
  assert.equal(api.suspensionForce(0,0,100,10),0);
  assert.equal(api.suspensionForce(.2,0,100,10),20);
  assert.equal(api.suspensionForce(.2,2,100,10),0);
  assert.equal(api.suspensionForce(.2,-1,100,10),30);
});

test("tire forces cannot exceed Coulomb friction impulse",()=>{
  assert.equal(api.tractionImpulse(10,50,.2,.02),.2);
  assert.equal(api.tractionImpulse(-10,50,.2,.02),-.2);
  assert.equal(api.tractionImpulse(3,0,1,.01),0);
});

test("wheel layout has exactly two front and two rear anchors",()=>{
  const wheels=api.normalizeWheels([],1,2,-.2);
  assert.equal(wheels.length,4);
  assert.equal(wheels.filter(w=>w.front).length,2);
  assert.deepEqual(wheels.map(w=>Math.sign(w.x)),[-1,1,-1,1]);
});

test("supported car gets four rays and upward suspension impulses",()=>{
  const v=vehicle();
  const result=v.controller.step(1/60,0,0);
  assert.equal(result.contacts,4);
  assert.equal(result.grounded,true);
  assert.ok(v.controller.getCompression().every(n=>n>0));
  assert.ok(v.applied.some(v=>v.y>0));
});

test("airborne car has neither engine traction nor tire steering",()=>{
  const v=vehicle(0,3.5,0);
  const result=v.controller.step(1/60,1,1);
  assert.equal(result.contacts,0);
  assert.equal(result.airborne,true);
  assert.equal(v.applied.length,0);
});

test("ice caps forward traction more severely than asphalt",()=>{
  const asphalt=vehicle(0,.48,0);
  const ice=vehicle(-28,.48,17);
  const a=asphalt.controller.step(1/60,0,1);
  const b=ice.controller.step(1/60,0,1);
  const driveSum=v=>v.applied.reduce((sum,imp)=>sum+(imp.z>0?imp.z:0),0);
  assert.ok(a.grounded && b.grounded);
  assert.ok(driveSum(asphalt)>driveSum(ice),
    "Ice must have lower forward acceleration than asphalt");
});
