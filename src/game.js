import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import RAPIER from "https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.12.0/rapier.es.js";

// --- Hard stop for iOS pinch / double-tap zoom antics ---
document.addEventListener("gesturestart", (e) => e.preventDefault(), { passive: false });
document.addEventListener("gesturechange", (e) => e.preventDefault(), { passive: false });
document.addEventListener("gestureend", (e) => e.preventDefault(), { passive: false });
["touchstart","touchmove","touchend"].forEach(evt => {
  document.addEventListener(evt, (e) => e.preventDefault(), { passive: false });
});

const wrap = document.getElementById("wrap");
const hud = document.getElementById("hud");
const netStatusEl = document.getElementById("netStatus");

const NETWORK = {
  defaultHost: "irgri.uk",
  localHost: "localhost:3000",
  mode: "offline",
  socket: null,
  id: null,
  reconnectTimer: null,
  lastSend: 0,
  seq: 0,
  snapshotBuffer: [],
  snapshotDelay: 0.12, // render delay (s) for interpolation smoothing
  tickRate: 60,
  snapshotRate: 20,
  serverTimeOffset: 0
};

function setNetStatus(text, online = false) {
  netStatusEl.textContent = text;
  netStatusEl.classList.toggle("net-online", online);
  netStatusEl.classList.toggle("net-offline", !online);
}

await RAPIER.init();
const FIXED_DT = 1 / 60;
const MAX_ACCUM = 0.25; // avoid spiral of death
const world = new RAPIER.World({ x: 0, y: -12.8, z: 0 }); // stronger gravity = quicker toy fall
const eventQueue = new RAPIER.EventQueue(true);

const rigidMeshes = new Map(); // rbHandle -> mesh
const colliderMetadata = new Map(); // colliderHandle -> { type }
const dynamicBodies = new Set();
const clientProps = [];
const serverProps = new Map();
const tempVec3 = new THREE.Vector3();
const tempQuat = new THREE.Quaternion();
let playerGroundContacts = 0;
let playerGrounded = false;
let offlineWorldReady = false;

const SAFE_ZONE = {
  center: new THREE.Vector3(0, 0, 0),
  radius: 10,   // bigger = fewer props near spawn
  height: 0.6,  // raise if car clips ground on spawn
};

const SAFE_SPAWN_SLOTS = [
  new THREE.Vector3(0, 0, 0),
  new THREE.Vector3(4, 0, 0),
  new THREE.Vector3(-4, 0, 0),
  new THREE.Vector3(0, 0, 4),
  new THREE.Vector3(0, 0, -4),
  new THREE.Vector3(4, 0, 4),
  new THREE.Vector3(-4, 0, 4),
  new THREE.Vector3(4, 0, -4),
  new THREE.Vector3(-4, 0, -4),
];

function hashIdForSlot(text = "local") {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function getSafeSpawnTransform(id = "local") {
  const idx = hashIdForSlot(id) % SAFE_SPAWN_SLOTS.length;
  const slot = SAFE_SPAWN_SLOTS[idx];
  const pos = SAFE_ZONE.center.clone().add(slot);
  pos.y = SAFE_ZONE.height;
  return { position: pos, yaw: 0 };
}

function isInsideSafeZone(x, z, margin = 0) {
  const dx = x - SAFE_ZONE.center.x;
  const dz = z - SAFE_ZONE.center.z;
  return Math.hypot(dx, dz) < SAFE_ZONE.radius + margin;
}

// --- Renderer ---
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x0b0f16, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.28;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
wrap.appendChild(renderer.domElement);

// --- Scene / Camera ---
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x0b0f16, 35, 140);

const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.1,
  400
);

// Lights (simple + cheap)
const hemi = new THREE.HemisphereLight(0xdfe9ff, 0x1a2433, 0.9);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xffffff, 0.9);
sun.position.set(12, 18, 10);
scene.add(sun);

// --- Ground: empty map ---
const groundGeo = new THREE.PlaneGeometry(220, 220, 1, 1);
const groundMat = new THREE.MeshStandardMaterial({
  color: 0x232a35,
  roughness: 1.0,
  metalness: 0.0
});
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.rotation.x = -Math.PI / 2;
ground.position.y = 0;
ground.receiveShadow = true;
scene.add(ground);

const grid = new THREE.GridHelper(220, 44, 0x3a4454, 0x2a3342);
grid.material.transparent = true;
grid.material.opacity = 0.25;
grid.position.y = 0.01;
scene.add(grid);

function registerBody(rb, mesh, collider, meta = {}) {
  if (rb) {
    rigidMeshes.set(rb.handle, mesh);
    if (meta.dynamic) dynamicBodies.add(rb);
  }
  if (collider) {
    colliderMetadata.set(collider.handle, meta);
    collider.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
  }
}

function disposeMesh(mesh) {
  if (!mesh) return;
  scene.remove(mesh);
  mesh.traverse((child) => {
    if (child.geometry) child.geometry.dispose?.();
    if (child.material) {
      if (Array.isArray(child.material)) child.material.forEach((m) => m?.dispose?.());
      else child.material.dispose?.();
    }
  });
}

function unregisterBody(rb, collider) {
  if (rb) {
    rigidMeshes.delete(rb.handle);
    dynamicBodies.delete(rb);
    world.removeRigidBody(rb);
  }
  if (collider) {
    colliderMetadata.delete(collider.handle);
  }
}

function makeGroundAndBounds() {
  const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const groundCollider = world.createCollider(
    RAPIER.ColliderDesc.cuboid(110, 0.1, 110)
      .setTranslation(0, -0.05, 0)
      .setFriction(1.15) // higher friction = less sliding (arcade)
      .setRestitution(0.1), // lower bounce = stickier ground
    groundBody
  );
  registerBody(groundBody, ground, groundCollider, { type: "ground" });

  const wallThickness = 2;
  const wallHeight = 4;
  const half = 110;
  const positions = [
    { x: half + wallThickness, y: wallHeight / 2, z: 0 },
    { x: -half - wallThickness, y: wallHeight / 2, z: 0 },
    { x: 0, y: wallHeight / 2, z: half + wallThickness },
    { x: 0, y: wallHeight / 2, z: -half - wallThickness },
  ];
  positions.forEach((p, idx) => {
    const sizeX = idx < 2 ? wallThickness : half + wallThickness;
    const sizeZ = idx < 2 ? half + wallThickness : wallThickness;
    const wallBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const collider = world.createCollider(
      RAPIER.ColliderDesc.cuboid(sizeX, wallHeight / 2, sizeZ)
        .setTranslation(p.x, p.y, p.z)
        .setFriction(0.9)
        .setRestitution(0.2),
      wallBody
    );
    registerBody(wallBody, null, collider, { type: "wall" });
  });
}

function spawnProps(count = 18) {
  const meshes = [];
  for (let i = 0; i < count; i++) {
    const dynamic = Math.random() > 0.35;
    const shape = Math.random() > 0.6 ? "cylinder" : "box";
    const size = new THREE.Vector3(
      0.4 + Math.random() * 0.4,
      0.35 + Math.random() * 0.35,
      0.4 + Math.random() * 0.4
    );
    const color = new THREE.Color().setHSL(Math.random(), 0.5, 0.5);
    let mesh;
    if (shape === "cylinder") {
      mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(size.x, size.x, size.y * 2, 14),
        new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.08 })
      );
    } else {
      mesh = new THREE.Mesh(
        new THREE.BoxGeometry(size.x * 2, size.y * 2, size.z * 2),
        new THREE.MeshStandardMaterial({ color, roughness: 0.65, metalness: 0.05 })
      );
    }
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    const findPropPosition = () => {
      let attempt = 0;
      while (attempt < 8) {
        const x = (Math.random() * 2 - 1) * 55;
        const z = (Math.random() * 2 - 1) * 55;
        const padding = Math.max(size.x, size.z) + 1.0;
        if (!isInsideSafeZone(x, z, padding)) {
          return { x, z };
        }
        attempt++;
      }
      const angle = Math.random() * Math.PI * 2;
      const r = SAFE_ZONE.radius + 6 + Math.random() * 18;
      return { x: SAFE_ZONE.center.x + Math.cos(angle) * r, z: SAFE_ZONE.center.z + Math.sin(angle) * r };
    };

    const { x, z } = findPropPosition();
    const y = size.y + 0.05;
    mesh.position.set(x, y, z);
    scene.add(mesh);
    meshes.push(mesh);

    const rbDesc = dynamic
      ? RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(x, y, z)
          .setLinearDamping(0.9 + Math.random() * 0.4) // higher = slower slide
          .setAngularDamping(1.0 + Math.random() * 0.6)
      : RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z);
    const rb = world.createRigidBody(rbDesc);
    if (dynamic && rb.enableCcd) rb.enableCcd(true);

    let colliderDesc;
    if (shape === "cylinder") {
      colliderDesc = RAPIER.ColliderDesc.cylinder(size.y, size.x);
    } else {
      colliderDesc = RAPIER.ColliderDesc.cuboid(size.x, size.y, size.z);
    }
    colliderDesc
      .setFriction(dynamic ? 0.8 : 0.95)
      .setRestitution(dynamic ? 0.32 : 0.2)
      .setDensity(dynamic ? 0.6 : 1.0);
    const collider = world.createCollider(colliderDesc, rb);
    registerBody(rb, mesh, collider, { type: dynamic ? "prop-dynamic" : "prop-fixed", dynamic });
    clientProps.push({ mesh, body: rb, collider });
  }
  return meshes;
}

