// Rendering adapter for snapshots from the server-authoritative Rapier world.
export function createOnlineWorldView(THREE,RAPIER,scene,{
  getBody,getCar,onPeer=()=>{}
}={}){
  let active=false,lastTick=-1,target=null;
  const boxes=new Map();
  function enabled(value){
    const next=Boolean(value);
    if(next===active)return;
    active=next;lastTick=-1;target=null;
    const body=getBody();
    if(body){
      body.setBodyType(active?RAPIER.RigidBodyType.KinematicPositionBased:
        RAPIER.RigidBodyType.Dynamic,true);
      body.setLinvel({x:0,y:0,z:0},true);
      body.setAngvel({x:0,y:0,z:0},true);
      if(!active)body.setGravityScale(1.2,true);
    }
    scene.traverse(obj=>{
      if(obj.name==="Pushable delivery crate")obj.visible=!active;
    });
    if(!active){
      for(const mesh of boxes.values()){
        scene.remove(mesh);mesh.geometry.dispose();mesh.material.dispose();
      }
      boxes.clear();
    }
  }
  function snapshot(frame,id){
    if(!active||!frame||!Number.isSafeInteger(frame.tick)||
       frame.tick<=lastTick)return;
    lastTick=frame.tick;
    const found=new Set();
    for(const item of frame.props||[]){
      if(!item||typeof item.id!=="string"||item.p?.length!==3)continue;
      found.add(item.id);
      let mesh=boxes.get(item.id);
      if(!mesh){
        const palette={"cargo-a":0xcc9e6e,"cargo-b":0xc78654,"cargo-c":0x768f9b};
        mesh=new THREE.Mesh(new THREE.BoxGeometry(1.44,1.3,1.44),
          new THREE.MeshStandardMaterial({color:palette[item.id]||0xc6a17e,
            roughness:.82,metalness:.06}));
        mesh.castShadow=true;mesh.receiveShadow=true;
        mesh.name="Server-authoritative shared cargo";
        scene.add(mesh);boxes.set(item.id,mesh);
      }
      mesh.position.set(...item.p);
      if(item.q?.length===4)mesh.quaternion.set(...item.q);
    }
    for(const [key,mesh]of boxes){
      if(found.has(key))continue;
      scene.remove(mesh);mesh.geometry.dispose();mesh.material.dispose();
      boxes.delete(key);
    }
    for(const player of frame.players||[]){
      if(player.p?.length!==3||player.q?.length!==4)continue;
      if(player.id===id){
        target={
          position:new THREE.Vector3(...player.p),
          quaternion:new THREE.Quaternion(...player.q),
          velocity:player.v?.length===3?new THREE.Vector3(...player.v):
            new THREE.Vector3(),
          seq:player.ack
        };
        const car=getCar();
        if(car){
          const forward=new THREE.Vector3(0,0,1).applyQuaternion(target.quaternion);
          car.userData.lastSpeed=target.velocity.dot(forward);
          car.userData.lastTargetSpeed=car.userData.lastSpeed;
        }
      }else onPeer(player);
    }
  }
  function step(){
    if(!active||!target)return;
    const body=getBody();
    if(!body)return;
    const pos=body.translation(),rot=body.rotation();
    const current=new THREE.Vector3(pos.x,pos.y,pos.z);
    const error=current.distanceTo(target.position);
    const correction=error>7?1:.35;
    current.lerp(target.position,correction);
    const orientation=new THREE.Quaternion(rot.x,rot.y,rot.z,rot.w)
      .slerp(target.quaternion,correction);
    body.setNextKinematicTranslation({
      x:current.x,y:current.y,z:current.z
    });
    body.setNextKinematicRotation({
      x:orientation.x,y:orientation.y,z:orientation.z,w:orientation.w
    });
  }
  return {enabled,snapshot,step,get active(){return active;},
    get lastTick(){return lastTick;},get cargoCount(){return boxes.size;}};
}
