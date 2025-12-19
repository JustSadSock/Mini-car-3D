const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const PUBLIC_DIR = __dirname;
const WS_PATH = '/ws';
const clients = new Map();
const WORLD_SEED = 20240525;

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

const wss = new WebSocketServer({ server, path: WS_PATH, clientTracking: true, perMessageDeflate: false });

function broadcast(data, skipId) {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  for (const [id, client] of clients.entries()) {
    if (id === skipId) continue;
    if (client.ws.readyState === client.ws.OPEN) {
      client.ws.send(payload);
    }
  }
}

function snapshotState(state) {
  return {
    p: state?.p || [0, 0, 0],
    y: state?.y || 0,
    q: state?.q || [0, 0, 0, 1],
    s: state?.s || 0,
    st: state?.st || 0,
    b: Boolean(state?.b),
    t: Date.now()
  };
}

wss.on('connection', (ws) => {
  const id = randomUUID();
  clients.set(id, { ws, state: snapshotState(), lastSeen: Date.now() });
  log('client connected', id, 'total:', clients.size);

  const others = [];
  for (const [otherId, client] of clients.entries()) {
    if (otherId === id) continue;
    others.push({ id: otherId, state: snapshotState(client.state) });
  }

  ws.send(JSON.stringify({ type: 'hello', id, players: others, worldSeed: WORLD_SEED }));
  broadcast({ type: 'player-joined', id }, id);

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch (err) {
      log('invalid json from', id, err.message);
      return;
    }

    if (data.type === 'state' && data.state) {
      const state = snapshotState(data.state);
      const client = clients.get(id);
      if (!client) return;
      client.state = state;
      client.lastSeen = Date.now();
      broadcast({ type: 'state', id, state }, id);
    }
  });

  ws.on('close', () => {
    clients.delete(id);
    broadcast({ type: 'player-left', id }, id);
    log('client disconnected', id, 'total:', clients.size);
  });
});

const HEARTBEAT_MS = 15000;
setInterval(() => {
  const now = Date.now();
  for (const [id, client] of clients.entries()) {
    if (client.ws.readyState !== client.ws.OPEN) continue;
    if (now - client.lastSeen > HEARTBEAT_MS * 2) {
      log('closing stale connection', id);
      client.ws.terminate();
      clients.delete(id);
      broadcast({ type: 'player-left', id }, id);
    } else {
      client.ws.ping();
    }
  }
}, HEARTBEAT_MS);

server.listen(PORT, () => {
  log(`server listening on http://localhost:${PORT}`);
});