function clearClientProps() {
  while (clientProps.length) {
    const prop = clientProps.pop();
    if (!prop) continue;
    disposeMesh(prop.mesh);
    unregisterBody(prop.body, prop.collider);
  }
}

function clearServerProps() {
  for (const prop of serverProps.values()) {
    disposeMesh(prop.mesh);
  }
  serverProps.clear();
}

function colorFromId(id) {
  let hash = 0;
  const text = `${id || "prop"}`;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  const hue = (hash % 360) / 360;
  return new THREE.Color().setHSL(hue, 0.52, 0.52);
}

function spawnServerProps(list = []) {
  clearServerProps();
  list.forEach((prop) => {
    const shape = prop.shape || "box";
    const size = prop.size || { x: 0.4, y: 0.35, z: 0.4 };
    const color = colorFromId(prop.id);
    let mesh;
    if (shape === "cylinder") {
      mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(size.x, size.x, size.y * 2, 14),
        new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.08 })
      );
    } else if (shape === "cone") {
      mesh = new THREE.Mesh(
        new THREE.ConeGeometry(size.x, size.y * 2, 14),
        new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.08 })
      );
    } else {
      mesh = new THREE.Mesh(
        new THREE.BoxGeometry(size.x * 2, size.y * 2, size.z * 2),
        new THREE.MeshStandardMaterial({ color, roughness: 0.65, metalness: 0.05 })
      );
    }
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    const initial = prop.initial || {};
    const pos = initial.p || [0, size.y || 0.35, 0];
    const rot = initial.q || [0, 0, 0, 1];
    mesh.position.set(pos[0] || 0, pos[1] || 0, pos[2] || 0);
    mesh.quaternion.set(rot[0] || 0, rot[1] || 0, rot[2] || 0, rot[3] || 1);
    scene.add(mesh);
    serverProps.set(prop.id, { mesh, dynamic: prop.dynamic });
  });
}

function makeNoiseNormalTexture(size = 128, spread = 6) {
  const data = new Uint8Array(size * size * 3);
  for (let i = 0; i < size * size; i++) {
    const base = 128;
    const nx = base + Math.floor((Math.random() * 2 - 1) * spread);
    const ny = base + Math.floor((Math.random() * 2 - 1) * spread);
    const softness = 255 - Math.min(48, Math.abs(nx - base) * 2 + Math.abs(ny - base) * 2);
    data[i * 3 + 0] = THREE.MathUtils.clamp(nx, 0, 255);
    data[i * 3 + 1] = THREE.MathUtils.clamp(ny, 0, 255);
    data[i * 3 + 2] = THREE.MathUtils.clamp(softness, 0, 255);
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBFormat);
  tex.needsUpdate = true;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipMapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  return tex;
}

