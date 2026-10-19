const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const THREE=require("three");
const RAPIER=require("@dimforge/rapier3d-compat");

function moduleApi(filename, returnNames){
 const source=fs.readFileSync(path.join(__dirname,"../src",filename),"utf8");
 return new Function(source.replace(/^export /gm,"") +
   "\nreturn {"+returnNames.join(",")+"};")();
}
const {createDiorama,pathClearance,TRACK_POINTS,WORLD_LANDMARKS}=moduleApi(
 "diorama.js",["createDiorama","pathClearance","TRACK_POINTS","WORLD_LANDMARKS"]);
const {createRoadFeedback}=moduleApi("road-feedback.js",["createRoadFeedback"]);

test("race ribbon follows all nine slalom checkpoints",()=>{
 assert.equal(TRACK_POINTS.length,9);
 TRACK_POINTS.forEach(([x,z])=>assert.ok(pathClearance(x,z)<.001));
 assert.equal(WORLD_LANDMARKS.length,5);
});

test("diorama uses actual Rapier colliders for all solid scenery",async()=>{
 await RAPIER.init();
 const world=new RAPIER.World({x:0,y:-12.8,z:0});
 const scene=new THREE.Scene();
 const ground=new THREE.Mesh(new THREE.PlaneGeometry(220,220),
   new THREE.MeshStandardMaterial());
 scene.add(ground);
 const collected=[];
 const registerBody=(body,mesh,collider,meta)=>{
   assert.ok(body && collider);
   assert.ok(collider.parent());
   collected.push({body,mesh,collider,meta});
 };
 const diorama=createDiorama({THREE,RAPIER,scene,world,ground,registerBody,lowQuality:true});
 assert.ok(diorama.stats.meshes>70,"scenery should have real geometric detail");
 assert.ok(diorama.stats.physicalProps>=18,"solid scene needs physical colliders");
 assert.ok(scene.children.some(o=>o.name==="Painted race track"));
 assert.ok(scene.children.some(o=>o.name==="Club timing board"));
 assert.ok(collected.some(o=>o.meta.dynamic),"moveable cardboard props exist");
 const solids=collected.filter(o=>o.mesh?.name &&
   !["Painted ground decal (non-solid)"].includes(o.mesh.name));
 assert.ok(solids.length>=18);
 assert.doesNotThrow(()=>{for(let i=0;i<10;i++)world.step();});
 diorama.update(1/60);
 world.free();
});

test("track tyre feedback keeps fixed-sized GPU instance buffers",()=>{
 const scene=new THREE.Scene();
 const effect=createRoadFeedback(THREE,scene,{lowQuality:true});
 assert.equal(effect.capacity,72);
 assert.equal(effect.mesh.count,72);
 assert.equal(scene.children.length,1);
 const car=new THREE.Group();
 car.position.set(0,.5,0);
 effect.update(.1,car,{grounded:true,slip:3,speed:9,surface:"asphalt"});
 assert.equal(effect.mesh.instanceMatrix.needsUpdate,undefined);
 // three.js marks BufferAttributes via version increments.
 assert.ok(effect.mesh.instanceMatrix.version>=2);
 effect.reset();
 assert.ok(effect.mesh.instanceMatrix.version>=3);
});

test("scenery has no invisible static walls across spawn or slalom center",()=>{
 assert.ok(pathClearance(0,14)<.01);
 assert.ok(pathClearance(11,29)<.01);
 assert.ok(pathClearance(33,0)<.01);
 assert.ok(pathClearance(0,0)>4);
});
