// Tire marks are pooled instances; no per-frame geometry or material allocation.
export function createRoadFeedback(THREE,scene,{lowQuality=false}={}) {
  const count=lowQuality?72:144;
  const geometry=new THREE.PlaneGeometry(.22,1);
  const material=new THREE.MeshBasicMaterial({
    color:0xffffff,transparent:true,opacity:.42,depthWrite:false,
    side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:-2
  });
  const tracks=new THREE.InstancedMesh(geometry,material,count);
  tracks.name="Persistent tire marks";
  tracks.frustumCulled=false;
  tracks.renderOrder=5;
  tracks.castShadow=false;
  const dummy=new THREE.Object3D();
  const dark=new THREE.Color(0x161c20);
  const clay=new THREE.Color(0x654735);
  const ice=new THREE.Color(0xd8e5e6);
  // Park unused instances below the tabletop; no visibility or z-fighting.
  for(let i=0;i<count;i++){
    dummy.position.set(0,-50,0);
    dummy.scale.set(.001,.001,.001);
    dummy.updateMatrix();
    tracks.setMatrixAt(i,dummy.matrix);
    tracks.setColorAt(i,dark);
  }
  tracks.instanceMatrix.needsUpdate=true;
  if(tracks.instanceColor)tracks.instanceColor.needsUpdate=true;
  scene.add(tracks);
  let cursor=0,frequency=0;
  const wheelLeft=new THREE.Vector3(-.58,0,-1.02);
  const wheelRight=new THREE.Vector3(.58,0,-1.02);
  const down=new THREE.Vector3(0,1,0);
  const p=new THREE.Vector3();
  const f=new THREE.Vector3();
  function update(dt,car,physics) {
    frequency=Math.max(0,frequency-dt);
    if(!car||!physics||!physics.grounded||physics.slip<1.35||
       Math.abs(physics.speed)<3.7||frequency>0)return;
    frequency=.065;
    const yaw=Math.atan2(
      2*(car.quaternion.w*car.quaternion.y+car.quaternion.x*car.quaternion.z),
      1-2*(car.quaternion.y**2+car.quaternion.z**2));
    const color=physics.surface==="ice"?ice:
      physics.surface==="dirt"?clay:dark;
    const len=.35+Math.min(1.2,Math.abs(physics.speed)*dt*5);
    for(const local of [wheelLeft,wheelRight]){
      p.copy(local).applyQuaternion(car.quaternion).add(car.position);
      dummy.position.set(p.x,.075,p.z);
      // Plane lies on tabletop; its long dimension follows the car's heading.
      dummy.rotation.set(-Math.PI/2,0,-yaw);
      dummy.scale.set(1,len,1);
      dummy.updateMatrix();
      tracks.setMatrixAt(cursor,dummy.matrix);
      tracks.setColorAt(cursor,color);
      cursor=(cursor+1)%count;
    }
    tracks.instanceMatrix.needsUpdate=true;
    if(tracks.instanceColor)tracks.instanceColor.needsUpdate=true;
  }
  function reset(){
    cursor=0;frequency=0;
    for(let i=0;i<count;i++){
      dummy.position.set(0,-50,0);
      dummy.scale.set(.001,.001,.001);
      dummy.updateMatrix();tracks.setMatrixAt(i,dummy.matrix);
    }
    tracks.instanceMatrix.needsUpdate=true;
  }
  return {update,reset,mesh:tracks,capacity:count};
}
