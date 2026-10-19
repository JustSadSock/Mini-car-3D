import * as THREE from "three";
import { createDrivingChallenge } from "./challenge.js";
import { createVehicleDynamics, normalizeWheels, SURFACES, SURFACE_PATCHES, TUNING } from "./vehicle-physics.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import RAPIER from "https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.12.0/rapier.es.js";

// --- Hard stop for iOS pinch / double-tap zoom antics ---
document.addEventListener("gesturestart", (e) => e.preventDefault(), { passive: false });
document.addEventListener("gesturechange", (e) => e.preventDefault(), { passive: false });
document.addEventListener("gestureend", (e) => e.preventDefault(), { passive: false });
// Global touch cancellation removed: it suppressed genuine mobile button taps.

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
  lastSend: 0
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
const tempVec3 = new THREE.Vector3();
const tempQuat = new THREE.Quaternion();

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
renderer.useLegacyLights = false;
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
// Grip patches are both visible surfaces and queried by each tire in physics.
SURFACE_PATCHES.forEach(patch => {
  const kind = SURFACES[patch.type];
  const tile = new THREE.Mesh(new THREE.PlaneGeometry(patch.width, patch.depth),
    new THREE.MeshStandardMaterial({color:kind.color,
      roughness:patch.type === "ice" ? 0.17 : 0.91,
      metalness:patch.type === "ice" ? 0.23 : 0,
      transparent:true, opacity:patch.type === "ice" ? 0.95 : 0.87,
      depthWrite:false, polygonOffset:true, polygonOffsetFactor:-1}));
  tile.rotation.x=-Math.PI/2;
  tile.position.set(patch.x,0.025,patch.z);
  tile.receiveShadow=true;
  scene.add(tile);
});
const challenge = createDrivingChallenge(THREE, scene);

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

function makeGroundAndBounds() {
  const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const groundCollider = world.createCollider(
    RAPIER.ColliderDesc.cuboid(110, 0.1, 110)
      .setTranslation(0, -0.05, 0)
      .setFriction(0.28) // tires provide grip, not the flat ground collider
      .setRestitution(0.04), // stable physical suspension
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
  }
  return meshes;
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
      basePivotPosition: pivot.position.clone(),
      localPosition: root.worldToLocal(mesh.getWorldPosition(new THREE.Vector3())),
      suspensionVisual: 0,
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
  if (!isPlayer) headlightRig.left.castShadow = false;
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

    // Rear lights update once per frame (not twice via applyLights).
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
          .setLinearDamping(0.24) // coasting is determined by tire forces
          .setAngularDamping(1.25) // retain believable angular motion
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
      .setFriction(0.18) // chassis no longer supplies unlimited grip
      .setRestitution(0.08) // no rubber-ball landing
      .setDensity(0.72);
    const collider = world.createCollider(colliderDesc, rb);
    registerBody(rb, car, collider, { type: isPlayer ? "car" : "car-remote", dynamic: true });
    car.userData.physics = { body: rb, collider };
    if (isPlayer) {
      playerPhysics.body = rb;
      playerPhysics.collider = collider;
      // Four reliable chassis-mounted spring points, aligned to real GLB wheels.
      const candidates = wheelRig.map(w => w.localPosition);
      const chassisBottom = (center.y - car.position.y - size.y * 0.08) - halfY;
      const tireRadius = THREE.MathUtils.clamp(radius, 0.15, Math.max(0.28, halfY * 0.85));
      const anchors = normalizeWheels(candidates, halfX * 0.78,
        halfZ * 0.82, chassisBottom + tireRadius - 0.08);
      playerPhysics.controller = createVehicleDynamics({
        RAPIER, THREE, world, body:rb, collider, wheelRadius:tireRadius, wheelPoints:anchors
      });
    }
    car.position.copy(startPos);
  }

  return car;
}

async function setupPlayerCar() {
  car = await makeCar(true, true, getSafeSpawnTransform(NETWORK.id || "local"));
  scene.add(car);
  ensureLocalColor();
}