function makeRadialGlowTexture(size = 256, color = "#ff2b3a") {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  const radius = size / 2;
  const grad = ctx.createRadialGradient(radius, radius, radius * 0.1, radius, radius, radius * 0.95);
  const col = new THREE.Color(color);
  const solid = `rgba(${Math.round(col.r * 255)},${Math.round(col.g * 255)},${Math.round(col.b * 255)},`;
  grad.addColorStop(0, `${solid}0.9)`);
  grad.addColorStop(0.35, `${solid}0.65)`);
  grad.addColorStop(0.75, `${solid}0.22)`);
  grad.addColorStop(1, `${solid}0)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipMapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  return tex;
}

function makeHeadlightCookieTexture(size = 256) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "black";
  ctx.fillRect(0, 0, size, size);

  ctx.save();
  ctx.translate(size / 2, size * 0.62);
  ctx.scale(1.12, 0.86);
  const radius = size * 0.46;
  const grad = ctx.createRadialGradient(0, 0, radius * 0.08, 0, 0, radius);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.32, "rgba(255,255,255,0.82)");
  grad.addColorStop(0.68, "rgba(255,255,255,0.2)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.ellipse(0, 0, radius * 1.08, radius, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.globalCompositeOperation = "destination-out";
  const cutHeight = size * 0.32;
  const cut = ctx.createLinearGradient(0, 0, 0, cutHeight);
  cut.addColorStop(0, "rgba(0,0,0,1)");
  cut.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = cut;
  ctx.fillRect(0, 0, size, cutHeight);
  ctx.globalCompositeOperation = "source-over";

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function attachHeadlights(car) {
  const cookie = attachHeadlights.cookie || (attachHeadlights.cookie = makeHeadlightCookieTexture());

  car.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(car);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  const headlightY = box.min.y + size.y * 0.55;
  const frontZ = box.max.z - size.z * 0.04;
  const xOffset = Math.max(size.x * 0.18, 0.18);

  const makeTarget = (offsetX = 0) => {
    const t = new THREE.Object3D();
    t.position.set(offsetX, headlightY + size.y * 0.08, frontZ + size.z * 0.6);
    car.add(t);
    return t;
  };

  const targetLeft = makeTarget(-xOffset);
  const targetRight = makeTarget(xOffset);

  const distance = 48;
  const angle = THREE.MathUtils.degToRad(14);
  const penumbra = 0.5;
  const basePower = 1500;
  const shadowBias = -0.0002;

  const createSpot = (offsetX, target, castShadow = false) => {
    const spot = new THREE.SpotLight(0xffffff);
    spot.power = basePower;
    spot.distance = distance;
    spot.angle = angle;
    spot.decay = 2;
    spot.penumbra = penumbra;
    spot.position.set(offsetX, headlightY, frontZ);
    spot.target = target;
    spot.castShadow = castShadow;
    spot.map = cookie;
    spot.userData.basePower = basePower;
    spot.shadow.mapSize.set(512, 512);
    spot.shadow.bias = shadowBias;
    spot.shadow.camera.near = 0.2;
    spot.shadow.camera.far = distance + 10;
    car.add(spot);
    return spot;
  };

  const left = createSpot(-xOffset, targetLeft, true);
  const right = createSpot(xOffset, targetRight, false);

  return { left, right, target: { left: targetLeft, right: targetRight }, beams: [] };
}

function attachRearLights(car) {
  car.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(car);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  const rearZ = box.min.z + size.z * 0.04;
  const lightY = box.min.y + size.y * 0.46;
  const xOffset = Math.max(size.x * 0.2, 0.18);

  const findLightMeshes = (predicate) => {
    const meshes = [];
    car.traverse((child) => {
      if (!child.isMesh) return;
      const name = (child.name || "").toLowerCase();
      if (predicate(name)) meshes.push(child);
    });
    return meshes;
  };

  const tailCandidates = findLightMeshes((name) =>
    name.includes("tail") || name.includes("rear") || name.includes("brake") || name.includes("stop")
  );

  const assignPair = (meshes, fallbackFactory) => {
    if (meshes.length >= 2) {
      const sorted = meshes
        .map((m) => ({ mesh: m, x: m.getWorldPosition(new THREE.Vector3()).x }))
        .sort((a, b) => a.x - b.x)
        .map((entry) => entry.mesh);
      return { left: sorted[0], right: sorted[sorted.length - 1] };
    }
    return fallbackFactory();
  };

  const makeTailMeshes = () => {
    const geo = new THREE.BoxGeometry(0.18, 0.1, 0.02);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x220000,
      emissive: 0x9c0d0d,
      emissiveIntensity: 0.9,
      roughness: 0.65,
      metalness: 0.08,
    });
    const left = new THREE.Mesh(geo, mat.clone());
    const right = new THREE.Mesh(geo.clone(), mat.clone());
    [left, right].forEach((mesh, i) => {
      mesh.position.set(i === 0 ? -xOffset : xOffset, lightY, rearZ - 0.012);
      mesh.rotation.y = Math.PI;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      car.add(mesh);
    });
    return { left, right };
  };

  const tail = assignPair(tailCandidates, makeTailMeshes);
  const targetBack = new THREE.Object3D();
  targetBack.position.set(0, lightY + size.y * 0.08, rearZ - size.z * 0.55);
  car.add(targetBack);

  const baseTailPower = 110;
  const baseDistance = 9.5;
  const baseAngle = THREE.MathUtils.degToRad(20);
  const basePenumbra = 0.65;

  const makeRearSpot = (offsetX) => {
    const spot = new THREE.SpotLight(0xff2b2b);
    spot.power = 0;
    spot.userData.basePower = baseTailPower;
    spot.distance = baseDistance;
    spot.angle = baseAngle;
    spot.decay = 2;
    spot.penumbra = basePenumbra;
    spot.position.set(offsetX, lightY, rearZ - 0.04);
    const target = targetBack.clone();
    target.position.x = offsetX;
    car.add(target);
    spot.target = target;
    spot.castShadow = false;
    car.add(spot);
    return spot;
  };

  const brakeLightL = makeRearSpot(-xOffset * 0.9);
  const brakeLightR = makeRearSpot(xOffset * 0.9);

  const rear = {
    leftMesh: tail.left,
    rightMesh: tail.right,
    brakeLightL,
    brakeLightR,
    brakeFactor: 0,
    prevSpeed: 0,
    isBraking: false,
  };

  return rear;
}

function updateRearLights(rear, dt, speed, targetSpeed, throttle, lightsOn = true) {
  if (!rear) return { braking: false };
  const safeDt = Math.max(dt, 0.0001);
  const accel = (speed - (rear.prevSpeed ?? speed)) / safeDt;

  const brakingByAccel = speed > 0.6 && accel < -1.2;
  const brakingByInput = speed > 0.6 && throttle < -0.1;
  const braking = brakingByAccel || brakingByInput;

  const lerpAmt = THREE.MathUtils.clamp(dt * 6.5, 0, 1);
  rear.brakeFactor = THREE.MathUtils.lerp(rear.brakeFactor, braking ? 1 : 0, lerpAmt);

  const tailBase = lightsOn ? 0.9 : 0.0;
  const brakeBoost = 3.6;

  const tailIntensity = tailBase + rear.brakeFactor * brakeBoost;

  const updateMeshIntensity = (mesh, intensity) => {
    if (!mesh || !mesh.material) return;
    const mat = mesh.material;
    if (!mat.emissive) mat.emissive = new THREE.Color(0x000000);
    mat.emissiveIntensity = intensity;
    mat.visible = intensity > 0.02;
  };

  updateMeshIntensity(rear.leftMesh, tailIntensity);
  updateMeshIntensity(rear.rightMesh, tailIntensity);

  const brakePower = rear.brakeFactor * rear.brakeLightL.userData.basePower + (lightsOn ? 28 : 0);

  [rear.brakeLightL, rear.brakeLightR].forEach((light) => {
    light.power = brakePower;
    light.visible = light.power > 0.01;
  });

  rear.prevSpeed = speed;
  rear.isBraking = braking;
  return { braking };
}

// --- Car (GLB model) ---
const gltfLoader = new GLTFLoader();
const carModelPromise = loadCarModel();

let car = null;

function loadCarModel() {
  return gltfLoader.loadAsync("models/NormalCar1.glb").then((gltf) => gltf.scene);
}

let loggedCarStructure = false;
function logCarStructure(root) {
  if (loggedCarStructure) return;
  loggedCarStructure = true;
  const lines = [];
  root.traverse((child) => {
    const mats = [];
    const material = child.material;
    if (Array.isArray(material)) {
      material.forEach((m) => m && mats.push(m.name || "(mat)"));
    } else if (material) {
      mats.push(material.name || "(mat)");
    }
    lines.push(`${child.name || child.type}${mats.length ? ` [${mats.join(", ")}]` : ""}`);
  });
  console.groupCollapsed("[CarModel] Scene graph");
  lines.forEach((l) => console.log(l));
  console.groupEnd();
}

function cloneMaterials(obj) {
  obj.traverse((child) => {
    if (!child.isMesh || !child.material) return;
    if (Array.isArray(child.material)) {
      child.material = child.material.map((mat) => mat?.clone?.() || mat);
    } else {
      child.material = child.material.clone();
    }
  });
}

function findMaterials(root, match) {
  const result = new Set();
  root.traverse((child) => {
    if (!child.isMesh || !child.material) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    mats.forEach((mat) => {
      const name = (mat?.name || child.name || "").toLowerCase();
      if (match(name)) result.add(mat);
    });
  });
  return Array.from(result);
}

function findWheelCandidates(root) {
  const wheels = [];
  root.traverse((child) => {
    const name = (child.name || "").toLowerCase();
    if (name.includes("wheel") || name.includes("tyre") || name.includes("tire")) {
      wheels.push(child);
    }
  });
  return wheels;
}

function categorizeWheels(root) {
  const wheelNodes = findWheelCandidates(root);
  if (wheelNodes.length === 0) {
    logCarStructure(root);
    return { wheelRig: [], radius: 0.3 };
  }

  root.updateMatrixWorld(true);
  const temp = new THREE.Vector3();
  const wheels = wheelNodes.map((mesh) => ({
    mesh,
    position: mesh.getWorldPosition(temp.clone()),
  }));

  const sorted = wheels.sort((a, b) => b.position.z - a.position.z);
  const front = new Set(sorted.slice(0, 2).map(({ mesh }) => mesh));

  const wheelRig = sorted.map(({ mesh }) => {
    const isFront = front.has(mesh);
    const parent = mesh.parent || mesh;
    const parentName = (parent.name || "").toLowerCase();
    const pivot = isFront && parent !== root && (parentName.includes("pivot") || parentName.includes("steer"))
      ? parent
      : mesh;
    return {
      mesh,
      pivot,
      steerable: isFront,
      baseQuaternion: mesh.quaternion.clone(),
      pivotBaseQuaternion: pivot.quaternion.clone(),
      angle: 0,
    };
  });

  const radius = (() => {
    const box = new THREE.Box3().setFromObject(wheels[0].mesh);
    return Math.max(0.15, (box.max.y - box.min.y) / 2);
  })();

  return { wheelRig, radius };
}

function collectBodyMaterials(root) {
  const blacklist = ["light", "lamp", "glass", "window", "wind", "screen", "plate", "license", "tyre", "tire", "wheel", "brake", "head", "tail", "led", "signal", "mirror"];
  const bluish = (color) => color && color.b > color.g * 0.9 && color.b > color.r * 1.15 && color.b > 0.28;
  const rawCandidates = findMaterials(root, (name) =>
    (name.includes("body") || name.includes("paint") || name.includes("car")) &&
    !blacklist.some((bad) => name.includes(bad))
  );

  const filtered = rawCandidates.filter((mat) => {
    const name = (mat?.name || "").toLowerCase();
    if (blacklist.some((bad) => name.includes(bad))) return false;
    return bluish(mat.color);
  });

  if (filtered.length > 0) return filtered;

  const fallback = [];
  root.traverse((child) => {
    if (
      child.isMesh &&
      child.material &&
      !Array.isArray(child.material) &&
      child.material.color &&
      !blacklist.some((bad) => (child.name || "").toLowerCase().includes(bad)) &&
      !blacklist.some((bad) => (child.material.name || "").toLowerCase().includes(bad)) &&
      bluish(child.material.color)
    ) {
      fallback.push(child.material);
    }
  });
  if (fallback.length === 0) {
    logCarStructure(root);
  }
  return fallback;
}

function collectLightMaterials(root) {
  const headlights = new Set(
    findMaterials(root, (name) =>
      name.includes("head") || name.includes("front") || name.includes("lamp") || name.includes("light")
    )
  );
  const tailLights = new Set(
    findMaterials(root, (name) =>
      name.includes("tail") || name.includes("rear") || name.includes("back") || name.includes("brake") || name.includes("light")
    )
  );

  const normalizeLightMaterial = (mat, fallbackColor, minIntensity) => {
    if (!mat) return;
    const color = new THREE.Color(fallbackColor);
    if (mat.color && (mat.color.r + mat.color.g + mat.color.b) < 0.05) mat.color.set(color);
    if (mat.emissive) {
      mat.emissive.set(color);
    }
    if (typeof mat.emissiveIntensity !== "number" || mat.emissiveIntensity < minIntensity) {
      mat.emissiveIntensity = minIntensity;
    }
  };

  const ensureColorMatches = (mat, predicate, bucket, fallbackColor, minIntensity) => {
    const c = mat.emissive || mat.color;
    if (!c) return;
    if (predicate(c)) {
      bucket.add(mat);
      normalizeLightMaterial(mat, fallbackColor, minIntensity);
    }
  };

  root.traverse((child) => {
    if (!child.isMesh || !child.material) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    mats.forEach((mat) => {
      ensureColorMatches(
        mat,
        (c) => c.r > 0.65 && c.g > 0.2 && c.b < 0.2 && c.r > c.g,
        headlights,
        0xffffff,
        1.4
      );
      ensureColorMatches(
        mat,
        (c) => c.r > 0.55 && c.g < 0.25 && c.b < 0.25 && c.r > c.g * 1.6,
        tailLights,
        0xff2b2b,
        0.8
      );
    });
  });

  if (headlights.size === 0 || tailLights.size === 0) {
    logCarStructure(root);
  }

  headlights.forEach((mat) => normalizeLightMaterial(mat, 0xffffff, 1.4));
  tailLights.forEach((mat) => normalizeLightMaterial(mat, 0xff2b2b, 0.8));

  return { headlights: Array.from(headlights), tailLights: Array.from(tailLights) };
}

const wheelRollAxis = new THREE.Vector3(1, 0, 0);
const wheelSteerAxis = new THREE.Vector3(0, 1, 0);
const tempRollQuat = new THREE.Quaternion();
const tempSteerQuat = new THREE.Quaternion();

function applyWheelPose(car, steerAngle, rollDelta) {
  const rig = car.userData.wheelRig;
  if (!rig) return;
  tempSteerQuat.setFromAxisAngle(wheelSteerAxis, steerAngle || 0);
  const delta = typeof rollDelta === "number" ? rollDelta : 0;
  rig.forEach((wheel) => {
    wheel.angle += delta;
    tempRollQuat.setFromAxisAngle(wheelRollAxis, wheel.angle);
    if (wheel.steerable) {
      if (wheel.pivot && wheel.pivot !== wheel.mesh) {
        wheel.pivot.quaternion.copy(wheel.pivotBaseQuaternion).multiply(tempSteerQuat);
        wheel.mesh.quaternion.copy(wheel.baseQuaternion).multiply(tempRollQuat);
      } else {
        wheel.mesh.quaternion.copy(wheel.baseQuaternion).multiply(tempSteerQuat).multiply(tempRollQuat);
      }
    } else {
      wheel.mesh.quaternion.copy(wheel.baseQuaternion).multiply(tempRollQuat);
    }
  });
}

async function makeCar(isPlayer = true, withPhysics = true, spawnOverride = null) {
  const baseScene = await carModelPromise;
  const car = cloneSkeleton(baseScene);
  cloneMaterials(car);

  car.traverse((child) => {
    if (child.isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });

  const { wheelRig, radius } = categorizeWheels(car);
  const { headlights, tailLights } = collectLightMaterials(car);
  const bodyMaterials = collectBodyMaterials(car);
  const headlightRig = attachHeadlights(car);
  const rearLights = attachRearLights(car);

  const headlightIntensities = headlights.map((m) =>
    typeof m.emissiveIntensity === "number" ? m.emissiveIntensity : 1.25
  );
  const tailLightIntensities = tailLights.map((m) =>
    typeof m.emissiveIntensity === "number" ? m.emissiveIntensity : 0.8
  );

  car.userData.wheelRig = wheelRig;
  car.userData.wheelRadius = radius;
  car.userData.lightsOn = true;
  car.userData.brakeActive = false;
  car.userData.headlights = headlightRig;
  car.userData.rearLights = rearLights;
  car.userData.lastSpeed = 0;
  car.userData.lastTargetSpeed = 0;
  car.userData.grounded = false;

  const spawnTransform = spawnOverride || (isPlayer ? getSafeSpawnTransform(NETWORK.id || "local") : null);
  if (spawnTransform?.position) {
    car.position.copy(spawnTransform.position);
    car.userData.initialPosition = spawnTransform.position.clone();
  }
  if (typeof spawnTransform?.yaw === "number") {
    car.rotation.y = spawnTransform.yaw;
  }

  car.userData.setPlayerColor = (color) => {
    bodyMaterials.forEach((mat) => {
      if (mat?.color) mat.color.set(color);
    });
  };

  car.userData.setLights = (on) => {
    car.userData.lightsOn = Boolean(on);
    car.userData.applyLights?.(car.userData.brakeActive);
  };

  car.userData.applyLights = (brake = false) => {
    const lightsOn = car.userData.lightsOn;
    const brakeFactor = car.userData.rearLights ? car.userData.rearLights.brakeFactor : (brake ? 1 : 0);
    headlights.forEach((mat, i) => {
      if (typeof mat.emissiveIntensity === "number") {
        mat.emissiveIntensity = lightsOn ? headlightIntensities[i] : 0.0;
      }
      mat.visible = lightsOn;
    });
    tailLights.forEach((mat, i) => {
      const base = lightsOn ? tailLightIntensities[i] : 0.04;
      if (typeof mat.emissiveIntensity === "number") {
        mat.emissiveIntensity = base + brakeFactor * (tailLightIntensities[i] * 2.8);
      }
      mat.visible = lightsOn || brakeFactor > 0.02;
    });

    if (headlightRig) {
      const { left, right, beams } = headlightRig;
      if (left) {
        left.visible = lightsOn;
        left.power = lightsOn ? left.userData.basePower : 0;
      }
      if (right) {
        right.visible = lightsOn;
        right.power = lightsOn ? right.userData.basePower : 0;
      }
      beams?.forEach((beam) => {
        beam.visible = lightsOn;
        if (beam.material && typeof beam.userData.baseOpacity === "number") {
          beam.material.opacity = lightsOn ? beam.userData.baseOpacity : 0;
        }
      });
    }

    if (car.userData.rearLights) {
      updateRearLights(
        car.userData.rearLights,
        0.016,
        car.userData.lastSpeed || 0,
        car.userData.lastTargetSpeed || 0,
        0,
        lightsOn
      );
    }

  };

  car.userData.applyLights(false);

  // --- Physics body (toy-like) ---
  const bbox = new THREE.Box3().setFromObject(car);
  const size = bbox.getSize(new THREE.Vector3());
  const center = bbox.getCenter(new THREE.Vector3());

  if (withPhysics) {
    const halfX = size.x * 0.46; // widen for truer hitbox vs model
    const halfY = size.y * 0.3;  // taller collider = less bottoming out
    const halfZ = size.z * 0.48; // near full length so props register hits

    const startPos = car.userData.initialPosition || new THREE.Vector3(0, size.y * 0.5, 0);
    const startRot = car.quaternion.clone();
    const rbDesc = isPlayer
      ? RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(startPos.x, startPos.y, startPos.z)
          .setRotation({ x: startRot.x, y: startRot.y, z: startRot.z, w: startRot.w })
          .setCanSleep(false)
          .setLinearDamping(1.4) // lower for more glide (also faster fall), higher for tighter stop
          .setAngularDamping(3.2) // lower for more spin, higher for stability
      : RAPIER.RigidBodyDesc.kinematicPositionBased()
          .setTranslation(startPos.x, startPos.y, startPos.z)
          .setRotation({ x: startRot.x, y: startRot.y, z: startRot.z, w: startRot.w })
          .setCanSleep(false);
    const rb = world.createRigidBody(rbDesc);
    if (DRIVE.ccd && rb.enableCcd && isPlayer) rb.enableCcd(true);
    if (rb.setGravityScale && isPlayer) {
      rb.setGravityScale(1.2, true); // >1 = stronger pull-down for snappier drops
    }
    const colliderDesc = RAPIER.ColliderDesc.cuboid(halfX, halfY, halfZ)
      .setTranslation(center.x - car.position.x, center.y - car.position.y - size.y * 0.08, center.z - car.position.z)
      .setFriction(1.2) // more friction = grippier tabletop feel
      .setRestitution(0.26) // less bounce = calmer toy
      .setDensity(0.72);
    const collider = world.createCollider(colliderDesc, rb);
    registerBody(rb, car, collider, { type: isPlayer ? "car" : "car-remote", dynamic: true });
    car.userData.physics = { body: rb, collider };
    if (isPlayer) {
      playerPhysics.body = rb;
      playerPhysics.collider = collider;
    }
    car.position.copy(startPos);
  }

  return car;
}

async function setupPlayerCar() {
  car = await makeCar(true, true, getSafeSpawnTransform(NETWORK.id || "local"));
  scene.add(car);
  playerGroundContacts = 0;
  playerGrounded = false;
  ensureLocalColor();
}


// --- Multiplayer (online/offline aware) ---
const remotePlayers = new Map();

function clearRemotePlayers() {
  for (const id of Array.from(remotePlayers.keys())) {
    removeRemotePlayer(id);
  }
}

const PLAYER_COLORS = [
  "#ff6b35", // orange
  "#ffd166", // yellow
  "#06d6a0", // green
  "#5e60ce", // purple
  "#f72585", // magenta
  "#2ec4b6", // teal
  "#f4a261", // tan/orange
  "#a0d911", // lime
];

function colorIndexFromId(id) {
  const text = id || "local";
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return hash % PLAYER_COLORS.length;
}

function colorizeCar(mesh, idForColor) {
  const hex = PLAYER_COLORS[colorIndexFromId(idForColor)];
  const color = new THREE.Color(hex);
  mesh.userData.playerColor = hex;
  mesh.userData.setPlayerColor?.(color);
}

function buildSafeSpawnState(id = "remote") {
  const safe = getSafeSpawnTransform(id);
  return {
    p: [safe.position.x, safe.position.y, safe.position.z],
    y: safe.yaw,
    s: 0,
    st: 0,
    b: false,
  };
}

function ensureLocalColor() {
  if (!car) return;
  const colorId = NETWORK.id || "local";
  if (car.userData.assignedColorId === colorId) return;
  colorizeCar(car, colorId);
  car.userData.assignedColorId = colorId;
}

async function spawnRemotePlayer(id, snapshot) {
  if (remotePlayers.has(id)) return;
  const placeholder = { mesh: null, target: null, loading: true };
  remotePlayers.set(id, placeholder);
  const initialState = snapshot || buildSafeSpawnState(id);
  const spawnTransform = Array.isArray(initialState.p)
    ? { position: new THREE.Vector3(initialState.p[0] || 0, initialState.p[1] || 0, initialState.p[2] || 0), yaw: initialState.y || 0 }
    : getSafeSpawnTransform(id);
  const ghost = await makeCar(false, true, spawnTransform);
  colorizeCar(ghost, id);
  ghost.userData.isRemote = true;
  ghost.userData.applyLights?.(false);
  scene.add(ghost);
  placeholder.mesh = ghost;
  placeholder.loading = false;
  applyRemoteState(id, initialState);
}

function removeRemotePlayer(id) {
  const player = remotePlayers.get(id);
  if (!player) return;
  if (player.mesh) {
    scene.remove(player.mesh);
    player.mesh.traverse((child) => {
      if (child.geometry) child.geometry.dispose?.();
      if (child.material) child.material.dispose?.();
    });
  }
  remotePlayers.delete(id);
}

function applyRemoteState(id, state) {
  const player = remotePlayers.get(id);
  if (!player) return;
  const target = {
    position: new THREE.Vector3(state.p?.[0] || 0, state.p?.[1] || 0, state.p?.[2] || 0),
    yaw: state.y || 0,
    speed: state.s || 0,
    steer: state.st || 0,
    brake: Boolean(state.b),
    received: performance.now()
  };
  player.target = target;
}

function applyWorldState(players) {
  if (!Array.isArray(players)) return;
  players.forEach((p) => {
    if (!p?.id || p.id === NETWORK.id) return;
    if (!remotePlayers.has(p.id)) {
      spawnRemotePlayer(p.id, p.state).catch((err) => console.warn("Remote spawn failed", err));
    } else {
      applyRemoteState(p.id, p.state);
    }
  });
}

function updateRemotePlayers(dt) {
  const follow = 1 - Math.pow(0.0015, dt);
  for (const player of remotePlayers.values()) {
    if (!player.mesh || !player.target) continue;
    const rb = player.mesh.userData.physics?.body;
    const currentPos = rb ? rb.translation() : player.mesh.position;

    const lerpPos = new THREE.Vector3(currentPos.x, currentPos.y, currentPos.z)
      .lerp(player.target.position, follow);
    const currentYawVal = player.mesh.rotation.y;
    const deltaYaw = ((player.target.yaw - currentYawVal + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    const lerpYaw = currentYawVal + deltaYaw * follow;
    const lerpQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), lerpYaw);

    if (rb?.setNextKinematicTranslation) {
      rb.setNextKinematicTranslation({ x: lerpPos.x, y: lerpPos.y, z: lerpPos.z });
      rb.setNextKinematicRotation({ x: lerpQuat.x, y: lerpQuat.y, z: lerpQuat.z, w: lerpQuat.w });
    }

    player.mesh.position.copy(lerpPos);
    player.mesh.quaternion.copy(lerpQuat);

    const rollDelta = (player.target.speed / (player.mesh.userData.wheelRadius || 1)) * dt;
    applyWheelPose(player.mesh, player.target.steer || 0, rollDelta);
    player.mesh.userData.lastSpeed = player.target.speed || 0;
    player.mesh.userData.lastTargetSpeed = player.target.speed || 0;
    if (player.mesh.userData.rearLights) {
      updateRearLights(
        player.mesh.userData.rearLights,
        dt,
        player.target.speed || 0,
        player.target.speed || 0,
        player.target.brake ? -1 : Math.sign(player.target.speed || 0),
        player.mesh.userData.lightsOn ?? true
      );
    }
    player.mesh.userData.brakeActive = Boolean(player.target.brake);
    player.mesh.userData.applyLights?.(player.mesh.userData.brakeActive);
  }
}

function resolveServerHost() {
  const host = location.hostname;
  if (host === "localhost" || host === "127.0.0.1") return NETWORK.localHost;
  if (!host || host === "") return NETWORK.defaultHost;
  return NETWORK.defaultHost;
}

async function checkServerAvailability(host, timeoutMs = 1800) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const protocol = host.includes("localhost") || host.includes("127.0.0.1") ? "http" : "https";
  try {
    const res = await fetch(`${protocol}://${host}/health`, {
      signal: controller.signal,
      cache: "no-store"
    });
    return res.ok;
  } catch (err) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function ensureOfflineWorld(message = "Offline режим (сервер недоступен)") {
  NETWORK.mode = "offline";
  setNetStatus(message, false);
  NETWORK.snapshotBuffer.length = 0;
  clearServerProps();
  clearRemotePlayers();
  if (!offlineWorldReady) {
    clearClientProps();
    spawnProps(20);
    offlineWorldReady = true;
  }
}

