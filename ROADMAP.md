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
- Skill tests: slalom, stunt park, delivery, parking, rally, domino / physics puzzle.
- Combo + precision scoring with clear fairness and medal thresholds.
- Track editor with checkpoints, physical props and local save/load.
- Lap ghosts, splits and replays, seeded daily challenges, scenario records.
- Distinct cars with genuinely different handling (not cosmetic stats).

## P4 — Multiplayer / PocketWorks integration
- Replace hard-coded external host with Pocketnet room semantics and reconnection.
- State sanitization, interpolation buffer, clock sync and reconciliation.
- Either ghost races or proper mutually dynamic vehicles; do not mix them.
- Co-op driving puzzles, vehicle soccer, convoy trials, invite flow.
- Integrate Mini Car 3D as an independent PocketWorks app with icon, launch,
  app-switch navigation and environment-compatible persistence.
- Multiplayer automation: join/leave, repeated disconnect, inactive tab, two cars colliding.

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
