# Mini Car 3D · Tiny Motor Club

A miniature workbench driving playground using **Three.js** and **Rapier**. Solo play works without a multiplayer server. The standalone app supports slalom, delivery, parking and ramp-jump trials.

## Run locally

```bash
npm install
npm start
```

Open http://localhost:3000 and drive using WASD or the on-screen joystick. C changes the camera, R restarts the activity, F rights the car, M opens solo activities, O opens the multiplayer garage.

## Multiplayer garage

Choose **ВМЕСТЕ → СОЗДАТЬ КОМНАТУ**, then share the six-character code (or **КОПИРОВАТЬ ПРИГЛАШЕНИЕ**). Friends enter that code through **ПРИСОЕДИНИТЬСЯ**. Each room accepts up to **4 cars**. Only the room leader can start **КОНВОЙ**, a shared timed trial with four checkpoints; *everyone* must reach the active checkpoint before it advances.

Joining a room is opt-in. Players in other rooms never appear in your world. After a brief network loss, the client attempts to resume its seat for 25 seconds; a hard disconnect beyond that period expires the reservation.

### Multi-device and embedded hosting

To drive together over LAN, point all browsers at the same reachable `http://LAN-IP:3000` origin, not their own devices' localhost.

For a separately hosted static frontend or an embedded PocketWorks view, enter the running backend's **HTTPS origin** in the *СЕРВЕР КОМНАТ* field, or supply `?server=https://your-server.example&room=ABC234` in an invitation URL. The WebSocket server must support `/ws` and run the code from this repository. HTTPS frontend requires secure WSS.

Configure the backend's cross-origin whitelist for your host:

```bash
ALLOWED_ORIGINS=https://your-frontend.example node server.js
```

Comma-separated origins are supported. Same-origin and supported Netlify origins work without this setting.

**Deployment boundary:** this repository contains the standalone Node/Three app. Hosting a static copy alone cannot provide multiplayer; a live `server.js` process is required. Native PocketWorks/Pocketnet integration and publication into the shell are not yet confirmed.

### Physics scope

The local car uses four-wheel Rapier suspension and grip. Remote cars use room-scoped streamed state and kinematic Rapier proxies. Collisions with these proxies may have local responses, but there is **not yet an authoritative server-side rigid-body simulation**. The co-op convoy checkpoint progression, room membership and timing are server-managed.

## Testing

```bash
npm test
npm run test:visual
```

The first command runs unit/physics/protocol tests. The second runs Chromium WebGL/Playwright acceptance tests and writes screenshots and traces as artifacts in GitHub Actions. These automated checks do not replace testing on a physical iPhone or production PocketWorks shell.

See [ROADMAP.md](ROADMAP.md) for remaining work.