// --- Multiplayer (online/offline aware) ---
const remotePlayers = new Map();

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

function disposeRemoteCar(mesh) {
  if (!mesh) return;
  const rb = mesh.userData.physics?.body;
  if (rb) {
    dynamicBodies.delete(rb);
    rigidMeshes.delete(rb.handle);
    previousTransforms.delete(rb.handle);
    const collider = mesh.userData.physics?.collider;
    if (collider) colliderMetadata.delete(collider.handle);
    world.removeRigidBody(rb);
  }
  scene.remove(mesh);
  // GLTF clone shares geometry and textures with other cars; do not dispose either.
  mesh.traverse((child) => {
    const materials = child.material ? (Array.isArray(child.material) ? child.material : [child.material]) : [];
    materials.forEach((material) => material.dispose?.());
  });
}

async function spawnRemotePlayer(id, snapshot) {
  if (remotePlayers.has(id)) {
    if (snapshot) applyRemoteState(id, snapshot);
    return;
  }
  const initialState = snapshot || buildSafeSpawnState(id);
  const placeholder = { mesh: null, target: null, loading: true, latestState: initialState };
  remotePlayers.set(id, placeholder);
  const spawnTransform = Array.isArray(initialState.p)
    ? { position: new THREE.Vector3(initialState.p[0] || 0, initialState.p[1] || 0, initialState.p[2] || 0), yaw: initialState.y || 0 }
    : getSafeSpawnTransform(id);
  try {
    const ghost = await makeCar(false, true, spawnTransform);
    if (remotePlayers.get(id) !== placeholder) {
      disposeRemoteCar(ghost);
      return;
    }
    colorizeCar(ghost, id);
    ghost.userData.isRemote = true;
    ghost.userData.applyLights?.(false);
    scene.add(ghost);
    placeholder.mesh = ghost;
    placeholder.loading = false;
    applyRemoteState(id, placeholder.latestState);
  } catch (err) {
    if (remotePlayers.get(id) === placeholder) remotePlayers.delete(id);
    throw err;
  }
}

function removeRemotePlayer(id) {
  const player = remotePlayers.get(id);
  if (!player) return;
  remotePlayers.delete(id);
  disposeRemoteCar(player.mesh);
}

function clearRemotePlayers() {
  for (const id of Array.from(remotePlayers.keys())) removeRemotePlayer(id);
}

