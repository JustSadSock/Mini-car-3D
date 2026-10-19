const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const source=fs.readFileSync(path.join(__dirname,"../src/modes.js"),"utf8");
const {createModeEngine,MODE_CONFIG,medalFor,COURIER_STOPS,PARKING_SPOTS,STUNT_RAMPS}=
 new Function(source.replace(/^export /gm,"")+
 "\nreturn {createModeEngine,MODE_CONFIG,medalFor,COURIER_STOPS,PARKING_SPOTS,STUNT_RAMPS};")();
function storage(){
 const map=new Map();
 return {getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,v),map};
}
const sample=(x,z,o={})=>({position:{x,y:.6,z},speed:1.1,grounded:true,yaw:0,...o});
function wait(e,s,t=1.4){for(let a=0;a<t;a+=.05)e.update(.05,s)}
test("four independent modes with explicit starting positions and record semantics",()=>{
 const s=storage(),e=createModeEngine({storage:s});
 for(const id of ["courier","parking","stunt","slalom"]){
   const position=e.select(id);
   assert.equal(typeof position.x,"number");
   assert.equal(e.getState().id,id);
   assert.equal(e.getState().completed,false);
 }
 assert.equal(medalFor("courier",40),"gold");
 assert.equal(medalFor("stunt",1.8),"gold");
 assert.equal(medalFor("stunt",.2),"finish");
});
test("courier requires a full stationary loading stop and two completed deliveries",()=>{
 const e=createModeEngine({storage:storage()});
 e.select("courier");
 const stops=COURIER_STOPS;
 // Driving through the pad at speed must never auto-load.
 wait(e,sample(stops[0].x,stops[0].z,{speed:12}),2);
 assert.equal(e.getState().carrying,false);
 for(let i=0;i<4;i++){
   wait(e,sample(stops[i].x,stops[i].z),1.4);
   assert.equal(e.getState().step,i+1);
 }
 assert.equal(e.getState().completed,true);
 assert.equal(e.getState().record.value>0,true);
});
test("a damaged courier loses cargo and must reload",()=>{
 const e=createModeEngine();
 e.select("courier");
 wait(e,sample(COURIER_STOPS[0].x,COURIER_STOPS[0].z),1.4);
 assert.equal(e.getState().carrying,true);
 for(let i=0;i<3;i++)e.impact(2.5);
 assert.equal(e.getState().carrying,false);
 assert.equal(e.getState().step,0);
 assert.equal(e.getState().penalties,15);
});
test("parking needs correct angle, brake and dwell time in three separate bays",()=>{
 const e=createModeEngine();
 e.select("parking");
 const spot=PARKING_SPOTS[0];
 wait(e,sample(spot.x,spot.z,{yaw:Math.PI/2}),2.5);
 assert.equal(e.getState().step,0);
 wait(e,sample(spot.x,spot.z,{yaw:0,speed:5}),2.5);
 assert.equal(e.getState().step,0);
 for(let i=0;i<PARKING_SPOTS.length;i++){
   const p=PARKING_SPOTS[i];
   // Moving along the bay starts the timer, then parking requires low speed.
   wait(e,sample(p.x,p.z,{yaw:p.yaw,speed:.3}),1.85);
   assert.equal(e.getState().step,i+1);
 }
 assert.equal(e.getState().completed,true);
});
test("stunt requires proper takeoff and landed airtime close to real ramps",()=>{
 const e=createModeEngine();
 e.select("stunt");
 const p=STUNT_RAMPS[0];
 e.update(.05,sample(p.x,p.z,{grounded:true,speed:12}));
 // Deliberately wrong ramp position cannot qualify.
 e.update(.05,sample(0,0,{grounded:false,speed:13}));
 e.update(.05,sample(0,4,{grounded:true,speed:9}));
 assert.equal(e.getState().step,0);
 e.update(.05,sample(p.x,p.z,{grounded:true,speed:12}));
 for(let i=0;i<15;i++)e.update(.05,sample(p.x,p.z+i*.5,{grounded:false,speed:12}));
 e.update(.05,sample(p.x,p.z+9,{grounded:true,speed:12}));
 assert.equal(e.getState().step,1);
 assert.ok(e.consumeEvents().some(x=>x.type==="next-ramp"));
 const p2=STUNT_RAMPS[1];
 e.update(.05,sample(p2.x,p2.z,{grounded:true,speed:12}));
 for(let i=0;i<16;i++)e.update(.05,sample(p2.x,p2.z+i*.6,{grounded:false,speed:12}));
 e.update(.05,sample(p2.x,p2.z+10,{grounded:true,speed:12}));
 assert.equal(e.getState().completed,true);
 assert.ok(e.getState().record.value>1);
});
test("slalom completion sends real result, keeps personal best and survives storage denial",()=>{
 const store=storage();const e=createModeEngine({storage:store});
 e.select("slalom");
 e.registerSlalom(37.2);
 assert.equal(e.getState().record.medal,"silver");
 const again=createModeEngine({storage:store});
 assert.equal(again.getRecords().slalom.value,37.2);
 again.select("slalom");
 again.registerSlalom(52.1);
 assert.equal(again.getState().record.value,37.2);
 const denied=createModeEngine({storage:{getItem(){throw Error("disabled")},setItem(){throw Error("disabled")}}});
 denied.select("slalom");denied.registerSlalom(29.8);
 assert.equal(denied.getState().record.medal,"gold");
});