function snapshotClientTime(snap) {
  return (snap?.serverTime || 0) + NETWORK.serverTimeOffset;
}

function interpolateState(a, b, alpha) {
  if (!b) return a;
  if (!a) return b;
  const lerpVec = (va = [], vb = []) => [
    THREE.MathUtils.lerp(va[0] || 0, vb[0] || 0, alpha),
    THREE.MathUtils.lerp(va[1] || 0, vb[1] || 0, alpha),
    THREE.MathUtils.lerp(va[2] || 0, vb[2] || 0, alpha),
  ];
  const qa = new THREE.Quaternion(a.q?.[0] || 0, a.q?.[1] || 0, a.q?.[2] || 0, a.q?.[3] || 1);
  const qb = new THREE.Quaternion(b.q?.[0] || 0, b.q?.[1] || 0, b.q?.[2] || 0, b.q?.[3] || 1);
  const qi = qa.clone().slerp(qb, alpha);
  return {
    id: a.id || b.id,
    p: lerpVec(a.p, b.p),
    q: [qi.x, qi.y, qi.z, qi.w],
    lv: lerpVec(a.lv, b.lv),
    av: lerpVec(a.av, b.av),
  };
}

function applyInterpolatedPlayer(id, state) {
  if (!state) return;
  const pos = state.p || [0, 0, 0];
  const rot = state.q || [0, 0, 0, 1];
  const speed = Math.hypot(state.lv?.[0] || 0, state.lv?.[1] || 0, state.lv?.[2] || 0);
  if (id === NETWORK.id) {
    if (car) {
      car.position.set(pos[0] || 0, pos[1] || 0, pos[2] || 0);
      car.quaternion.set(rot[0] || 0, rot[1] || 0, rot[2] || 0, rot[3] || 1);
      car.userData.lastSpeed = speed;
      car.userData.lastTargetSpeed = speed;
    }
    return;
  }

  let remote = remotePlayers.get(id);
  if (!remote) {
    spawnRemotePlayer(id, { p: pos, q: rot }).catch(() => {});
    remote = remotePlayers.get(id);
  }
  const mesh = remote?.mesh;
  if (!mesh) return;
  mesh.position.set(pos[0] || 0, pos[1] || 0, pos[2] || 0);
  mesh.quaternion.set(rot[0] || 0, rot[1] || 0, rot[2] || 0, rot[3] || 1);
  mesh.userData.lastSpeed = speed;
  mesh.userData.lastTargetSpeed = speed;
}

