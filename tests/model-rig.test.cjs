const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");

test("GLB rig matches forward-positive-Z vehicle physics and has real wheel nodes",()=>{
  const file=fs.readFileSync(path.join(__dirname,"../models/NormalCar1.glb"));
  assert.equal(file.toString("ascii",0,4),"glTF");
  const jsonLength=file.readUInt32LE(12);
  assert.equal(file.toString("ascii",16,20),"JSON");
  const gltf=JSON.parse(file.subarray(20,20+jsonLength).toString("utf8"));
  const nodes=gltf.nodes||[];
  const front=nodes.filter(n=>/Front.*Wheel/i.test(n.name||""));
  const rear=nodes.find(n=>/BackWheels/i.test(n.name||""));
  assert.equal(front.length,2,"two distinct front wheel pivots");
  assert.ok(front[0].translation[2]>0 && front[1].translation[2]>0,
    "model +Z is front: physics and chase camera must use +Z");
  assert.ok(front[0].translation[0]*front[1].translation[0]<0,
    "front wheels exist on opposite sides");
  assert.ok(rear?.translation[2]<0,"rear wheel geometry sits behind the chassis");
  // BackWheels is one combined mesh. The physics module supplies two independent
  // rear contact rays even though the GLB only has one rear visual node.
});
