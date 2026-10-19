// Four-point raycast suspension for the miniature car.
// All forces are impulses applied at wheel attachment points, not teleports.
export const SURFACES = Object.freeze({
  asphalt: Object.freeze({ label: "АСФАЛЬТ", grip: 1.22, color: 0x353c45 }),
  dirt: Object.freeze({ label: "ГРУНТ", grip: 0.62, color: 0x9e7350 }),
  ice: Object.freeze({ label: "ЛЁД", grip: 0.16, color: 0x9dc6d9 }),
  rubber: Object.freeze({ label: "РЕЗИНА", grip: 1.8, color: 0x42454e })
});

export const SURFACE_PATCHES = Object.freeze([
  Object.freeze({ type: "dirt", x: 20, z: -18, width: 29, depth: 25 }),
  Object.freeze({ type: "ice", x: -28, z: 17, width: 25, depth: 29 }),
  Object.freeze({ type: "rubber", x: 9, z: 34, width: 26, depth: 19 })
]);

export const TUNING = Object.freeze({
  wheelTravel: 0.32,
  mountClearance: 0.3,
  staticSag: 0.12,
  springDamping: 0.76,
  axleSteer: 0.43,
  engineAcceleration: 12.5,
  reverseAcceleration: 7.0,
  brakingAcceleration: 19.0,
  forwardLimit: 18.5,
  reverseLimit: 8.5,
  aeroDownforce: 0.019
});

export function surfaceAt(x, z) {
  for (const patch of SURFACE_PATCHES) {
    if (Math.abs(x - patch.x) <= patch.width / 2 &&
        Math.abs(z - patch.z) <= patch.depth / 2) return patch.type;
  }
  return "asphalt";
}

export function suspensionForce(compression, velocity, springRate, dampingRate) {
  if (!(compression > 0)) return 0;
  return Math.max(0, springRate * compression - dampingRate * velocity);
}

export function tractionImpulse(requiredImpulse, normalForce, grip, dt) {
  const limit = Math.max(0, normalForce * grip * dt);
  return Math.max(-limit, Math.min(limit, requiredImpulse));
}

export function normalizeWheels(candidates, halfWidth, halfLength, localY) {
  const slots = [
    { x: -halfWidth, z: halfLength, front: true },
    { x: halfWidth, z: halfLength, front: true },
    { x: -halfWidth, z: -halfLength, front: false },
    { x: halfWidth, z: -halfLength, front: false }
  ];
  const valid = candidates.filter(p =>
    Number.isFinite(p.x) && Number.isFinite(p.z) &&
    Math.abs(p.x) > 0.04 && Math.abs(p.z) > 0.04
  );
  return slots.map(slot => {
    const matching = valid.filter(p =>
      Math.sign(p.x) === Math.sign(slot.x) &&
      Math.sign(p.z) === Math.sign(slot.z));
    matching.sort((a,b) =>
      Math.abs(a.x-slot.x)+Math.abs(a.z-slot.z) -
      Math.abs(b.x-slot.x)-Math.abs(b.z-slot.z));
    const match = matching[0];
    const x = match && Math.abs(match.x) < halfWidth * 1.7 ? match.x : slot.x;
    const z = match && Math.abs(match.z) < halfLength * 1.7 ? match.z : slot.z;
    return { x, y: localY, z, front: slot.front };
  });
}