function applyRemoteState(id, state) {
  const player = remotePlayers.get(id);
  if (!player || !state) return;
  player.latestState = state;
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
  const override = new URLSearchParams(location.search).get("server");
  if (override && /^[a-z0-9.:-]+$/i.test(override)) return override;
  if (location.hostname === "localhost" || location.hostname === "127.0.0.1") return location.host;
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

function sendStateSnapshot() {
  if (!NETWORK.socket || NETWORK.socket.readyState !== WebSocket.OPEN) return;
  if (!car) return;
  const now = performance.now();
  if (now - NETWORK.lastSend < 50) return; // ~20 Hz
  NETWORK.lastSend = now;
  const yaw = car.rotation.y;
  const speed = car.userData.lastSpeed || 0;
  const steerVisual = clamp(inputX, -1, 1) * TUNING.axleSteer;
  const payload = {
    type: "state",
    state: {
      p: [Number(car.position.x.toFixed(3)), Number(car.position.y.toFixed(3)), Number(car.position.z.toFixed(3))],
      y: Number(yaw.toFixed(4)),
      s: Number(speed.toFixed(3)),
      st: Number(steerVisual.toFixed(4)),
      b: Boolean(car.userData.brakeActive)
    }
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

  if (data.type === "hello") {
    NETWORK.id = data.id;
    setNetStatus(`Online: ${resolveServerHost()}`, true);
    ensureLocalColor();
    if (Array.isArray(data.players)) {
      data.players.forEach((p) => {
        if (!remotePlayers.has(p.id)) spawnRemotePlayer(p.id, p.state).catch((err) => console.warn("Remote spawn failed", err));
        else applyRemoteState(p.id, p.state);
      });
    }
    sendStateSnapshot();
  } else if (data.type === "state" && data.id && data.id !== NETWORK.id) {
    if (!remotePlayers.has(data.id)) spawnRemotePlayer(data.id, data.state).catch((err) => console.warn("Remote spawn failed", err));
    else applyRemoteState(data.id, data.state);
  } else if (data.type === "player-left" && data.id) {
    removeRemotePlayer(data.id);
  } else if (data.type === "player-joined" && data.id && data.id !== NETWORK.id) {
    if (!remotePlayers.has(data.id)) spawnRemotePlayer(data.id, buildSafeSpawnState(data.id)).catch((err) => console.warn("Remote spawn failed", err));
  }
}

async function initNetwork() {
  cleanSocket();
  const host = resolveServerHost();
  const available = await checkServerAvailability(host);
  if (!available) {
    NETWORK.mode = "offline";
    setNetStatus("Offline режим (сервер недоступен)", false);
    scheduleReconnect();
    return;
  }

  const protocol = host.includes("localhost") || host.includes("127.0.0.1") ? "ws" : "wss";
  const ws = new WebSocket(`${protocol}://${host}/ws`);
  ws.addEventListener("open", () => {
    NETWORK.socket = ws;
    NETWORK.mode = "online";
    NETWORK.lastSend = 0;
    setNetStatus(`Online: ${host}`, true);
    sendStateSnapshot();
  });
  ws.addEventListener("message", handleMessage);
  ws.addEventListener("close", () => {
    if (NETWORK.socket !== ws) return;
    NETWORK.mode = "offline";
    setNetStatus("Offline режим (нет соединения)", false);
    NETWORK.socket = null;
    NETWORK.id = null;
    clearRemotePlayers();
    scheduleReconnect();
  });
  ws.addEventListener("error", () => {
    setNetStatus("Offline режим (ошибка связи)", false);
  });
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
  if (joyActive) return;
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
joy.addEventListener("lostpointercapture", releaseJoy);
window.addEventListener("blur", () => { releaseJoy(); keys.clear(); });
document.addEventListener("visibilitychange", () => { if (document.hidden) { releaseJoy(); keys.clear(); } });

// Keyboard fallback (PC)
const keys = new Set();
window.addEventListener("keydown", (e) => {
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) e.preventDefault();
  keys.add(e.code);
  if (!e.repeat && e.code === "KeyR") resetCar();
  if (!e.repeat && e.code === "KeyL") toggleLights();
  if (!e.repeat && e.code === "KeyF") recoverCar();
  if (!e.repeat && e.code === "KeyP") toggleDiagnostics();
});
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
  // Model headlights face +Z; W/up and joystick-up must accelerate +Z.
  return { x, y };
}

// --- Physics driving ---
const playerPhysics = { body: null, collider: null, controller: null, telemetry: null };
let renderFrameDt = FIXED_DT;
let carRecoveryHint = "";
let recoveryTimer = 0;
let diagnosticEnabled = false;
let collisionCooldown = 0;
const collisionVelocities = new Map();
let inputX = 0;
let inputY = 0;
let accumulator = 0;
let last = performance.now();
let cameraShake = 0;
const previousTransforms = new Map();
let lastPhysicsDt = FIXED_DT;

const DRIVE = {
  engineImpulse: 5.6,  // raise for snappier acceleration (arcade)
  steerTorque: 0.64,   // raise for faster yaw response
  maxSpeed: 10.2,      // forward top speed (swap with reverse for request)
  maxReverse: 24.0,    // reverse top speed (faster per request)
  speedClamp: 0.3,     // higher = stronger speed cap impulse
  sideGrip: 1.7,       // higher = less drift
  ccd: true,
  skidSideThreshold: 3.4,
  skidMinSpeed: 4.6,
};

const CAMERA = {
  offset: new THREE.Vector3(0, 6.0, -12.0),
  lookAhead: new THREE.Vector3(0, 1.2, 6.5),
  shakeDecay: 3.8,
};

function resetCar() {
  const rb = playerPhysics.body;
  if (!car || !rb) return;
  const spawn = getSafeSpawnTransform(NETWORK.id || "local");
  rb.setTranslation(spawn.position, true);
  rb.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
  rb.setLinvel({ x: 0, y: 0, z: 0 }, true);
  rb.setAngvel({ x: 0, y: 0, z: 0 }, true);
  car.position.copy(spawn.position);
  car.quaternion.identity();
  previousTransforms.delete(rb.handle);
  inputX = inputY = 0;
  releaseJoy();
  playerPhysics.controller?.reset();
  playerPhysics.telemetry = null;
  recoveryTimer = 0;
  carRecoveryHint = "";
  cameraShake = 0;
  camera.position.copy(CAMERA.offset).add(car.position);
  challenge.reset();
  updateDrivingHud(1);
}

function recoverCar() {
  const rb=playerPhysics.body;
  if(!car||!rb)return;
  const p=rb.translation();
  const r=rb.rotation();
  const planar=new THREE.Vector3(0,0,1).applyQuaternion(
    new THREE.Quaternion(r.x,r.y,r.z,r.w));
  const yaw=Math.atan2(planar.x,planar.z);
  const spawn=getSafeSpawnTransform(NETWORK.id||"local").position;
  const outside=Math.abs(p.x)>101||Math.abs(p.z)>101;
  const destination=outside ? spawn : {
    x:p.x,y:Math.max(1.8,Math.min(p.y+1.2,4)),z:p.z
  };
  const q=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),
    Number.isFinite(yaw)?yaw:0);
  rb.setTranslation(destination,true);
  rb.setRotation({x:q.x,y:q.y,z:q.z,w:q.w},true);
  rb.setLinvel({x:0,y:0,z:0},true);
  rb.setAngvel({x:0,y:0,z:0},true);
  car.position.set(destination.x,destination.y,destination.z);
  car.quaternion.copy(q);
  previousTransforms.delete(rb.handle);
  playerPhysics.controller?.reset();
  inputX=inputY=0;
  releaseJoy();
  recoveryTimer=0;
  carRecoveryHint="";
}
function toggleDiagnostics() {
  diagnosticEnabled=!diagnosticEnabled;
  document.getElementById("physicsDebug").hidden=!diagnosticEnabled;
  document.getElementById("physicsBtn").setAttribute("aria-pressed",String(diagnosticEnabled));
}
function toggleLights() {
  if (!car) return;
  car.userData.setLights?.(!car.userData.lightsOn);
  document.getElementById("lightsBtn").setAttribute("aria-pressed", String(car.userData.lightsOn));
}
document.getElementById("resetBtn").addEventListener("click", resetCar);
document.getElementById("recoverBtn").addEventListener("click", recoverCar);
document.getElementById("physicsBtn").addEventListener("click", toggleDiagnostics);
document.getElementById("lightsBtn").addEventListener("click", toggleLights);

