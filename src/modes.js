// Tiny Motor Club: independent, testable challenge rules.
// No renderer, network or DOM dependencies. Inputs are measurements from Rapier.
export const MODE_ORDER = Object.freeze(["slalom", "courier", "parking", "stunt"]);
export const MODE_CONFIG = Object.freeze({
  slalom: { name:"СЛАЛОМ", subtitle:"9 ворот · на время",
    description:"Пройди девять ворот по порядку. Чем быстрее — тем выше медаль.",
    start:{x:0,z:0,yaw:0},better:"min",medals:[30,42,60] },
  courier: { name:"КУРЬЕР",subtitle:"2 доставки · целый груз",
    description:"Остановись в зоне погрузки, довези посылку к складу и вернись. Сильные удары повреждают груз.",
    start:{x:-53,z:-12,yaw:0},better:"min",medals:[55,75,110]},
  parking: { name:"ПАРКОВКА",subtitle:"3 места · точность",
    description:"Встань в выделенный карман, выровняй автомобиль по стрелке и удерживай его без движения.",
    start:{x:-43,z:-28,yaw:0},better:"min",medals:[55,85,125]},
  stunt: { name:"ПОЛЁТ",subtitle:"2 трамплина · время в воздухе",
    description:"Разгонись, взлети с трамплина и приземлись на колёса. Повтори на второй рампе.",
    start:{x:-45,z:-57,yaw:0},better:"max",medals:[1.6,1.15,0.7]}
});
export const COURIER_STOPS = Object.freeze([
  {x:-53,z:7,kind:"pickup",title:"Забрать посылку"},
  {x:40,z:-27,kind:"drop",title:"Доставить на склад"},
  {x:40,z:-27,kind:"pickup",title:"Забрать обратный груз"},
  {x:-53,z:7,kind:"drop",title:"Вернуться в мастерскую"}
]);
export const PARKING_SPOTS = Object.freeze([
  {x:-55,z:-16,yaw:0,title:"Место 01"},
  {x:52,z:9,yaw:Math.PI/2,title:"Место 02"},
  {x:-48,z:43,yaw:0,title:"Место 03"}
]);
export const STUNT_RAMPS = Object.freeze([
  {x:-45,z:-39,start:{x:-45,z:-57,yaw:0},title:"Деревянный трамплин"},
  {x:46,z:38,start:{x:46,z:20,yaw:0},title:"Стальной трамплин"}
]);

const STORAGE_KEY="mini-car-3d:activity-records:v1";
const finite=(v,otherwise=0)=>Number.isFinite(v)?v:otherwise;
const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
export function angleDifference(a,b) {
  return Math.abs(Math.atan2(Math.sin(a-b),Math.cos(a-b)));
}
export function medalFor(id,value) {
  const cfg=MODE_CONFIG[id];
  if(!cfg||!Number.isFinite(value))return null;
  const [gold,silver,bronze]=cfg.medals;
  if(cfg.better==="min")return value<=gold?"gold":value<=silver?"silver":
    value<=bronze?"bronze":"finish";
  return value>=gold?"gold":value>=silver?"silver":
    value>=bronze?"bronze":"finish";
}
const medalRank={finish:1,bronze:2,silver:3,gold:4};
function readRecords(storage) {
  try {
    const raw=JSON.parse(storage?.getItem(STORAGE_KEY)||"{}");
    const result={};
    for(const id of MODE_ORDER) {
      const record=raw?.[id];
      if(record && Number.isFinite(record.value) && record.value>0 &&
         (record.medal in medalRank)) {
        result[id]={value:record.value,medal:record.medal};
      }
    }
    return result;
  } catch(_) {return {};}
}