function applyInterpolatedProps(stateMap) {
  stateMap.forEach((state, id) => {
    const entry = serverProps.get(id);
    if (!entry || !entry.dynamic) return;
    const pos = state.p || [0, 0, 0];
    const rot = state.q || [0, 0, 0, 1];
    entry.mesh.position.set(pos[0] || 0, pos[1] || 0, pos[2] || 0);
    entry.mesh.quaternion.set(rot[0] || 0, rot[1] || 0, rot[2] || 0, rot[3] || 1);
  });
}

function applySnapshotInterpolation() {
  if (!NETWORK.snapshotBuffer.length) return;
  NETWORK.snapshotBuffer.sort((a, b) => (a.serverTime || 0) - (b.serverTime || 0));
  const renderTime = performance.now() - NETWORK.snapshotDelay * 1000;
  while (NETWORK.snapshotBuffer.length > 2 && snapshotClientTime(NETWORK.snapshotBuffer[1]) <= renderTime) {
    NETWORK.snapshotBuffer.shift();
  }

  const prev = NETWORK.snapshotBuffer[0];
  const next = NETWORK.snapshotBuffer.find((s) => snapshotClientTime(s) >= renderTime) || NETWORK.snapshotBuffer[NETWORK.snapshotBuffer.length - 1];
  const prevTime = snapshotClientTime(prev);
  const nextTime = snapshotClientTime(next);
  const span = Math.max(1, nextTime - prevTime);
  const alpha = THREE.MathUtils.clamp((renderTime - prevTime) / span, 0, 1);

  const prevPlayers = new Map((prev.players || []).map((p) => [p.id, p]));
  const nextPlayers = new Map((next.players || []).map((p) => [p.id, p]));
  const playerIds = new Set([...prevPlayers.keys(), ...nextPlayers.keys()]);
  playerIds.forEach((id) => {
    const state = interpolateState(prevPlayers.get(id), nextPlayers.get(id), alpha);
    applyInterpolatedPlayer(id, state);
  });

  const prevProps = new Map((prev.props || []).map((p) => [p.id, p]));
  const nextProps = new Map((next.props || []).map((p) => [p.id, p]));
  const propIds = new Set([...prevProps.keys(), ...nextProps.keys()]);
  const propStates = new Map();
  propIds.forEach((id) => {
    const state = interpolateState(prevProps.get(id), nextProps.get(id), alpha);
    if (state) propStates.set(id, state);
  });
  applyInterpolatedProps(propStates);
}

