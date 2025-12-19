const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { WebSocketServer } = require('ws');

// Physics / networking knobs
const SERVER_TICK_RATE = 60; // physics tick rate (Hz)
const SNAPSHOT_RATE = 20; // snapshot broadcast rate (Hz)
const GRAVITY = { x: 0, y: -12.8, z: 0 }; // stronger gravity = toy-like fall

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const PUBLIC_DIR = __dirname;
const WS_PATH = '/ws';

// Physics runtime (lazy loaded because server.js is CJS)
let RAPIER = null;
let world = null;
let physicsReady = null;

// Game state
const clients = new Map(); // id -> { ws, lastInput, lastSeq, bodyHandle }
const props = []; // { id, shape, size, initial:{p,q}, dynamic, bodyHandle?, colliderHandle }
const dynamicPropHandles = new Set();
let tick = 0;

// Utility
function log(...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}]`, ...args);
}

function resolveFile(filePath) {
  const cleanPath = filePath.split('?')[0];
  const targetPath = path.join(PUBLIC_DIR, cleanPath);
  if (!targetPath.startsWith(PUBLIC_DIR)) return null;
  if (fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory()) {
    return path.join(targetPath, 'index.html');
  }
  return targetPath;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

const CORS = {
  allowList(origin) {
    if (!origin) return '*';
    if (origin.endsWith('.netlify.app')) return origin;
    if (origin === 'https://mini-car-3d.netlify.app') return origin;
    return null;
  },
  headers(origin) {
    const allowed = this.allowList(origin);
    if (!allowed) return {};
    return {
      'Access-Control-Allow-Origin': allowed,
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400'
    };
  }
};

// ---- HTTP server ----
const server = http.createServer((req, res) => {
  const origin = req.headers.origin;
  const corsHeaders = CORS.headers(origin);

  if (req.method === 'OPTIONS') {
    res.writeHead(CORS.allowList(origin) ? 204 : 403, {
      ...corsHeaders,
      'Content-Length': '0'
    });
    res.end();
    return;
  }

  if (req.url === '/health') {
    if (!CORS.allowList(origin)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'CORS blocked' }));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache',
      ...corsHeaders
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const resolved = resolveFile(req.url === '/' ? '/index.html' : req.url);
  if (!resolved || !fs.existsSync(resolved)) {
    res.writeHead(404, {
      'Content-Type': 'text/plain; charset=utf-8',
      ...corsHeaders
    });
    res.end('Not found');
    return;
  }

  const ext = path.extname(resolved).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': mime,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    ...corsHeaders
  });
  fs.createReadStream(resolved).pipe(res);
});

// ---- Physics helpers ----
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quatFromEuler(yaw) {
  const half = yaw * 0.5;
  const s = Math.sin(half);
  const c = Math.cos(half);
  return { x: 0, y: s, z: 0, w: c };
}

function vectorArray(v) {
  return [v.x, v.y, v.z];
}

function quatArray(q) {
  return [q.x, q.y, q.z, q.w];
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function makeGroundAndBounds() {
  const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(110, 0.1, 110)
      .setTranslation(0, -0.05, 0)
      .setFriction(1.15) // grippy ground
      .setRestitution(0.1), // low bounce
    groundBody
  );

  const wallThickness = 2;
  const wallHeight = 4;
  const half = 110;
  const positions = [
    { x: half + wallThickness, y: wallHeight / 2, z: 0 },
    { x: -half - wallThickness, y: wallHeight / 2, z: 0 },
    { x: 0, y: wallHeight / 2, z: half + wallThickness },
    { x: 0, y: wallHeight / 2, z: -half - wallThickness }
  ];
  positions.forEach((p, idx) => {
    const sizeX = idx < 2 ? wallThickness : half + wallThickness;
    const sizeZ = idx < 2 ? half + wallThickness : wallThickness;
    const wallBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(sizeX, wallHeight / 2, sizeZ)
        .setTranslation(p.x, p.y, p.z)
        .setFriction(0.9)
        .setRestitution(0.2),
      wallBody
    );
  });
}

function createProps() {
  const rng = mulberry32(1337);
  const count = 18;
  for (let i = 0; i < count; i++) {
    const dynamic = rng() > 0.35;
    const shape = rng() > 0.6 ? 'cylinder' : 'box';
    const size = {
      x: 0.4 + rng() * 0.4,
      y: 0.35 + rng() * 0.35,
      z: 0.4 + rng() * 0.4
    };
    const initial = {
      p: [lerp(-15, 15, rng()), size.y + 0.1, lerp(-15, 15, rng())],
      q: quatArray(quatFromEuler(rng() * Math.PI * 2))
    };
    const id = `p${i}`;
    const bodyDesc = dynamic
      ? RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(initial.p[0], initial.p[1], initial.p[2])
          .setRotation({ x: initial.q[0], y: initial.q[1], z: initial.q[2], w: initial.q[3] })
          .setLinearDamping(1.2)
          .setAngularDamping(1.6)
          .setCcdEnabled(true)
      : RAPIER.RigidBodyDesc.fixed().setTranslation(initial.p[0], initial.p[1], initial.p[2]);
    const body = world.createRigidBody(bodyDesc);
    let colliderDesc;
    if (shape === 'cylinder') {
      colliderDesc = RAPIER.ColliderDesc.cylinder(size.y, size.x);
    } else if (shape === 'cone') {
      colliderDesc = RAPIER.ColliderDesc.cone(size.y, size.x);
    } else {
      colliderDesc = RAPIER.ColliderDesc.cuboid(size.x, size.y, size.z);
    }
    const collider = world.createCollider(
      colliderDesc
        .setFriction(0.9)
        .setRestitution(0.28)
        .setDensity(dynamic ? 0.6 : 1.0),
      body
    );

    props.push({ id, shape, size, initial, dynamic, bodyHandle: body.handle, colliderHandle: collider.handle });
    if (dynamic) dynamicPropHandles.add(body.handle);
  }
}

function resetPropIfOutOfBounds(prop) {
  if (!prop.dynamic) return;
  const body = world.getRigidBody(prop.bodyHandle);
  if (!body) return;
  const t = body.translation();
  if (Math.abs(t.x) > 200 || t.y < -20 || Math.abs(t.z) > 200) {
    body.setTranslation({ x: prop.initial.p[0], y: prop.initial.p[1], z: prop.initial.p[2] }, true);
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    body.setRotation({ x: prop.initial.q[0], y: prop.initial.q[1], z: prop.initial.q[2], w: prop.initial.q[3] }, true);
  }
}

function spawnPlayer(id, colorIdx = 0) {
  const spawnX = (clients.size % 4) * 4 - 4;
  const spawnZ = Math.floor(clients.size / 4) * 4 - 4;
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spawnX, 0.6, spawnZ)
      .setRotation(quatFromEuler(0))
      .setLinearDamping(3.2)
      .setAngularDamping(7.0)
      .setCcdEnabled(true)
  );
  const collider = world.createCollider(
    RAPIER.ColliderDesc.cuboid(0.9, 0.4, 1.6)
      .setFriction(1.2)
      .setRestitution(0.3)
      .setDensity(0.7),
    body
  );
  collider.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
  clients.set(id, {
    ws: null,
    colorId: colorIdx,
    bodyHandle: body.handle,
    colliderHandle: collider.handle,
    lastInput: { steer: 0, throttle: 0, brake: false },
    lastSeq: 0,
    lastSeen: Date.now()
  });
}

function removePlayer(id) {
  const entry = clients.get(id);
  if (!entry) return;
  if (entry.bodyHandle !== undefined) {
    const body = world.getRigidBody(entry.bodyHandle);
    if (body) {
      world.removeRigidBody(body);
    }
  }
  clients.delete(id);
}

function playerSnapshot(id) {
  const entry = clients.get(id);
  if (!entry) return null;
  const body = world.getRigidBody(entry.bodyHandle);
  if (!body) return null;
  const t = body.translation();
  const q = body.rotation();
  const lv = body.linvel();
  const av = body.angvel();
  return {
    id,
    p: vectorArray(t),
    q: quatArray(q),
    lv: vectorArray(lv),
    av: vectorArray(av)
  };
}

function propSnapshot(prop) {
  const body = world.getRigidBody(prop.bodyHandle);
  if (!body) return null;
  const t = body.translation();
  const q = body.rotation();
  const lv = body.linvel();
  const av = body.angvel();
  return {
    id: prop.id,
    p: vectorArray(t),
    q: quatArray(q),
    lv: vectorArray(lv),
    av: vectorArray(av)
  };
}

function applyInputs(dt) {
  for (const [id, client] of clients.entries()) {
    if (!client.ws || client.ws.readyState !== client.ws.OPEN) continue;
    const body = world.getRigidBody(client.bodyHandle);
    if (!body) continue;
    const input = client.lastInput;
    const transform = body.rotation();
    const fwd = {
      x: 2 * (transform.x * transform.z + transform.w * transform.y),
      y: 2 * (transform.y * transform.z - transform.w * transform.x),
      z: 1 - 2 * (transform.x * transform.x + transform.y * transform.y)
    };
    const right = {
      x: 1 - 2 * (transform.y * transform.y + transform.z * transform.z),
      y: 2 * (transform.x * transform.y + transform.w * transform.z),
      z: 2 * (transform.x * transform.z - transform.w * transform.y)
    };

    const engineForce = 18;
    const steerStrength = 0.6;
    const brakeStrength = 14;
    const sideGrip = 6.4; // higher = less lateral drift
    const maxYaw = 3.0;

    const throttle = clamp(input.throttle || 0, -1, 1);
    const steer = clamp(input.steer || 0, -1, 1);
    const braking = Boolean(input.brake);

    body.applyImpulse({ x: fwd.x * engineForce * throttle * dt, y: fwd.y * engineForce * throttle * dt, z: fwd.z * engineForce * throttle * dt }, true);
    const speed = body.linvel();
    const speedMag = Math.hypot(speed.x, speed.y, speed.z);
    const steerScale = 1 - Math.min(speedMag / 14, 1) * 0.6;
    body.applyTorqueImpulse({ x: 0, y: steerStrength * steer * steerScale * dt, z: 0 }, true);

    if (braking) {
      const lv = body.linvel();
      body.applyImpulse({ x: -lv.x * brakeStrength * dt, y: -lv.y * 0.5 * dt, z: -lv.z * brakeStrength * dt }, true);
    }

    // Simple sideways friction to keep toy feel stable
    const lv = body.linvel();
    const lateral = lv.x * right.x + lv.y * right.y + lv.z * right.z;
    const sideImpulse = { x: -right.x * lateral * sideGrip * dt, y: -right.y * lateral * sideGrip * 0.4 * dt, z: -right.z * lateral * sideGrip * dt };
    const sideLen = Math.hypot(sideImpulse.x, sideImpulse.y, sideImpulse.z);
    const maxSide = sideGrip * dt * 8;
    const scale = sideLen > maxSide ? maxSide / sideLen : 1;
    body.applyImpulse({ x: sideImpulse.x * scale, y: sideImpulse.y * scale, z: sideImpulse.z * scale }, true);

    // Downforce + yaw clamp
    const downForce = Math.min(speedMag * 0.35, 8);
    body.applyImpulse({ x: 0, y: -downForce * dt, z: 0 }, true);
    const ang = body.angvel();
    if (Math.abs(ang.y) > maxYaw) {
      body.setAngvel({ x: ang.x * 0.6, y: Math.sign(ang.y) * maxYaw, z: ang.z * 0.6 }, true);
    }
  }
}

function buildSnapshot(targetId = null) {
  const payload = {
    type: 'snapshot',
    tick,
    serverTime: Date.now(),
    ack: targetId ? { id: targetId, lastSeq: clients.get(targetId)?.lastSeq || 0 } : undefined,
    players: [],
    props: []
  };

  for (const id of clients.keys()) {
    const snap = playerSnapshot(id);
    if (snap) payload.players.push(snap);
  }

  for (const prop of props) {
    if (!prop.dynamic) continue;
    const snap = propSnapshot(prop);
    if (snap) payload.props.push(snap);
  }

  return payload;
}

async function initPhysics() {
  if (physicsReady) return physicsReady;
  physicsReady = (async () => {
    try {
      RAPIER = (await import('@dimforge/rapier3d-compat')).default;
    } catch (err) {
      log('Failed to load @dimforge/rapier3d-compat. Did you run "npm install"?', err?.message || err);
      throw err;
    }
    await RAPIER.init();
    world = new RAPIER.World(GRAVITY);
    makeGroundAndBounds();
    createProps();
    return true;
  })();
  return physicsReady;
}

// ---- WebSocket server ----
const wss = new WebSocketServer({ server, path: WS_PATH, clientTracking: true, perMessageDeflate: false });

async function handleConnection(ws) {
  await initPhysics();
  const id = randomUUID();
  spawnPlayer(id, clients.size % 8);
  const entry = clients.get(id);
  entry.ws = ws;
  entry.lastSeen = Date.now();

  log('client connected', id, 'total:', clients.size);

  const existingPlayers = [];
  for (const [pid] of clients.entries()) {
    if (pid === id) continue;
    const snap = playerSnapshot(pid);
    if (snap) existingPlayers.push({ id: pid, colorId: clients.get(pid)?.colorId || 0, initial: { p: snap.p, q: snap.q } });
  }

  ws.send(JSON.stringify({
    type: 'welcome',
    id,
    tickRate: SERVER_TICK_RATE,
    snapshotRate: SNAPSHOT_RATE,
    props: props.map((p) => ({ id: p.id, shape: p.shape, size: p.size, initial: p.initial, dynamic: p.dynamic })),
    players: existingPlayers,
    serverTime: Date.now()
  }));

  broadcast({ type: 'player-joined', id, initial: playerSnapshot(id) }, id);

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch (err) {
      log('invalid json from', id, err.message);
      return;
    }

    if (data.type === 'input') {
      const client = clients.get(id);
      if (!client) return;
      client.lastInput = {
        steer: Number(data.steer) || 0,
        throttle: Number(data.throttle) || 0,
        brake: Boolean(data.brake)
      };
      client.lastSeq = typeof data.seq === 'number' ? data.seq : client.lastSeq;
      client.lastSeen = Date.now();
    }
  });

  ws.on('close', () => {
    removePlayer(id);
    broadcast({ type: 'player-left', id }, id);
    log('client disconnected', id, 'total:', clients.size);
  });
}

function broadcast(data, skipId) {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  for (const [id, client] of clients.entries()) {
    if (id === skipId) continue;
    if (client.ws && client.ws.readyState === client.ws.OPEN) {
      client.ws.send(payload);
    }
  }
}

wss.on('connection', (ws) => {
  handleConnection(ws).catch((err) => {
    log('failed to init client', err);
    ws.close();
  });
});

// ---- Simulation loop ----
async function startLoops() {
  await initPhysics();
  const fixedDt = 1 / SERVER_TICK_RATE;
  setInterval(() => {
    applyInputs(fixedDt);
    world.step();
    tick += 1;
    for (const prop of props) resetPropIfOutOfBounds(prop);
  }, 1000 / SERVER_TICK_RATE);

  setInterval(() => {
    if (clients.size === 0) return;
    const snapshot = buildSnapshot();
    broadcast(snapshot);
  }, 1000 / SNAPSHOT_RATE);

  const HEARTBEAT_MS = 15000;
  setInterval(() => {
    const now = Date.now();
    for (const [id, client] of clients.entries()) {
      if (!client.ws || client.ws.readyState !== client.ws.OPEN) continue;
      if (now - client.lastSeen > HEARTBEAT_MS * 2) {
        log('closing stale connection', id);
        client.ws.terminate();
        removePlayer(id);
        broadcast({ type: 'player-left', id }, id);
      } else {
        client.ws.ping();
      }
    }
  }, HEARTBEAT_MS);
}

startLoops().catch((err) => log('loop init error', err));

server.listen(PORT, () => {
  log(`server listening on http://localhost:${PORT}`);
});
