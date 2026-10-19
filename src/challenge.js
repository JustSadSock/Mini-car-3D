// Mini Car 3D: non-solid illuminated checkpoint course.
export function createDrivingChallenge(THREE, scene) {
  const STORAGE_KEY = "mini-car-3d:best-slalom:v1";
  const route = [[0,14],[11,29],[26,21],[33,0],[19,-20],[-5,-27],[-29,-11],[-23,17],[-8,32]];
  const gateGeo = new THREE.TorusGeometry(2.7, 0.13, 10, 40);
  const floorGeo = new THREE.RingGeometry(3, 3.16, 50);
  const inactive = new THREE.Color(0x7a93a3);
  const active = new THREE.Color(0xffb352);
  const gates = [];
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(route.concat([route[0]]).map(([x,z]) => new THREE.Vector3(x, 0.07, z))),
    new THREE.LineDashedMaterial({color:0xd5b08a, transparent:true, opacity:0.45, dashSize:1.2, gapSize:0.85})
  );
  line.computeLineDistances();
  scene.add(line);
  route.forEach(([x,z], i) => {
    const prev = route[(i - 1 + route.length) % route.length];
    const group = new THREE.Group();
    group.position.set(x, 2.8, z);
    group.rotation.y = Math.atan2(x - prev[0], z - prev[1]);
    const ring = new THREE.Mesh(gateGeo, new THREE.MeshStandardMaterial({
      color:inactive, emissive:inactive, emissiveIntensity:0.4,
      transparent:true, opacity:0.26, side:THREE.DoubleSide, depthWrite:false
    }));
    group.add(ring);
    const floor = new THREE.Mesh(floorGeo, new THREE.MeshBasicMaterial({
      color:inactive, transparent:true, opacity:0.13,
      side:THREE.DoubleSide, depthWrite:false
    }));
    floor.rotation.x = -Math.PI/2;
    floor.position.y = -2.72;
    group.add(floor);
    scene.add(group);
    gates.push({x,z,ring,floor});
  });

  let best = 0;
  try {
    const stored = Number(localStorage.getItem(STORAGE_KEY));
    if (Number.isFinite(stored) && stored > 0) best = stored;
  } catch (_) { /* Embedded mode can disable browser storage. */ }

  let index = 0;
  let elapsed = 0;
  let running = false;
  let finished = 0;
  let cooldown = 0;
  let visualTime = 0;
  function reset() { index=0; elapsed=0; running=false; finished=0; cooldown=0; }
  function update(dt, position, speed) {
    visualTime += dt;
    if (!position) return;
    if (finished > 0) finished=Math.max(0, finished-dt);
    if (cooldown > 0) cooldown=Math.max(0,cooldown-dt);
    if (!running && cooldown === 0 && speed > 0.7) running = true;
    if (running) elapsed += dt;
    const gate = gates[index];
    if (gate && running && Math.hypot(position.x-gate.x, position.z-gate.z) < 3.5) {
      index++;
      if (index >= gates.length) {
        if (!best || elapsed < best) {
          best=elapsed;
          try {localStorage.setItem(STORAGE_KEY, best.toFixed(3));} catch (_) {}
        }
        reset();
        cooldown=2;
        finished=3;
      }
    }
    gates.forEach((entry,i) => {
      const isActive=i===index;
      const tint=isActive?active:inactive;
      entry.ring.material.color.copy(tint);
      entry.ring.material.emissive.copy(tint);
      entry.ring.material.opacity=isActive?0.92:i<index?0.08:0.26;
      entry.floor.material.color.copy(tint);
      entry.floor.material.opacity=isActive?0.46:0.13;
      entry.ring.scale.setScalar(isActive?1+0.07*Math.sin(visualTime*5.5):1);
    });
  }
  function getState() {
    return {next:index+1,total:gates.length,time:elapsed,running,best,finished:finished>0};
  }
  return {update,getState,reset};
}