function cleanSocket() {
  if (NETWORK.socket) {
    NETWORK.socket.close();
    NETWORK.socket = null;
  }
}

function scheduleReconnect() {
  if (NETWORK.reconnectTimer) return;
  NETWORK.reconnectTimer = setTimeout(() => {
    NETWORK.reconnectTimer = null;
    initNetwork();
  }, 2500);
}

function sendInput() {
  if (!NETWORK.socket || NETWORK.socket.readyState !== WebSocket.OPEN) return;
  const now = performance.now();
  if (now - NETWORK.lastSend < 33) return; // ~30 Hz input
  NETWORK.lastSend = now;
  const axes = keyboardAxes();
  const steer = clamp(inputX || axes.x || joyX, -1, 1);
  const throttle = clamp(-(inputY || axes.y || joyY), -1, 1);
  const payload = {
    type: "input",
    seq: ++NETWORK.seq,
    t: now,
    steer,
    throttle,
    brake: throttle < 0
  };
  NETWORK.socket.send(JSON.stringify(payload));
}

function handleMessage(evt) {
  let data;
  try {
    data = JSON.parse(evt.data);
  } catch (err) {
    return;
  }

  if (data.type === "welcome") {
    NETWORK.id = data.id;
    NETWORK.tickRate = data.tickRate || NETWORK.tickRate;
    NETWORK.snapshotRate = data.snapshotRate || NETWORK.snapshotRate;
    NETWORK.serverTimeOffset = performance.now() - (data.serverTime || Date.now());
    NETWORK.mode = "online";
    offlineWorldReady = false;
    clearClientProps();
    NETWORK.snapshotBuffer.length = 0;
    setNetStatus(`Online: ${resolveServerHost()}`, true);
    ensureLocalColor();
    clearRemotePlayers();
    if (Array.isArray(data.props)) {
      spawnServerProps(data.props);
    }
    if (Array.isArray(data.players)) {
      data.players.forEach((p) => {
        spawnRemotePlayer(p.id, p.initial)?.catch?.(() => {});
      });
    }
    if (!car) {
      setupPlayerCar(false, false, data.initial).catch(() => {});
    }
  } else if (data.type === "snapshot") {
    const snap = { ...data, receivedAt: performance.now() };
    NETWORK.snapshotBuffer.push(snap);
    NETWORK.snapshotBuffer.sort((a, b) => (a.serverTime || 0) - (b.serverTime || 0));
    if (NETWORK.snapshotBuffer.length > 90) NETWORK.snapshotBuffer.shift();
    (data.players || [])
      .filter((p) => p.id && p.id !== NETWORK.id && !remotePlayers.has(p.id))
      .forEach((p) => spawnRemotePlayer(p.id, p).catch(() => {}));
  } else if (data.type === "player-left" && data.id) {
    removeRemotePlayer(data.id);
  } else if (data.type === "player-joined" && data.id && data.id !== NETWORK.id) {
    if (!remotePlayers.has(data.id)) spawnRemotePlayer(data.id, data.initial).catch((err) => console.warn("Remote spawn failed", err));
  }
}

async function initNetwork() {
  cleanSocket();
  const host = resolveServerHost();
  const available = await checkServerAvailability(host);
  if (!available) {
    ensureOfflineWorld();
    scheduleReconnect();
    return false;
  }

  const protocol = host.includes("localhost") || host.includes("127.0.0.1") ? "ws" : "wss";
  const ws = new WebSocket(`${protocol}://${host}/ws`);
  ws.addEventListener("open", () => {
    NETWORK.socket = ws;
    NETWORK.mode = "online";
    NETWORK.lastSend = 0;
    setNetStatus(`Online: ${host}`, true);
    sendInput();
  });
  ws.addEventListener("message", handleMessage);
  ws.addEventListener("close", () => {
    NETWORK.socket = null;
    ensureOfflineWorld("Offline режим (нет соединения)");
    scheduleReconnect();
  });
  ws.addEventListener("error", () => {
    setNetStatus("Offline режим (ошибка связи)", false);
  });
  return true;
}

// --- Input: single joystick + keyboard fallback ---
const joy = document.getElementById("joy");
const nub = document.getElementById("joyNub");
const isCoarsePointer = window.matchMedia("(pointer: coarse)").matches;
if (!isCoarsePointer) {
  joy.style.display = "none";
}

let joyActive = false;
let joyPointerId = null;
let joyX = 0;  // -1..1
let joyY = 0;  // -1..1

function setNub(dx, dy) {
  nub.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
}

function handleJoyEvent(e) {
  e.preventDefault();
  const rect = joy.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const radius = rect.width * 0.36; // nub travel

  const px = e.clientX;
  const py = e.clientY;

  let dx = px - cx;
  let dy = py - cy;

  const len = Math.hypot(dx, dy);
  if (len > radius) {
    dx = (dx / len) * radius;
    dy = (dy / len) * radius;
  }

  setNub(dx, dy);

  // Normalize to -1..1. Up on screen = forward throttle.
  joyX = dx / radius;
  joyY = -dy / radius;

  // Deadzone (so it doesn't drift)
  const dz = 0.08;
  if (Math.abs(joyX) < dz) joyX = 0;
  if (Math.abs(joyY) < dz) joyY = 0;
}

joy.addEventListener("pointerdown", (e) => {
  joyActive = true;
  joyPointerId = e.pointerId;
  joy.setPointerCapture(joyPointerId);
  handleJoyEvent(e);
}, { passive: false });

joy.addEventListener("pointermove", (e) => {
  if (!joyActive || e.pointerId !== joyPointerId) return;
  handleJoyEvent(e);
}, { passive: false });

function releaseJoy() {
  joyActive = false;
  joyPointerId = null;
  joyX = 0;
  joyY = 0;
  setNub(0, 0);
}

joy.addEventListener("pointerup", (e) => {
  if (e.pointerId !== joyPointerId) return;
  releaseJoy();
}, { passive: false });

joy.addEventListener("pointercancel", releaseJoy, { passive: false });

// Keyboard fallback (PC)
const keys = new Set();
window.addEventListener("keydown", (e) => { keys.add(e.code); });
window.addEventListener("keyup", (e) => { keys.delete(e.code); });

function keyboardAxes() {
  let x = 0, y = 0;
  const left  = keys.has("ArrowLeft") || keys.has("KeyA");
  const right = keys.has("ArrowRight")|| keys.has("KeyD");
  const up    = keys.has("ArrowUp")   || keys.has("KeyW");
  const down  = keys.has("ArrowDown") || keys.has("KeyS");
  if (left) x -= 1;
  if (right) x += 1;
  if (up) y += 1;
  if (down) y -= 1;
  // Invert both axes for keyboard to mirror requested control scheme
  return { x: -x, y: -y };
}

// --- Physics driving ---
const playerPhysics = { body: null, collider: null };
let inputX = 0;
let inputY = 0;
let accumulator = 0;
let last = performance.now();
let cameraShake = 0;
const previousTransforms = new Map();
let lastPhysicsDt = FIXED_DT;

