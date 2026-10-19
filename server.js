const http = require('http');
const fs = require('fs');
const path = require('path');
const { createRoomManager } = require('./multiplayer/rooms.cjs');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const PUBLIC_DIR = __dirname;
const WS_PATH = '/ws';
const roomManager = createRoomManager();

function log(...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}]`, ...args);
}

function resolveFile(filePath) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(filePath, 'http://localhost').pathname); }
  catch (_) { return null; }
  const targetPath = path.resolve(PUBLIC_DIR, '.' + pathname);
  const relative = path.relative(PUBLIC_DIR, targetPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
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
  '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary'
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

const wss = new WebSocketServer({
  server, path: WS_PATH, clientTracking: true,
  perMessageDeflate: false, maxPayload: 4096
});

// Socket traffic only begins when a driver explicitly creates or joins a room.
// The server never broadcasts remote players to unrelated visitors.
wss.on('connection', (ws, req) => {
  const origin=req.headers.origin;
  const sameSite=origin && (() => {
    try {return new URL(origin).host === req.headers.host;} catch(_) {return false;}
  })();
  if (origin && !sameSite && !CORS.allowList(origin)) {
    ws.close(1008,'Origin not allowed');
    return;
  }
  ws.isAlive=true;
  ws.on('pong',()=>{ws.isAlive=true;});
  roomManager.connect(ws);
});

const HEARTBEAT_MS = 15000;
const maintenance = setInterval(()=>{
  for(const ws of wss.clients){
    if(ws.readyState!==ws.OPEN)continue;
    if(!ws.isAlive){ws.terminate();continue;}
    ws.isAlive=false;
    ws.ping();
  }
  roomManager.cleanup();
},HEARTBEAT_MS);
maintenance.unref?.();

server.listen(PORT, () => {
  log(`server listening on http://localhost:${PORT} (private rooms)`);
});
