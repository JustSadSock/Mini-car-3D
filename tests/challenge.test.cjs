const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../src/challenge.js"), "utf8");
const create = new Function(source.replace(/^export /gm, "") + "\nreturn createDrivingChallenge;")();

class Color {
  constructor(value) { this.value = value; }
  copy(other) { this.value = other.value; return this; }
}
class Geometry {
  setFromPoints(points) { this.points = points; return this; }
}
class Material {
  constructor(config) {
    Object.assign(this, config);
    this.color = new Color(config.color);
    if (config.emissive) this.emissive = new Color(config.emissive);
  }
}
class Group {
  constructor() { this.children = []; this.position = {set() {}}; this.rotation = {}; }
  add(object) { this.children.push(object); }
}
class Mesh {
  constructor(geometry, material) {
    this.geometry = geometry; this.material = material;
    this.position = {}; this.rotation = {}; this.scale = {setScalar() {}};
  }
}
class Line {
  computeLineDistances() {}
}
const THREE = {
  TorusGeometry: Geometry, RingGeometry: Geometry, BufferGeometry: Geometry,
  LineDashedMaterial: Material, MeshStandardMaterial: Material, MeshBasicMaterial: Material,
  Mesh, Group, Line, Color, DoubleSide: 2, Vector3: class {
    constructor(x,y,z) { Object.assign(this, {x,y,z}); }
  }
};
const route = [[0,14],[11,29],[26,21],[33,0],[19,-20],[-5,-27],[-29,-11],[-23,17],[-8,32]];

function game() {
  const scene = {items: [], add(object) { this.items.push(object); }};
  const challenge = create(THREE, scene);
  assert.equal(scene.items.length, route.length + 1);
  return challenge;
}

test("gates must be crossed in order", () => {
  const challenge = game();
  challenge.update(1, {x:0,z:0}, 2);
  challenge.update(1, {x:33,z:0}, 2);
  assert.equal(challenge.getState().next, 1);
  challenge.update(1, {x:0,z:14}, 2);
  assert.equal(challenge.getState().next, 2);
});

test("lap completes, stores record when possible and resets progress", () => {
  const challenge = game();
  challenge.update(1, {x:0,z:0}, 2);
  route.forEach(([x,z]) => challenge.update(1, {x,z}, 4));
  assert.ok(challenge.getState().best > 0);
  assert.equal(challenge.getState().next, 1);
  assert.equal(challenge.getState().finished, true);
  challenge.reset();
  assert.equal(challenge.getState().time, 0);
  assert.equal(challenge.getState().running, false);
});

test("stationary car does not start a lap", () => {
  const challenge = game();
  challenge.update(10, {x:0,z:14}, 0);
  assert.equal(challenge.getState().time, 0);
  assert.equal(challenge.getState().next, 1);
});