let hudClock = 0;
function updateDrivingHud(dt) {
  hudClock += dt;
  if (hudClock < 0.1) return;
  hudClock = 0;
  const s = challenge.getState();
  document.getElementById("speedValue").textContent = String(Math.round(Math.abs(car?.userData.lastSpeed || 0) * 3.6));
  document.getElementById("courseStatus").textContent = s.finished ? "ФИНИШ · Новый круг" :
    (s.running ? `Ворота ${s.next}/${s.total} · ${s.time.toFixed(1)} с` : `Ворота ${s.next}/${s.total} · Старт`);
  document.getElementById("recordValue").textContent = s.best ? `${s.best.toFixed(2)} с` : "—";
  const state=playerPhysics.telemetry;
  document.getElementById("surfaceStatus").textContent = carRecoveryHint ||
    (!state || !state.grounded ? "В ВОЗДУХЕ" :
      `${SURFACES[state.surface]?.label || "ПОВЕРХНОСТЬ"} · ${state.contacts}/4`);
  if(diagnosticEnabled) {
    const springs=playerPhysics.controller?.getCompression() || [];
    document.getElementById("physicsDebug").textContent =
      `Опоры: ${state?.contacts || 0}/4 · сцепление: ${(state?.grip || 0).toFixed(2)} · ` +
      `снос: ${(state?.slip || 0).toFixed(2)} м/с · ` +
      `ход пружин: ${springs.map(n=>(n*100).toFixed(0)).join(" / ")} см`;
  }
}

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
  const controller = playerPhysics.controller;
  if (!car || !rb || !controller) return;
  // Both inputs use the same frame: +Z throttle, +X right steering.
  const axes = joyActive && isCoarsePointer ? {x:joyX,y:joyY} : keyboardAxes();
  const ax = Math.abs(axes.x) < 0.06 ? 0 : axes.x;
  const ay = Math.abs(axes.y) < 0.06 ? 0 : axes.y;
  inputX = approach(inputX, ax, dt * 6.5);
  inputY = approach(inputY, ay, dt * 6.5);

  const state = controller.step(dt, inputX, inputY);
  playerPhysics.telemetry = state;
  car.userData.lastSpeed = state.speed;
  car.userData.lastTargetSpeed = inputY * (inputY >= 0
    ? TUNING.forwardLimit : TUNING.reverseLimit);
  const braking = (state.speed > 0.5 && inputY < -0.15) ||
    (state.speed < -0.5 && inputY > 0.15);
  car.userData.brakeActive = braking;
  car.userData.applyLights?.(braking);

  if (state.grounded && state.slip > DRIVE.skidSideThreshold &&
      Math.abs(state.speed) > DRIVE.skidMinSpeed && skidCooldown <= 0) {
    const pos = rb.translation();
    const quat = rb.rotation();
    const lateral = new THREE.Vector3(1,0,0).applyQuaternion(
      new THREE.Quaternion(quat.x,quat.y,quat.z,quat.w));
    spawnSkid(new THREE.Vector3(pos.x, Math.max(.06,pos.y-.32),pos.z),
      lateral,clamp(state.slip/7,.2,1));
    skidCooldown=.085;
  }
  skidCooldown = Math.max(0,skidCooldown-dt);

  const r=rb.rotation();
  const upright=new THREE.Vector3(0,1,0).applyQuaternion(
    new THREE.Quaternion(r.x,r.y,r.z,r.w)).y;
  const p=rb.translation();
  const upsideDown=upright < .25 && Math.abs(state.speed)<1.5;
  const stuck=state.grounded && Math.abs(state.speed)<.3 && Math.abs(inputY)>.8;
  recoveryTimer=(upsideDown||stuck) ? recoveryTimer+dt : 0;
  carRecoveryHint=recoveryTimer>2.5 ? "ЗАСТРЯЛИ? F / ПОДНЯТЬ" : "";
  if(p.y < -8 || Math.abs(p.x)>115 || Math.abs(p.z)>115) recoverCar();
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
      const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(currentQuat);
      const vel = rb.linvel();
      const speed = forward.dot(new THREE.Vector3(vel.x, vel.y, vel.z));
      const rollDelta = (speed / (car.userData.wheelRadius || 1)) * renderFrameDt;
      const steerVisual = clamp(inputX, -1, 1) * TUNING.axleSteer;
      applyWheelPose(car, steerVisual, rollDelta);
      const compression = playerPhysics.controller?.getCompression() || [];
      (car.userData.wheelRig || []).forEach(wheel => {
        const index = (wheel.localPosition.z >= 0 ? 0 : 2) + (wheel.localPosition.x > 0 ? 1 : 0);
        const target = compression[index] || 0;
        wheel.suspensionVisual += (target - wheel.suspensionVisual) * (1-Math.exp(-12*renderFrameDt));
        const pivot = wheel.pivot || wheel.mesh;
        pivot.position.y = wheel.basePivotPosition.y + wheel.suspensionVisual * 0.42;
      });
    }
  });
}

