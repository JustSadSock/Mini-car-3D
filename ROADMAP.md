# Mini Car 3D: overhaul roadmap

**Direction:** A tactile 3D miniature driving playground. Preserve the Rapier vehicle and GLB visual model; build meaningful short physical challenges around it. Avoid a generic racing clone.

## P0 — Runtime bugs and playable baseline
- [x] Fix case-sensitive GLB file path (Linux hosting).
- [x] Fail clearly when model loading fails and allow retry.
- [x] Free remote peers' physical bodies and materials safely; keep shared GLB geometry.
- [x] Cancel late peer spawn after disconnect, preserve newest updates while loading.
- [x] Correct rear light update loop and suppress expensive remote shadow casting.
- [x] Scope touch cancellation to game controls so menu buttons work on iOS.
- [x] Recover/restart car via R or touchscreen, switch headlights via L / UI.
- [x] Make follow camera upright regardless of body roll.
- [x] Add slalom checkpoint course with lap timer, real progress, personal best.
- [x] Add speed / progress / record HUD.
- [x] Add basic HTTP path guard, correct GLB MIME, WebSocket payload cap.
- [ ] Browser smoke tests (mobile, desktop, WebGL startup, net disconnect).

## P1 — Physics
- [x] Four wheel raycasts, real spring/damper impulse forces and individually animated suspension.
- [x] Grounded-dependent throttle and cornering, grip capped by normal force and tire load.
- [x] Stable air behavior with limited downforce only when grounded.
- [x] Real asphalt/dirt/ice/rubber grip patches matched to visual terrain.
- [x] Consistent forward and steering directions for keyboard, joystick and GLB lights.
- [x] Less artificial chassis friction, damping and bouncing.
- [x] Collision effects use pre-solver approach speed and per-impact cooldown.
- [x] In-place rollover recovery (F or button); out-of-bounds recovery; reset R.
- [x] Physics telemetry (P or touch) for contacts, slip, grip, spring travel.
- [x] GLB structure verified: +Z front, independent front wheel meshes and paired rear wheel mesh.
- [x] Real Rapier integration tests for suspension, steering, air controls and ice traction.
- [x] Fixed-step consistency at 30/60/120 render FPS, real collider event API checks.
- [x] Two sloped ramps with matching visual meshes and physical Rapier colliders.
- [ ] Interactive WebGL/browser driving and landing validation on desktop and iOS.
- [ ] Playwright screenshots, mobile layout and performance profiling.

## P2 — Visual identity
- [x] Deterministic woodworking-table diorama and curved nine-checkpoint road.
- [x] Real physical workshop environment: service canopy, timing board, cones, crates, tire stacks, lamps and boundaries.
- [x] Asphalt and grip-zone decals, lane markings, tactile tabletop grain, coherent color palette.
- [x] Ambient reflection and responsive directional shadows; tune scene lighting for warm workshop feel.
- [x] Pooled persistent skid marks; original impact / dust particles and wheel suspension remain.
- [x] Three active camera presets with obstacle occlusion and speed-adaptive field of view.
- [x] Custom racing-instrument HUD, icon, touch joystick skin, loading treatment and responsive controls.
- [x] Mobile-aware antialiasing/pixel ratio and reduced shadow-map resolution.
- [ ] Review actual browser screenshots for artifacting, readability, z-fighting and shadows.
- [ ] Profile GPU cost on real iOS hardware, tune cinematic post FX only if justified.
- [ ] Improve model material roughness and add ambient contact shading after visual QA.

## P3 — Game modes
- [x] Dedicated in-game mode picker and repeatable goals: nine-gate slalom, two courier deliveries, three precision parking bays, two true-airtime ramp jumps.
- [x] Courier loading dwell and visible parcel; collision damage resets pickup after three heavy hits, applies time penalties.
- [x] Parking requires position, precise yaw, low speed and 1.65 s dwell.
- [x] Stunt score comes from real grounded->airborne->grounded Rapier state and horizontal distance; stages use both physical ramps.
- [x] Saved per-mode personal bests and gold/silver/bronze thresholds; full result/next/retry flow.
- [x] 3D target markers, parking alignment, cargo model, mode HUD and route guidance.
- [ ] Browser acceptance tests for all four mode transitions and result persistence.
- [ ] Future expansion: track editor with save/load, lap ghosts/replays, daily layouts.
- [ ] Future expansion: different car chassis/handling, cargo weight and physics puzzle courses.

## P4 — Multiplayer / PocketWorks integration
- [x] Remove hard-coded global server and automatic connection. Play alone by default.
- [x] Private, shareable six-character rooms with four-seat cap, roster, room leader, explicit leave and invite links.
- [x] Room-scoped car snapshots and state sanitization; 20 Hz network send and rendered peer interpolation.
- [x] Reconnection with secret session token and reserved seat during a 25-second grace window.
- [x] Server-coordinated co-op convoy: four sequential checkpoints reached by every connected participant.
- [x] Multiplayer lobby UI for desktop/mobile; explicit external WebSocket endpoint and origin allowlisting.
- [x] Server-side tests: isolation, room capacity, leader hand-off, resumption, convoy gating, invalid movement.
- [x] Authoritative 60-Hz Rapier simulation per room for full dynamic car-car and car-cargo interactions. Three shared boxes and ramp/floor colliders; accepts only signed-bounded, monotonic driver input.
- [x] Snapshot broadcast at 20 Hz includes full 3D quaternion, velocity, props, simulation tick and applied input sequence; browser transforms are non-authoritative.
- [x] Online car switches to kinematic, smoothed server state and reverts to solo dynamics on leave; shared cargo rendered as physical-world meshes.
- [x] Server validates checkpoint progression directly against its rigidbody coordinates; browser cannot send spoofed positions to advance race.
- [ ] Advanced latency compensation and rollback/input replay; current correction is smoothing, not full prediction/reconciliation.
- [ ] Mirror all workshop obstacle colliders and implement cooperative cargo delivery beyond the three shared crates.
- [ ] Replace standalone Node WebSocket host with PocketWorks/Pocketnet room transport after locating the production shell and deployment wiring.
- [ ] Verify launch, navigation, manifest and version synchronization in the actual PocketWorks shell; standalone repository is not proof of deployment.
- [ ] End-to-end browser confirmation: two clients, reconnect, room join/leave, share link, race finish, real mobile device.
- [ ] Extended co-op: cargo handling, vehicle soccer, obstacle course and creator tools.

## P5 — Audio, input and UX
- Engine, rolling and impacts as layered spatial audio. Mute toggles and volume slider.
- Optional haptics, gamepad support and accessible remapping/invert controls.
- Physical feedback in animation and camera matched to speed/collisions.
- Guided first 30 seconds, graceful offline behavior, mobile layouts and safe areas.

## Quality gates
- No dead controls or visual-only state toggles.
- Launch asset loads on Linux/case-sensitive hosting.
- Checkpoints work in order; records persist or degrade safely when storage is denied.
- Multi-peer join/leave leaves no collider ghosts or disposed shared meshes.
- Manual Playwright screenshots in portrait, landscape and desktop before release.

**Scope note:** This repo is the legacy standalone Three.js game. The current
PocketWorks installation and its shell integration have not yet been verified here.
The roadmap marks browser/physics claims as pending until verified in live execution.