const DRIVE = {
  engineImpulse: 4.8,   // toy-car push (lower = calmer)
  steerTorque: 0.52,    // yaw authority
  maxSpeed: 11.0,       // forward top speed
  maxReverse: 7.5,      // reverse speed
  speedClamp: 0.32,     // higher = stronger speed cap impulse
  sideGrip: 2.4,        // higher = less drift
  yawRateLimit: 3.2,    // clamp yaw spin (rad/s)
  ccd: true,
  skidSideThreshold: 3.0,
  skidMinSpeed: 4.0,
};

const CAMERA = {
  offset: new THREE.Vector3(0, 6.0, -12.0),
  lookAhead: new THREE.Vector3(0, 1.2, 6.5),
  shakeDecay: 3.8,
};

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function approach(current, target, maxDelta) {
  const delta = target - current;
  if (Math.abs(delta) <= maxDelta) return target;
  return current + Math.sign(delta) * maxDelta;
}

class ParticlePool {
  constructor(max, color, size, additive = false) {
    this.max = max;
    this.positions = new Float32Array(max * 3);
    this.velocities = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    this.colors = new Float32Array(max * 3);
    this.geometry.setAttribute("color", new THREE.BufferAttribute(this.colors, 3));
    this.material = new THREE.PointsMaterial({
      size,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      vertexColors: true,
      sizeAttenuation: true,
    });
    this.color = new THREE.Color(color);
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  spawn(origin, count, speedRange, lifeRange, base = new THREE.Vector3()) {
    for (let i = 0; i < this.max && count > 0; i++) {
      if (this.life[i] > 0) continue;
      const vx = (Math.random() * 2 - 1) * speedRange;
      const vy = Math.random() * speedRange * 0.6 + base.y;
      const vz = (Math.random() * 2 - 1) * speedRange;
      this.positions[i * 3 + 0] = origin.x;
      this.positions[i * 3 + 1] = origin.y;
      this.positions[i * 3 + 2] = origin.z;
      this.velocities[i * 3 + 0] = vx + base.x;
      this.velocities[i * 3 + 1] = vy;
      this.velocities[i * 3 + 2] = vz + base.z;
      this.life[i] = lifeRange[0] + Math.random() * (lifeRange[1] - lifeRange[0]);
      this.colors[i * 3 + 0] = this.color.r;
      this.colors[i * 3 + 1] = this.color.g;
      this.colors[i * 3 + 2] = this.color.b;
      count--;
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true;
  }

  update(dt, gravity = 0) {
    let changed = false;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.colors[i * 3 + 0] = 0;
        this.colors[i * 3 + 1] = 0;
        this.colors[i * 3 + 2] = 0;
        changed = true;
        continue;
      }
      const fade = clamp(this.life[i], 0, 1);
      this.colors[i * 3 + 0] = this.color.r * fade;
      this.colors[i * 3 + 1] = this.color.g * fade;
      this.colors[i * 3 + 2] = this.color.b * fade;
      this.velocities[i * 3 + 1] -= gravity * dt;
      this.positions[i * 3 + 0] += this.velocities[i * 3 + 0] * dt;
      this.positions[i * 3 + 1] += this.velocities[i * 3 + 1] * dt;
      this.positions[i * 3 + 2] += this.velocities[i * 3 + 2] * dt;
      changed = true;
    }
    if (changed) {
      this.geometry.attributes.position.needsUpdate = true;
      this.geometry.attributes.color.needsUpdate = true;
    }
  }
}

const impactParticles = new ParticlePool(200, 0xffd7a6, 0.18, true);
const skidParticles = new ParticlePool(160, 0xd0d0d0, 0.12, false);
let skidCooldown = 0;

function spawnImpact(origin, strength) {
  const count = Math.min(32, 12 + Math.floor(strength * 10));
  impactParticles.spawn(origin, count, 6 + strength * 6, [0.22, 0.6], new THREE.Vector3(0, strength * 4, 0));
  cameraShake = Math.max(cameraShake, strength * 0.06); // raise for more shake (arcade)
}

function spawnSkid(origin, direction, intensity) {
  const dir = direction.clone().normalize().multiplyScalar(intensity * 0.4);
  skidParticles.spawn(origin, 6, 1.4, [0.28, 0.45], dir);
}

function applyPlayerForces(dt) {
  const rb = playerPhysics.body;
  if (!car || !rb) return;

  // Prefer joystick; if idle, use keyboard.
  let ax = joyX;
  let ay = joyY;
  if (joyActive && isCoarsePointer) {
    ax = joyX; // invert turn handling globally to keep on-screen directions natural
    ay = -joyY;
  }
  if ((!joyActive || !isCoarsePointer) && ax === 0 && ay === 0) {
    const k = keyboardAxes();
    ax = k.x;
    ay = k.y;
  }

  const DEADZONE = 0.06;
  if (Math.abs(ax) < DEADZONE) ax = 0;
  if (Math.abs(ay) < DEADZONE) ay = 0;

  const INPUT_ACCEL = 6.0;
  inputX = approach(inputX, ax, INPUT_ACCEL * dt);
  inputY = approach(inputY, ay, INPUT_ACCEL * dt);
  ax = inputX;
  ay = inputY;

  const rot = rb.rotation();
  tempQuat.set(rot.x, rot.y, rot.z, rot.w);
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(tempQuat).normalize();
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(tempQuat).normalize();
  const velocity = rb.linvel();
  const vel = new THREE.Vector3(velocity.x, velocity.y, velocity.z);
  const speedAlong = vel.dot(forward);

  const traction = playerGrounded ? 1 : 0.15;

  // Engine impulse
  const engine = forward.clone().multiplyScalar(ay * DRIVE.engineImpulse * traction);
  rb.applyImpulse(engine, true);

  // Steering torque (stronger at medium speeds)
  const speedFactor = clamp(Math.abs(speedAlong) / DRIVE.maxSpeed, 0, 1);
  const torqueScale = 0.45 + speedFactor * 0.55;
  const steerSign = speedAlong < -0.45 ? -1 : 1; // flip when reversing to match joystick feel
  rb.applyTorqueImpulse({ x: 0, y: -ax * steerSign * DRIVE.steerTorque * torqueScale * traction, z: 0 }, true);

  // Toy-like sideways grip cheat
  const sideSpeed = vel.dot(right);
  const sideMagnitude = Math.abs(sideSpeed);
  if (sideMagnitude > 0.02 && traction > 0.01) {
    const gripScale = clamp(sideMagnitude / 6.5, 0.25, traction);
    const sideImpulse = right.clone().multiplyScalar(-sideSpeed * DRIVE.sideGrip * gripScale);
    const maxSideImpulse = DRIVE.sideGrip * dt * 8;
    const sideLen = sideImpulse.length();
    if (sideLen > maxSideImpulse) sideImpulse.multiplyScalar(maxSideImpulse / sideLen);
    rb.applyImpulse(sideImpulse, true);
  }

  // Extra downforce to keep the toy planted and stop "flying" antics
  const downForce = playerGrounded ? clamp(vel.length() * 0.28, 0, 6) : 0.8;
  rb.applyImpulse({ x: 0, y: -downForce * dt, z: 0 }, true);

  // Extra yaw/roll stabilizer to keep toy car planted
  const ang = rb.angvel();
  if (Math.abs(ang.x) + Math.abs(ang.y) + Math.abs(ang.z) > 0.01) {
    rb.applyTorqueImpulse({ x: -ang.x * 0.035, y: -ang.y * 0.08, z: -ang.z * 0.035 }, true);
  }
  if (Math.abs(ang.y) > DRIVE.yawRateLimit) {
    rb.setAngvel({ x: ang.x * 0.6, y: Math.sign(ang.y) * DRIVE.yawRateLimit, z: ang.z * 0.6 }, true);
  }

  const speed = vel.length();
  const forwardMax = speedAlong >= 0 ? DRIVE.maxSpeed : DRIVE.maxReverse;
  if (speed > forwardMax + 0.35) {
    const over = speed - forwardMax;
    const clampFactor = over * DRIVE.speedClamp;
    const clampImpulse = vel.clone().normalize().multiplyScalar(clampFactor);
    rb.applyImpulse(clampImpulse.multiplyScalar(-1), true);
  }

  // Skid dust
  if (skidCooldown <= 0 && Math.abs(sideSpeed) > DRIVE.skidSideThreshold && Math.abs(speedAlong) > DRIVE.skidMinSpeed) {
    const pos = rb.translation();
    spawnSkid(new THREE.Vector3(pos.x, pos.y + 0.05, pos.z), right.clone(), clamp(Math.abs(sideSpeed) / 8, 0.2, 1));
    skidCooldown = 0.08;
  }
  skidCooldown = Math.max(0, skidCooldown - dt);

  car.userData.lastSpeed = speedAlong;
  car.userData.lastTargetSpeed = ay * (ay >= 0 ? DRIVE.maxSpeed : DRIVE.maxReverse);
  const braking = (speedAlong > 0.4 && ay < 0) || (Math.abs(speedAlong) > 0.6 && Math.abs(ay) < 0.05);
  car.userData.brakeActive = braking || ay < -0.2;
  car.userData.applyLights?.(car.userData.brakeActive);
}