function processCollisions() {
  eventQueue.drainCollisionEvents((h1, h2, started) => {
    if (!started) return;
    const c1 = world.getCollider(h1);
    const c2 = world.getCollider(h2);
    // Collider.parent() already returns the RigidBody, not a numeric handle.
    const rb1 = c1?.parent() || null;
    const rb2 = c2?.parent() || null;
    if (!rb1 || !rb2) return;
    // Other players and loose props must not trigger local screen shake.
    if (rb1.handle !== playerPhysics.body?.handle && rb2.handle !== playerPhysics.body?.handle) return;

    const v1 = collisionVelocities.get(rb1.handle) || rb1.linvel();
    const v2 = collisionVelocities.get(rb2.handle) || rb2.linvel();
    const relVel = new THREE.Vector3(v1.x - v2.x, v1.y - v2.y, v1.z - v2.z);
    const impactStrength = clamp((relVel.length() - 1.1) * 0.18, 0, 2);
    if (impactStrength < 0.18 || collisionCooldown > 0) return;
    collisionCooldown = 0.10;

    // Rapier 0.12 contactPair requires a callback; calling it without one
    // crashes on actual contact. Midpoint is a stable fallback for toy impacts.
    const t1 = rb1.translation();
    const t2 = rb2.translation();
    const contactPoint = new THREE.Vector3(
      (t1.x + t2.x) / 2, (t1.y + t2.y) / 2, (t1.z + t2.z) / 2
    );
    const groundHit=colliderMetadata.get(c1.handle)?.type==="ground" ||
      colliderMetadata.get(c2.handle)?.type==="ground";
    if(groundHit){
      const p=playerPhysics.body.translation();
      contactPoint.set(p.x,.09,p.z);
    }
    spawnImpact(contactPoint, impactStrength);
  });
}

