// Visible guidance for physical missions; markers never block Rapier bodies.
export function createActivityVisuals(THREE,scene) {
  const root=new THREE.Group();
  root.name="Physical driving mission guidance";
  scene.add(root);
  const group=new THREE.Group();root.add(group);
  const accent={
    courier:new THREE.Color(0xf4b46b),
    parking:new THREE.Color(0x8fd1b9),
    stunt:new THREE.Color(0xa8b7ff)
  };
  const circle=new THREE.Mesh(
    new THREE.RingGeometry(2.55,2.85,64),
    new THREE.MeshBasicMaterial({color:0xffffff,transparent:true,opacity:.84,
      side:THREE.DoubleSide,depthWrite:false})
  );
  circle.rotation.x=-Math.PI/2;
  circle.position.y=.11;group.add(circle);
  const inner=new THREE.Mesh(
    new THREE.RingGeometry(1.8,1.91,64),
    new THREE.MeshBasicMaterial({color:0xffffff,transparent:true,opacity:.36,
      side:THREE.DoubleSide,depthWrite:false})
  );
  inner.rotation.x=-Math.PI/2;inner.position.y=.114;group.add(inner);
  const beam=new THREE.Mesh(
    new THREE.CylinderGeometry(.16,.85,8,18,1,true),
    new THREE.MeshBasicMaterial({color:0xffffff,transparent:true,opacity:.13,
      side:THREE.DoubleSide,depthWrite:false})
  );
  beam.position.y=4;group.add(beam);
  const fin=new THREE.Mesh(
    new THREE.ConeGeometry(.52,.95,4),
    new THREE.MeshBasicMaterial({color:0xffffff,transparent:true,opacity:.8,
      side:THREE.DoubleSide,depthWrite:false})
  );
  fin.rotation.x=Math.PI;fin.position.y=7.3;group.add(fin);

  // Parking outline and heading arrow, with position aligned to rule set.
  const outline=new THREE.Group();group.add(outline);
  const markerMat=new THREE.MeshBasicMaterial({color:0xc4f8e5,transparent:true,
    opacity:.85,depthWrite:false});
  function line(w,d,x,z) {
    const m=new THREE.Mesh(new THREE.PlaneGeometry(w,d),markerMat);
    m.rotation.x=-Math.PI/2;m.position.set(x,.13,z);outline.add(m);
  }
  line(.16,5.3,-2.35,0);line(.16,5.3,2.35,0);
  line(4.8,.16,0,-2.65);
  line(.28,1.85,0,-.5);
  const tip=new THREE.Mesh(new THREE.ConeGeometry(.55,1.1,3),
    markerMat);
  tip.rotation.x=-Math.PI/2;
  tip.position.set(0,.14,1.25);
  outline.add(tip);

  // Physical-looking parcel attached to the car only while really loaded.
  const cargo=new THREE.Group();
  const cardboard=new THREE.MeshStandardMaterial({color:0xc59b65,roughness:.91});
  const tape=new THREE.MeshStandardMaterial({color:0xf0d6a2,roughness:.64});
  const crate=new THREE.Mesh(new THREE.BoxGeometry(.95,.48,.78),cardboard);
  crate.position.y=.27;crate.castShadow=true;
  cargo.add(crate);
  for(const x of [-.28,.28]){
    const line=new THREE.Mesh(new THREE.BoxGeometry(.12,.012,.79),tape);
    line.position.set(x,.52,0);cargo.add(line);
  }
  cargo.visible=false;

  let vehicle=null;
  let time=0;
  let lastKey="";
  let displayed=null;
  function attachCar(mesh) {
    if(vehicle===mesh)return;
    if(cargo.parent)cargo.parent.remove(cargo);
    vehicle=mesh;
    if(vehicle){
      vehicle.add(cargo);
      const box=new THREE.Box3().setFromObject(vehicle);
      const worldCenter=box.getCenter(new THREE.Vector3());
      const modelCenter=vehicle.worldToLocal(worldCenter.clone());
      cargo.position.set(modelCenter.x,Math.max(.7,box.getSize(new THREE.Vector3()).y*.85),modelCenter.z);
    }
  }
  function update(dt,state) {
    time+=dt;
    const mode=state?.id;
    const target=state?.target;
    root.visible=Boolean(mode&&mode!=="slalom"&&target&&!state.completed);
    cargo.visible=Boolean(mode==="courier"&&state.carrying&&!state.completed&&vehicle);
    if(!root.visible)return;
    const key=mode+":"+state.step;
    if(key!==lastKey) {
      lastKey=key;
      group.position.set(target.x,0,target.z);
      const color=accent[mode]||accent.courier;
      circle.material.color.copy(color);
      inner.material.color.copy(color);
      beam.material.color.copy(color);
      fin.material.color.copy(color);
      outline.visible=mode==="parking";
      outline.rotation.y=target.yaw||0;
    }
    const pulse=1+.045*Math.sin(time*4);
    circle.scale.setScalar(pulse);
    fin.position.y=7.35+.33*Math.sin(time*3.1);
    beam.material.opacity=.10+.035*Math.sin(time*2.2);
    // Show radial hold progress without inventing physical movement.
    const fraction=mode==="parking"?Math.min(1,state.hold/1.65):
      mode==="courier"?Math.min(1,state.hold/1.1):0;
    inner.material.opacity=.32+fraction*.52;
  }
  return {attachCar,update,root,cargo};
}
