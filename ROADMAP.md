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
- True grounded checks with wheel raycasts, suspension and visible compression.
- Correct traction and yaw while airborne, downforce and stable roll handling.
- Physically correct chassis collider placement and wheel rotation axes (validate against GLB).
- Surface grip for wood, asphalt, gravel, mud and ice.
- Collision impulse-based effect/audio scaling; avoid falsely triggered camera shake.
- Stuck/upside-down respawn and deterministic 30/60/120 FPS tests.
- Physics debugger and reproducible scenario fixtures.

## P2 — Visual identity
- Build a real toy-scale diorama: modeled roads, workbench, rails, ramps, modular props.
- Distinguishable roughness, materials, proper contact shadows and light falloff.
- Physicalized scenery collision: never place opaque fake solids without Rapier bodies.
- Animated suspension, debris, particle pooling, skid decals, tire deformation illusion.
- Occlusion-aware chase camera, alternate overhead and cinematic replay views.
- Visual performance levels for iOS and desktop; GPU/memory budgets.

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
