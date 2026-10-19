const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("all entrypoint assets referenced by index exist with correct filename case", () => {
  const page = read("index.html");
  const js = read("src/game.js");
  assert.match(page, /src="\.\/src\/game\.js"/);
  assert.match(page, /href="styles\.css"/);
  const carURL = js.match(/loadAsync\(["']([^"']+\.glb)["']\)/);
  assert.ok(carURL, "car model path exists in loader");
  const assetPath = path.join(root, carURL[1]);
  assert.ok(fs.existsSync(assetPath), "GLB file exists with exactly the same case: " + carURL[1]);
});

test("slalom code is connected to game and HUD", () => {
  const game = read("src/game.js");
  const markup = read("index.html");
  for (const id of ["speedValue", "courseStatus", "recordValue", "resetBtn", "lightsBtn", "loadOverlay"]) {
    assert.ok(markup.includes('id="' + id + '"'), id + " exists");
  }
  assert.match(game, /challenge\.update\(/);
  assert.match(game, /challenge\.reset\(/);
  assert.match(game, /function resetCar\(/);
  assert.match(game, /world\.removeRigidBody\(rb\)/);
});

test("collision effects use Rapier callback-compatible API", () => {
  const game = read("src/game.js");
  assert.doesNotMatch(game, /world\.contactPair\(c1, c2\)\s*;/);
  assert.match(game, /c1\?\.parent\(\)/);
});

test("physics and visuals are JavaScript parseable", () => {
  const game = read("src/game.js")
    .replace(/^import .+;\s*$/gm, "")
    .replace("await RAPIER.init();", "");
  assert.doesNotThrow(() => new Function(game));
  assert.doesNotThrow(() => new Function(read("server.js")));
});