export function createVehicleDynamics({ RAPIER, THREE, world, body, collider, wheelRadius, wheelPoints }) {
  const mass = Math.max(0.2, body.mass());
  const quarterMass = mass / 4;
  // Rapier gravity is -12.8 with 1.2x gravity scale in this game.
  const weight = mass * 12.8 * 1.2;
  const springRate = weight / (4 * TUNING.staticSag);
  const dampingRate = 2 * Math.sqrt(springRate * quarterMass) * TUNING.springDamping;
  const radius = Math.max(0.15, wheelRadius);
  const rayLimit = TUNING.mountClearance + radius + TUNING.staticSag + TUNING.wheelTravel;
  const values = wheelPoints.map(() => 0);
  let telemetry = {
    contacts: 0, grounded: false, grip: 0,
    surface: "asphalt", slip: 0, speed: 0, airborne: true
  };

  const v3 = (value) => new THREE.Vector3(value.x, value.y, value.z);
  const toVec = (value) => ({ x: value.x, y: value.y, z: value.z });

  function step(dt, steer, throttle) {
    const pos = body.translation();
    const rot = body.rotation();
    const q = new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q).normalize();
    const planarForward = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    planarForward.y = 0;
    if (planarForward.lengthSq() < 0.01) planarForward.set(0, 0, 1);
    planarForward.normalize();
    const yawVelocity = body.angvel();
    const lin = v3(body.linvel());
    const angular = v3(yawVelocity);
    const speed = lin.dot(planarForward);
    const steerAngle = steer * TUNING.axleSteer *
      (1 - 0.35 * Math.min(Math.abs(speed) / TUNING.forwardLimit, 1));
    const wheelForward = planarForward.clone().applyAxisAngle(
      new THREE.Vector3(0, 1, 0), steerAngle).normalize();
    const rearRight = new THREE.Vector3(planarForward.z, 0, -planarForward.x);
    const frontRight = new THREE.Vector3(wheelForward.z, 0, -wheelForward.x);
    const center = v3(pos);
    const rayDir = up.clone().negate();
    let contacts = 0;
    let gripTotal = 0;
    let totalSlip = 0;
    let groundType = "asphalt";

    for (let i = 0; i < wheelPoints.length; i++) {
      const wheel = wheelPoints[i];
      const local = new THREE.Vector3(wheel.x, wheel.y + TUNING.mountClearance, wheel.z);
      const origin = center.clone().add(local.applyQuaternion(q));
      const hit = world.castRayAndGetNormal(
        new RAPIER.Ray(toVec(origin), toVec(rayDir)),
        rayLimit, true, undefined, undefined, collider, body
      );
      const toi = hit?.toi ?? hit?.timeOfImpact;
      const normal = hit?.normal;
      if (!Number.isFinite(toi) || toi > rayLimit ||
          !normal || normal.y < 0.5 || up.y < 0.35) {
        values[i] = 0;
        continue;
      }

      const length = Math.max(0, toi - TUNING.mountClearance);
      const compression = Math.max(0, Math.min(TUNING.wheelTravel,
        radius + TUNING.staticSag - length));
      values[i] = compression;
      if (compression < 0.001) continue;

      const contact = origin.clone().addScaledVector(rayDir, toi);
      const offset = contact.clone().sub(center);
      const pointVelocity = lin.clone().add(angular.clone().cross(offset));
      const suspensionSpeed = pointVelocity.dot(up);
      const force = suspensionForce(compression, suspensionSpeed, springRate, dampingRate);
      if (force <= 0) continue;
      const patch = surfaceAt(contact.x, contact.z);
      const grip = SURFACES[patch].grip;
      contacts++;
      gripTotal += grip;
      groundType = patch;

      // Suspension compresses perpendicular to the chassis. Apply near the hub.
      const hub = origin.clone().addScaledVector(rayDir, TUNING.mountClearance);
      body.applyImpulseAtPoint(toVec(up.clone().multiplyScalar(force * dt)), toVec(hub), true);

      const forward = wheel.front ? wheelForward : planarForward;
      const right = wheel.front ? frontRight : rearRight;
      const lateralSpeed = pointVelocity.dot(right);
      totalSlip += Math.abs(lateralSpeed);
      const lateral = tractionImpulse(-lateralSpeed * quarterMass * 0.9, force, grip, dt);
      body.applyImpulseAtPoint(toVec(right.clone().multiplyScalar(lateral)), toVec(contact), true);

      let acceleration = throttle >= 0
        ? TUNING.engineAcceleration : TUNING.reverseAcceleration;
      if ((speed > 0.5 && throttle < 0) || (speed < -0.5 && throttle > 0)) {
        acceleration = TUNING.brakingAcceleration;
      }
      let drive = mass * acceleration * throttle * dt / 4;
      const limit = speed >= 0 ? TUNING.forwardLimit : TUNING.reverseLimit;
      const overSpeed = Math.abs(speed) >= limit &&
        Math.sign(speed) === Math.sign(throttle);
      if (overSpeed) drive = 0;
      drive = tractionImpulse(drive, force, grip, dt);
      body.applyImpulseAtPoint(toVec(forward.clone().multiplyScalar(drive)), toVec(contact), true);
    }

    // Only grounded cars get aerodynamic aid and planar yaw stabilization.
    if (contacts >= 2) {
      const downforce = Math.min(mass * 7, mass *
        TUNING.aeroDownforce * speed * speed);
      body.applyImpulse(toVec(new THREE.Vector3(0, -downforce * dt, 0)), true);
      // Small angular damping prevents endless spins without cancelling collisions.
      const ang = body.angvel();
      const yawDamping = Math.max(-mass * 0.15 * dt,
        Math.min(mass * 0.15 * dt, -ang.y * mass * dt * 0.3));
      body.applyTorqueImpulse({ x: 0, y: yawDamping, z: 0 }, true);
    }

    telemetry = {
      contacts, grounded: contacts >= 2, grip: contacts ? gripTotal / contacts : 0,
      surface: groundType, slip: contacts ? totalSlip / contacts : 0,
      speed, airborne: contacts < 2
    };
    return telemetry;
  }

  function reset() {
    values.fill(0);
    telemetry = { contacts:0, grounded:false, grip:0,
      surface:"asphalt", slip:0, speed:0, airborne:true };
  }
  return {
    step, reset,
    getTelemetry: () => telemetry,
    getCompression: () => values.slice()
  };
}