function updateCamera(dt) {
  if (!car) return;
  // Keep the camera upright even when the car rolls on its side.
  const heading = new THREE.Vector3(0, 0, 1).applyQuaternion(car.quaternion);
  const yaw = Math.atan2(heading.x, heading.z);
  const yawOnly = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  const desired = CAMERA.offset.clone().applyQuaternion(yawOnly).add(car.position);
  desired.y = Math.max(2.5, desired.y);
  camera.position.lerp(desired, 1 - Math.pow(0.001, dt));
  camera.up.set(0, 1, 0);
  const look = CAMERA.lookAhead.clone().applyQuaternion(yawOnly).add(car.position);

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
  collisionVelocities.clear();
  dynamicBodies.forEach(rb => {
    const v=rb.linvel();
    collisionVelocities.set(rb.handle,{x:v.x,y:v.y,z:v.z});
  });
  applyPlayerForces(dt);
  world.step(eventQueue);
  processCollisions();
  collisionCooldown=Math.max(0,collisionCooldown-dt);
}

function updateParticles(dt) {
  impactParticles.update(dt, 9.8 * 0.4);
  skidParticles.update(dt, 9.8 * 0.25);
}

function tick(now) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  renderFrameDt = dt;
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

  updateRemotePlayers(blendDt);
  challenge.update(blendDt, car?.position, Math.abs(car?.userData.lastSpeed || 0));
  updateDrivingHud(blendDt);

  if (NETWORK.mode === "online") {
    sendStateSnapshot();
  }

  updateParticles(blendDt);
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

async function startGame() {
  makeGroundAndBounds();
  spawnProps(20);
  await setupPlayerCar();
  document.getElementById("loadOverlay").hidden = true;
  camera.position.copy(CAMERA.offset).add(car.position);
  updateDrivingHud(1);
  initNetwork();
  requestAnimationFrame(tick);
}
startGame().catch((error) => {
  console.error("Mini Car 3D startup failed", error);
  const overlay = document.getElementById("loadOverlay");
  overlay.hidden = false;
  document.getElementById("loadState").textContent = "Ошибка загрузки машины или физики. Проверьте подключение и повторите.";
  document.getElementById("retryLoad").hidden = false;
});

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
