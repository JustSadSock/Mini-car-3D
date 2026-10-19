// THE WORKBENCH — deterministic toy-scale visual world for Mini Car 3D.
// All solid props have matching Rapier colliders. Painted road surfaces are
// deliberately only decals on the existing flat physical ground.
export const TRACK_POINTS = Object.freeze([
  [0,14],[11,29],[26,21],[33,0],[19,-20],
  [-5,-27],[-29,-11],[-23,17],[-8,32]
]);
export const WORLD_LANDMARKS = Object.freeze([
  {name:"garage",x:-55,z:3},
  {name:"crate-yard",x:49,z:-37},
  {name:"scoreboard",x:0,z:-57},
  {name:"jump-a",x:-45,z:-39},
  {name:"jump-b",x:46,z:38}
]);
export function pathClearance(x,z) {
  let best=Infinity;
  for(let i=0;i<TRACK_POINTS.length;i++){
    const a=TRACK_POINTS[i], b=TRACK_POINTS[(i+1)%TRACK_POINTS.length];
    const dx=b[0]-a[0],dz=b[1]-a[1];
    const t=Math.max(0,Math.min(1,((x-a[0])*dx+(z-a[1])*dz)/(dx*dx+dz*dz)));
    best=Math.min(best,Math.hypot(x-a[0]-t*dx,z-a[1]-t*dz));
  }
  return best;
}
export function makeWorkshopTexture(THREE) {
  if(typeof document==="undefined") return null;
  const canvas=document.createElement("canvas");
  canvas.width=512;canvas.height=512;
  const c=canvas.getContext("2d");
  if(!c)return null;
  c.fillStyle="#987259";c.fillRect(0,0,512,512);
  let seed=81282;
  const rand=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/4294967296;};
  for(let i=0;i<8;i++){
    const y=i*64;
    c.fillStyle=i%2?"#a7805e":"#987054";
    c.fillRect(0,y,512,64);
    c.fillStyle="rgba(42,28,23,0.25)";
    c.fillRect(0,y,512,2);
    c.fillRect(0,y+62,512,2);
    for(let j=0;j<90;j++){
      const x=rand()*512, yy=y+rand()*60;
      c.fillStyle=rand()>.5?"rgba(255,218,156,0.055)":"rgba(33,18,13,0.065)";
      c.fillRect(x,yy,18+rand()*110,0.4+rand()*1.6);
    }
    for(const x of [10,500]){
      c.fillStyle="#645045";c.beginPath();c.arc(x,y+10,2.1,0,Math.PI*2);c.fill();
      c.strokeStyle="#c5a28b";c.lineWidth=.65;c.stroke();
    }
  }
  const tex=new THREE.CanvasTexture(canvas);
  tex.colorSpace=THREE.SRGBColorSpace;
  tex.wrapS=tex.wrapT=THREE.RepeatWrapping;
  tex.repeat.set(12,12);
  tex.anisotropy=4;
  return tex;
}
function labelTexture(THREE, lines, bg="#252e37",fg="#ffdaaa") {
  if(typeof document==="undefined")return null;
  const canvas=document.createElement("canvas");
  canvas.width=512;canvas.height=256;
  const c=canvas.getContext("2d");
  if(!c)return null;
  c.fillStyle=bg;c.fillRect(0,0,512,256);
  c.strokeStyle=fg;c.globalAlpha=.72;c.lineWidth=8;c.strokeRect(15,15,482,226);
  c.globalAlpha=1;
  c.textAlign="center";c.textBaseline="middle";
  c.fillStyle=fg;c.font="900 66px Arial, sans-serif";c.fillText(lines[0],256,102,466);
  c.font="600 25px Arial, sans-serif";c.fillText(lines[1]||" ",256,169,466);
  c.fillStyle="#e3a75a";c.fillRect(78,211,356,7);
  const tex=new THREE.CanvasTexture(canvas);
  tex.colorSpace=THREE.SRGBColorSpace;tex.anisotropy=4;
  return tex;
}
export function createDiorama({THREE,RAPIER,scene,world,ground,registerBody,lowQuality=false}) {
  const theme={
    ink:0x28323b,road:0x303a43,edge:0xe3b987,paint:0xf6e1c5,
    rust:0xb8754d,paper:0xe1ccaa,rubber:0x36383b,steel:0x71868c
  };
  let boxes=0,decorations=0;
  const staticMeshes=[];
  const staticColliders=[];
  const animated=[];
  const add=(mesh)=>{scene.add(mesh);decorations++;return mesh;};
  function material(color,roughness=.8,metalness=0,extra={}) {
    return new THREE.MeshStandardMaterial({color,roughness,metalness,...extra});
  }
  const mat={
    cardboard:material(0xd0a878,.93),
    cardboardDark:material(0xa67d57,.95),
    metal:material(theme.steel,.46,.55),
    enamel:material(theme.rust,.39,.23),
    lamp:material(0xffcf87,.48,.05,{emissive:0xff8c44,emissiveIntensity:.8}),
    rubber:material(theme.rubber,.96),
    white:material(theme.paint,.67),
    ink:material(theme.ink,.85),
    yellow:material(0xffb55f,.66),
    red:material(0xb64b3c,.7),
    dark:material(0x4c534f,.72,.15)
  };
  function block(x,y,z,w,h,d,m,opts={}) {
    const mesh=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),m);
    mesh.position.set(x,y,z);
    if(opts.yaw)mesh.rotation.y=opts.yaw;
    mesh.castShadow=opts.castShadow!==false;
    mesh.receiveShadow=true;
    mesh.name=opts.name||"Workshop prop";
    add(mesh);
    if(opts.collision!==false) {
      const quat=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),opts.yaw||0);
      const desc=opts.dynamic?
        RAPIER.RigidBodyDesc.dynamic().setTranslation(x,y,z).setRotation(quat)
          .setLinearDamping(.75).setAngularDamping(.7):
        RAPIER.RigidBodyDesc.fixed().setTranslation(x,y,z).setRotation(quat);
      const body=world.createRigidBody(desc);
      const collider=world.createCollider(RAPIER.ColliderDesc.cuboid(w/2,h/2,d/2)
        .setFriction(.8).setRestitution(opts.dynamic?.2:.06),body);
      registerBody(body,mesh,collider,{type:opts.dynamic?"workshop-dynamic":"workshop-static",dynamic:!!opts.dynamic});
      staticColliders.push(collider);
      if(!opts.dynamic)staticMeshes.push(mesh);
    }
    boxes++;
    return mesh;
  }
  function paintPlane(x,z,w,d,m,y=.038,yaw=0) {
    const mesh=new THREE.Mesh(new THREE.PlaneGeometry(w,d),m);
    mesh.rotation.set(-Math.PI/2,0,yaw);
    mesh.position.set(x,y,z);
    mesh.receiveShadow=true;
    mesh.name="Painted ground decal (non-solid)";
    return add(mesh);
  }
  // One actual ground collider already exists. Wooden planks are just a surface.
  const tex=makeWorkshopTexture(THREE);
  ground.material=material(0xffffff,.89,0,tex?{map:tex}: {color:0xa37e5e});
  ground.material.needsUpdate=true;
  // A real-looking floating workbench. The metal frame is entirely below the
  // drivable ground, so there is no invisible obstruction on the play surface.
  block(0,-1.35,0,220,2.55,220,mat.cardboardDark,{collision:false,castShadow:false,name:"Wooden tabletop edge"});
  for(const x of [-108,108]) {
    block(x,-.06,0,1.25,.2,220,mat.metal,{collision:false,name:"Tabletop edge trim"});
  }
  for(const z of [-108,108]) {
    block(0,-.06,z,220,.2,1.25,mat.metal,{collision:false,name:"Tabletop edge trim"});
  }

  // Smooth closed racetrack ribbon. No collision needed: it sits flush on the
  // physics ground. Actual grip zones are provided by vehicle-physics.js.
  const points=TRACK_POINTS.map(([x,z])=>new THREE.Vector3(x,0,z));
  const curve=new THREE.CatmullRomCurve3(points,true,"catmullrom",.34);
  const segments=216;
  function ribbon(width,y,m) {
    const vertices=[],uvs=[],indices=[];
    for(let i=0;i<=segments;i++){
      const t=i/segments;
      const point=curve.getPointAt(t),tangent=curve.getTangentAt(t).normalize();
      const normal=new THREE.Vector3(-tangent.z,0,tangent.x);
      for(const side of [-1,1]){
        const p=point.clone().addScaledVector(normal,width*side/2);
        vertices.push(p.x,y,p.z);
        uvs.push(side===-1?0:1,t*18);
      }
      if(i<segments){
        const k=i*2;indices.push(k,k+2,k+1,k+1,k+2,k+3);
      }
    }
    const geo=new THREE.BufferGeometry();
    geo.setAttribute("position",new THREE.Float32BufferAttribute(vertices,3));
    geo.setAttribute("uv",new THREE.Float32BufferAttribute(uvs,2));
    geo.setIndex(indices);geo.computeVertexNormals();
    const mesh=new THREE.Mesh(geo,m);
    mesh.receiveShadow=true;mesh.name="Painted race track";add(mesh);
    return mesh;
  }
  ribbon(12.0,.024,material(0x645c51,.97));
  ribbon(10.8,.032,material(theme.road,.93));

  // A little service entry puts the first gate straight ahead of the spawn:
  // the main loop is not immediately under the car at (0,0).
  paintPlane(0,6.8,8.4,13.6,material(theme.road,.93),.035);
  for(const x of [-4.0,4.0]) {
    paintPlane(x,6.8,.18,12.0,mat.white,.047);
  }
  for(const z of [1.6,3.9,6.2]) {
    paintPlane(0,z,1.15,.18,mat.yellow,.05);
  }
  const startTexture=labelTexture(THREE,["START","DRIVE TO THE FIRST GATE"],
    "#42413a","#ffe1af");
  if(startTexture) {
    const painted=new THREE.Mesh(
      new THREE.PlaneGeometry(4.6,2.3),
      new THREE.MeshBasicMaterial({map:startTexture,transparent:true,opacity:.87,depthWrite:false})
    );
    painted.rotation.x=-Math.PI/2;
    painted.position.set(0,.053,11.1);
    add(painted);
  }
  // Weathered edge lines in one instanced draw call.
  function stripes(side) {
    const count=94, geo=new THREE.BoxGeometry(.19,.013,.7);
    const inst=new THREE.InstancedMesh(geo,mat.white,count);
    const unit=new THREE.Object3D();
    for(let i=0;i<count;i++){
      const t=(i+.5)/count,p=curve.getPointAt(t),dir=curve.getTangentAt(t);
      unit.position.set(p.x-dir.z*side*4.8,.046,p.z+dir.x*side*4.8);
      unit.rotation.y=Math.atan2(dir.x,dir.z);
      unit.scale.set(1,1,1);unit.updateMatrix();
      inst.setMatrixAt(i,unit.matrix);
    }
    inst.instanceMatrix.needsUpdate=true;inst.castShadow=false;
    inst.name="Roadside dashed lane markers";
    add(inst);
  }
  stripes(-1);stripes(1);
  // Physical wooden crossing sections under each slalom exit, painted to be flush.
  for(let i=0;i<TRACK_POINTS.length;i++){
    const [x,z]=TRACK_POINTS[i];
    const point=new THREE.Vector3(x,0,z);
    const t=curve.getUtoTmapping(i/TRACK_POINTS.length);
    const direction=curve.getTangent(t);
    const marker=paintPlane(x,z,2.4,7.1,material(theme.edge,.7),.039,
      -Math.atan2(direction.x,direction.z));
    marker.material.transparent=true;marker.material.opacity=.22;
  }

  // Grippy surfaces already have painted physics patches. Overlay close-fitting
  // inset patterns to make dirt / frozen ice / rubber mechanically legible.
  const patches=[
    {x:20,z:-18,w:29,d:25,color:0xa97b51,lines:13},
    {x:-28,z:17,w:25,d:29,color:0xa9e1ef,lines:9},
    {x:9,z:34,w:26,d:19,color:0x212a2d,lines:14}
  ];
  patches.forEach((p,index)=>{
    const stripeMat=material(p.color,.65,0,{transparent:true,opacity:index===1?.24:.17,depthWrite:false});
    for(let i=0;i<p.lines;i++){
      const offset=(i+.5)/p.lines-.5;
      paintPlane(p.x+offset*(p.w-2),p.z,.075,p.d-2,stripeMat,.057);
    }
  });

  // Real modular roadside collision scenery. Keep the slalom lane clear.
  function cone(x,z,scale=1) {
    const group=new THREE.Group();
    const base=new THREE.Mesh(new THREE.BoxGeometry(.78*scale,.13*scale,.78*scale),mat.rubber);
    base.position.y=.07*scale;group.add(base);
    const con=new THREE.Mesh(new THREE.ConeGeometry(.35*scale,.9*scale,8),mat.enamel);
    con.position.y=.57*scale;group.add(con);
    const band=new THREE.Mesh(new THREE.CylinderGeometry(.19*scale,.24*scale,.14*scale,8),mat.white);
    band.position.y=.52*scale;group.add(band);
    group.position.set(x,0,z);
    group.traverse(o=>{if(o.isMesh){o.castShadow=true;o.receiveShadow=true;}});
    add(group);
    const body=world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x,.55*scale,z));
    const collider=world.createCollider(RAPIER.ColliderDesc.cuboid(.39*scale,.55*scale,.39*scale)
      .setFriction(.65),body);
    registerBody(body,group,collider,{type:"cone"});
    staticColliders.push(collider);
  }
  const cones=[
    [-36,-18],[-41,-13],[-42,-8],[-39,-2],
    [40,-28],[44,-23],[48,-18],
    [-34,35],[-39,30],[42,16],[46,11]
  ];
  cones.filter(([x,z])=>pathClearance(x,z)>5.9)
    .forEach(([x,z],i)=>cone(x,z,i%3===0?1.22:1));

  // Garage / pit station with functional posts and roof. Access stays open.
  // Flush painted service mat, with the real ground collider underneath.
  paintPlane(-53,7,23,17,mat.rubber,.036);
  for(const x of [-62,-44]){
    for(const z of [1,13]){
      block(x,3.4,z,.48,6.8,.48,mat.metal,{name:"Garage support"});
    }
  }
  block(-53,7.0,7,21,.55,15,mat.ink,{name:"Garage canopy roof"});
  block(-53,7.39,7,20,.12,14,mat.enamel,{collision:false});
  for(let i=0;i<4;i++){
    block(-59.5+i*4.2,6.66,7,2.3,.09,7,mat.lamp,{collision:false,castShadow:false});
  }
  // A mechanic's tools and packing crates: distinct shapes and material response.
  for(const [x,z,rot] of [[-57,16,0],[-51,16,.22],[-45,16,-.13],
                          [49,-34,.3],[53,-31,-.3],[45,-39,.1],[58,-41,-.16]]){
    if(pathClearance(x,z)<6.3)continue;
    const h=1.4 + (Math.abs(x+z)%3)*.25;
    block(x,h/2,z,2.1,h,2.0,mat.cardboard,{dynamic:true,yaw:rot,name:"Pushable delivery crate"});
    // Small colored lid printed onto the same moving rigid body would require
    // composing a multi-mesh rigidbody. Keep crate collision and art matched.
  }
  // A row of realistic tire stacks with fixed cylinders and safe placement.
  const tireGeo=new THREE.CylinderGeometry(.9,.9,.38,16);
  for(const [x,z] of [[-63,-3],[-59,-5],[62,13],[65,17],[64,21]]){
    for(let i=0;i<3;i++){
      const wheel=new THREE.Mesh(tireGeo,mat.rubber);
      wheel.position.set(x,.24+i*.38,z);
      wheel.castShadow=!lowQuality;wheel.receiveShadow=true;add(wheel);
    }
    const rb=world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x,.64,z));
    const collider=world.createCollider(RAPIER.ColliderDesc.cylinder(.64,.9),rb);
    registerBody(rb,null,collider,{type:"tire-stack"});
    staticColliders.push(collider);
  }
  // Lamp-posts and collision poles; emissive details stay inexpensive.
  for(const [x,z] of [[-43,26],[-4,48],[39,-45],[-50,-30],[48,38]]){
    if(pathClearance(x,z)<6.4)continue;
    block(x,4,z,.3,8,.3,mat.metal,{name:"Track floodlight column"});
    block(x,8,z,2,.44,1.1,mat.ink,{name:"Floodlight housing"});
    block(x,7.96,z+0.57,1.66,.24,.06,mat.lamp,{collision:false});
  }
  // Giant timing board is a physical slab (no clipping behind it).
  block(0,5.7,-57,18,8,.75,mat.ink,{name:"Club timing board"});
  const logo=labelTexture(THREE,["TINY MOTOR CLUB","WORKBENCH / TEST TRACK"],"#232f37","#ffdab1");
  if(logo) {
    const panel=new THREE.Mesh(new THREE.PlaneGeometry(16.7,7),
      new THREE.MeshBasicMaterial({map:logo,side:THREE.DoubleSide}));
    panel.position.set(0,5.8,-56.56);add(panel);
  }
  // Large playmat color islands away from the drivable route.
  for(const [x,z,w,d,yaw] of [[-53,34,23,14,-.08],[53,10,18,13,.1],[-58,-42,20,12,.18]]){
    paintPlane(x,z,w,d,material(0x725b48,.96),.018,yaw);
  }

  let elapsed=0;
  function update(dt) {
    elapsed+=dt;
    // Gentle fluorescent sign breathing, avoiding heavy postprocessing.
    mat.lamp.emissiveIntensity=.78+.13*Math.sin(elapsed*1.2);
  }
  return {update,stats:{meshes:decorations,boxes,physicalProps:staticColliders.length},
    trackCurve:curve,trackPoints:TRACK_POINTS};
}