export function createModeEngine({storage=null,onComplete=()=>{},onEvent=()=>{}}={}) {
  const records=readRecords(storage);
  let id="slalom",elapsed=0,step=0,hold=0,carrying=false,
    damage=0,penalties=0,totalAir=0,airTime=0,airStart=null,armed=false,
    lastGrounded=true,completed=false,hasMoved=false,hint="",events=[];
  const reset=()=>{
    elapsed=0;step=0;hold=0;carrying=false;damage=0;penalties=0;
    totalAir=0;airTime=0;airStart=null;armed=false;lastGrounded=true;
    completed=false;hasMoved=false;hint="";events=[];
  };
  function select(next){
    if(!MODE_CONFIG[next])throw new Error("Unknown mode: "+next);
    id=next;reset();return {...MODE_CONFIG[id].start};
  }
  function target() {
    if(id==="courier")return COURIER_STOPS[Math.min(step,COURIER_STOPS.length-1)];
    if(id==="parking")return PARKING_SPOTS[Math.min(step,PARKING_SPOTS.length-1)];
    if(id==="stunt")return STUNT_RAMPS[Math.min(step,STUNT_RAMPS.length-1)];
    return null;
  }
  const emit=(type,payload={})=>{const event={type,...payload};events.push(event);onEvent(event)};
  const consumeEvents=()=>events.splice(0);
  function complete(score,extra={}) {
    if(completed)return;
    completed=true;
    score=Math.max(.001,score);
    const old=records[id], cfg=MODE_CONFIG[id];
    const improved=!old||(cfg.better==="min"?score<old.value:score>old.value);
    const medal=medalFor(id,score);
    if(improved) {
      records[id]={value:score,medal};
      try {storage?.setItem(STORAGE_KEY,JSON.stringify(records));}
      catch(_) { /* private mode / embedded storage may be blocked */ }
    } else if(medalRank[medal]>medalRank[old.medal]) {
      // More prestigious medal can never be lost to a previous record.
      records[id]={...old,medal};
      try {storage?.setItem(STORAGE_KEY,JSON.stringify(records));}catch(_){}
    }
    const result={id,value:score,medal,record:records[id],
      improved,elapsed,penalties,damage,...extra};
    emit("complete",{result});
    onComplete(result);
  }
  function registerSlalom(seconds) {
    if(id!=="slalom" || completed || !(seconds>0))return;
    elapsed=seconds;complete(seconds);
  }
  function impact(strength) {
    if(completed||id!=="courier"||!carrying||!(strength>0.9))return;
    damage+=1;
    penalties+=3;
    emit("damage",{damage});
    if(damage>=3) {
      carrying=false;
      damage=0;
      penalties+=6;
      // Return to the current pickup rather than granting free delivery.
      step=Math.max(0,step-1);
      hold=0;
      emit("cargo-lost");
    }
  }
  function update(dt,sample={}) {
    if(completed||id==="slalom")return;
    dt=clamp(finite(dt),0,.1);
    if(dt===0)return;
    const position=sample.position||{x:0,y:0,z:0};
    const speed=Math.abs(finite(sample.speed));
    const horizontal=Math.hypot(finite(sample.vx),finite(sample.vz));
    const grounded=Boolean(sample.grounded);
    if(speed>0.65 || horizontal>0.65)hasMoved=true;
    if(hasMoved)elapsed+=dt;
    const t=target();
    if(!t)return;
    const distance=Math.hypot(position.x-t.x,position.z-t.z);
    if(id==="courier") {
      const close=distance<3.4 && speed<1.8 && grounded;
      hold=close?hold+dt:Math.max(0,hold-dt*2.5);
      const loadTime=1.1;
      hint=close?`Удерживайте тормоз · ${Math.max(0,loadTime-hold).toFixed(1)} с`:
        `${t.title} · ${Math.round(distance)} м`;
      if(hold>=loadTime) {
        hold=0;step+=1;
        carrying=t.kind==="pickup";
        if(!carrying)damage=0;
        emit(t.kind==="pickup"?"loaded":"delivered",{step,carrying});
        if(step>=COURIER_STOPS.length)complete(elapsed+penalties,
          {deliveries:2});
      }
    }else if(id==="parking"){
      const aligned=angleDifference(finite(sample.yaw),t.yaw)<.37 ||
        angleDifference(finite(sample.yaw),t.yaw+Math.PI)<.37;
      const inside=distance<2.4 && speed<.95 && grounded && aligned;
      hold=inside?hold+dt:Math.max(0,hold-dt*3);
      hint=distance>=2.4?`${t.title} · ${Math.round(distance)} м`:
        !aligned?"Выровняйте машину по стрелке":
        speed>=.95?"Полностью остановитесь":
        `Зафиксируйте машину · ${Math.max(0,1.65-hold).toFixed(1)} с`;
      if(hold>=1.65){
        step+=1;hold=0;
        emit("parked",{step});
        if(step>=PARKING_SPOTS.length)complete(elapsed,{spots:3});
      }
    }else if(id==="stunt"){
      // Start tracking only after driving toward the current physical ramp.
      if(lastGrounded&&!grounded &&
         distance<14 && (speed>3.5||horizontal>3.5)) {
        armed=true;airTime=0;
        airStart={x:position.x,z:position.z};
      }
      if(armed&&!grounded)airTime+=dt;
      if(armed&&grounded){
        const travelled=airStart?Math.hypot(position.x-airStart.x,
          position.z-airStart.z):0;
        const valid=airTime>=.24 && travelled>=1.2 && position.y>-.2;
        if(valid) {
          totalAir+=airTime;step+=1;
          emit("landed",{step,airTime,travelled});
          if(step>=STUNT_RAMPS.length){
            complete(totalAir,{jumps:2});
          }else {
            const next=STUNT_RAMPS[step];
            emit("next-ramp",{start:next.start});
          }
        }else {
          emit("short-jump",{airTime});
        }
        armed=false;airStart=null;airTime=0;
      }
      lastGrounded=grounded;
      hint=armed?`ПОЛЁТ · ${airTime.toFixed(2)} с`:
        `${t.title} · ${Math.round(distance)} м`;
    }
  }
  function getState() {
    return {
      id,config:MODE_CONFIG[id],elapsed,step,hold,carrying,damage,penalties,
      totalAir,airTime,completed,hint,target:target(),hasMoved,
      progress: id==="courier" ? step+"/4":
        id==="parking"?step+"/3":id==="stunt"?step+"/2":"0/9",
      record:records[id]||null
    };
  }
  return {select,reset,update,impact,registerSlalom,complete,
    getState,getRecords:()=>({...records}),consumeEvents};
}