function capturePreviousTransforms() {
  dynamicBodies.forEach((rb) => {
    const t = rb.translation();
    const r = rb.rotation();
    previousTransforms.set(rb.handle, {
      position: new THREE.Vector3(t.x, t.y, t.z),
      quaternion: new THREE.Quaternion(r.x, r.y, r.z, r.w),
    });
  });
}

function syncPhysicsToMeshes(alpha = 1) {
  const blend = clamp(alpha, 0, 1);
  dynamicBodies.forEach((rb) => {
    const mesh = rigidMeshes.get(rb.handle);
    if (!mesh) return;
    const t = rb.translation();
    const r = rb.rotation();
    const currentPos = new THREE.Vector3(t.x, t.y, t.z);
    const currentQuat = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    const prev = previousTransforms.get(rb.handle);

    if (prev && blend < 0.999) {
      mesh.position.copy(prev.position).lerp(currentPos, blend);
      mesh.quaternion.copy(prev.quaternion).slerp(currentQuat, blend);
    } else {
      mesh.position.copy(currentPos);
      mesh.quaternion.copy(currentQuat);
    }

    if (mesh === car) {
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(currentQuat);
      const vel = rb.linvel();
      const speed = forward.dot(new THREE.Vector3(vel.x, vel.y, vel.z));
      const rollDelta = (speed / (car.userData.wheelRadius || 1)) * lastPhysicsDt;
      const steerVisual = clamp(-inputX, -1, 1) * (Math.PI / 7);
      applyWheelPose(car, steerVisual, rollDelta);
    }
  });
}

function applyCollisionImpulse(rb1, rb2, normal, friction = 0.8, restitution = 0.2) {
  const v1 = rb1.linvel();
  const v2 = rb2.linvel();
  const relVel = new THREE.Vector3(v1.x - v2.x, v1.y - v2.y, v1.z - v2.z);
  const normalSpeed = relVel.dot(normal);
  if (normalSpeed > 0) return;

  const m1 = rb1.isDynamic() ? rb1.mass() : Infinity;
  const m2 = rb2.isDynamic() ? rb2.mass() : Infinity;
  const invMass1 = rb1.isDynamic() ? 1 / Math.max(m1, 0.0001) : 0;
  const invMass2 = rb2.isDynamic() ? 1 / Math.max(m2, 0.0001) : 0;
  const invSum = invMass1 + invMass2;
  if (invSum === 0) return;

  const impulseMag = (-(1 + restitution) * normalSpeed) / invSum;
  const impulse = normal.clone().multiplyScalar(impulseMag);
  if (rb1.isDynamic()) rb1.applyImpulse(impulse, true);
  if (rb2.isDynamic()) rb2.applyImpulse(impulse.clone().multiplyScalar(-1), true);

  const tangent = relVel.clone().sub(normal.clone().multiplyScalar(normalSpeed));
  if (tangent.lengthSq() > 1e-6) {
    tangent.normalize();
    const jt = -relVel.dot(tangent) / invSum;
    const maxFriction = impulseMag * friction;
    const jtClamped = clamp(jt, -maxFriction, maxFriction);
    const frictionImpulse = tangent.multiplyScalar(jtClamped);
    if (rb1.isDynamic()) rb1.applyImpulse(frictionImpulse, true);
    if (rb2.isDynamic()) rb2.applyImpulse(frictionImpulse.clone().multiplyScalar(-1), true);
  }
}

function updateGroundState(c1, c2, started) {
  const playerCollider = playerPhysics.collider;
  if (!playerCollider) return;
  if (c1?.handle === playerCollider.handle || c2?.handle === playerCollider.handle) {
    if (started) playerGroundContacts += 1;
    else playerGroundContacts = Math.max(0, playerGroundContacts - 1);
    playerGrounded = playerGroundContacts > 0;
    if (car) car.userData.grounded = playerGrounded;
  }
}

function processCollisions() {
  eventQueue.drainCollisionEvents((h1, h2, started) => {
    const c1 = world.getCollider(h1);
    const c2 = world.getCollider(h2);
    const rb1 = c1 ? world.getRigidBody(c1.parent()) : null;
    const rb2 = c2 ? world.getRigidBody(c2.parent()) : null;
    if (!rb1 || !rb2) return;

    updateGroundState(c1, c2, started);
    if (!started) return;

    const pair = world.contactPair(c1, c2);
    const normal = new THREE.Vector3();
    if (pair?.manifolds?.length) {
      const n = pair.manifolds[0].normal();
      if (n) normal.set(n.x, n.y, n.z).normalize();
    }
    if (normal.lengthSq() === 0) {
      const t1 = rb1.translation();
      const t2 = rb2.translation();
      normal.set(t2.x - t1.x, t2.y - t1.y, t2.z - t1.z).normalize();
    }

    const friction = Math.min(c1?.friction?.() ?? 0.9, c2?.friction?.() ?? 0.9);
    const restitution = Math.max(c1?.restitution?.() ?? 0.18, c2?.restitution?.() ?? 0.18);
    applyCollisionImpulse(rb1, rb2, normal, friction, restitution);

    const v1 = rb1.linvel();
    const v2 = rb2.linvel();
    const relVel = new THREE.Vector3(v1.x - v2.x, v1.y - v2.y, v1.z - v2.z);
    const impactStrength = clamp(relVel.length() * 0.16, 0, 2);
    if (impactStrength < 0.18) return;

    let contactPoint = new THREE.Vector3();
    if (pair && pair.manifolds?.length) {
      const first = pair.manifolds[0];
      if (first?.contacts?.length) {
        const p = first.contacts[0].point();
        contactPoint.set(p.x, p.y, p.z);
      }
    }
    if (contactPoint.lengthSq() === 0) {
      const t1 = rb1.translation();
      const t2 = rb2.translation();
      contactPoint.set((t1.x + t2.x) / 2, (t1.y + t2.y) / 2, (t1.z + t2.z) / 2);
    }
    spawnImpact(contactPoint, impactStrength);
  });
}

function updateCamera(dt) {
  if (!car) return;
  const desired = CAMERA.offset.clone().applyQuaternion(car.quaternion).add(car.position);
  camera.position.lerp(desired, 1 - Math.pow(0.001, dt));
  camera.up.set(0, 1, 0);
  const look = CAMERA.lookAhead.clone().applyQuaternion(car.quaternion).add(car.position);

  if (cameraShake > 0.0001) {
    const shakeVec = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)
      .multiplyScalar(cameraShake);
    camera.position.add(shakeVec);
    look.add(shakeVec.clone().multiplyScalar(0.5));
    cameraShake = Math.max(0, cameraShake - dt * CAMERA.shakeDecay);
  }

  camera.lookAt(look);
}

function stepPhysics(dt) {
  lastPhysicsDt = dt;
  applyPlayerForces(dt);
  world.step(eventQueue);
  processCollisions();
}

function updateParticles(dt) {
  impactParticles.update(dt, 9.8 * 0.4);
  skidParticles.update(dt, 9.8 * 0.25);
}

function tick(now) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  if (NETWORK.mode === "offline" && offlineWorldReady) {
    accumulator = Math.min(accumulator + dt, MAX_ACCUM);

    if (accumulator >= FIXED_DT) {
      capturePreviousTransforms();
      while (accumulator >= FIXED_DT) {
        stepPhysics(FIXED_DT);
        accumulator -= FIXED_DT;
      }
    }

    const alpha = accumulator / FIXED_DT;
    syncPhysicsToMeshes(alpha);
  } else {
    accumulator = 0;
  }

  if (NETWORK.mode === "online") {
    applySnapshotInterpolation();
  }

  const blendDt = dt; // rendering dt for visuals
  updateCamera(blendDt);

  const rearStatus = updateRearLights(
    car?.userData.rearLights,
    blendDt,
    car?.userData.lastSpeed || 0,
    car?.userData.lastTargetSpeed || 0,
    inputY,
    car?.userData.lightsOn
  );

  const braking = rearStatus?.braking ?? false;
  if (car) {
    car.userData.brakeActive = braking;
    car.userData.applyLights?.(car.userData.brakeActive);
  }

  if (NETWORK.mode === "offline") {
    updateRemotePlayers(blendDt);
  }

  if (NETWORK.mode === "online") {
    sendInput();
  }

  updateParticles(blendDt);
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

async function startGame() {
  makeGroundAndBounds();
  await setupPlayerCar();
  const onlineAttempt = await initNetwork();
  if (!onlineAttempt && !offlineWorldReady) {
    ensureOfflineWorld();
  }
  requestAnimationFrame(tick);
}
startGame();

// Resize
function onResize() {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", onResize);
window.addEventListener("orientationchange", onResize);
onResize();
