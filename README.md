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

**Network rooms use server-authoritative Rapier dynamics.** The server keeps one physical world per room, advances it at 60 Hz, owns the car rigid bodies and three shared movable crates, and sends authoritative position, rotation and velocity snapshots at 20 Hz. Clients send only sequenced gas/steering inputs; browser-supplied car positions are ignored by authoritative rooms. This makes car-to-car and car-to-crate interactions consistent for all participants. The local model is a kinematic visual proxy with smoothed corrections while online; leaving the room restores the single-player four-wheel Rapier simulation.

Collision handling is currently authoritative for vehicles, shared cargo, tabletop boundaries and the two modeled ramps. Additional workshop scenery remains single-player/visual and is not yet mirrored into the authoritative room. Automatic rewind/replay prediction and latency-compensated input reconciliation are future work.

## Testing

```bash
npm test
npm run test:visual
```

The first command runs unit/physics/protocol tests. The second runs Chromium WebGL/Playwright acceptance tests and writes screenshots and traces as artifacts in GitHub Actions. These automated checks do not replace testing on a physical iPhone or production PocketWorks shell.

See [ROADMAP.md](ROADMAP.md) for remaining work.
