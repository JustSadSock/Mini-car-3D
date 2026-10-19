const {test,expect}=require("@playwright/test");
const WebSocket=require("ws");

function peer(){
  const ws=new WebSocket("ws://127.0.0.1:3000/ws");
  const messages=[];
  ws.on("message",raw=>{
    try{messages.push(JSON.parse(raw.toString()));}catch(_){}
  });
  const wait=async(type,timeout=10000)=>{
    const until=Date.now()+timeout;
    while(Date.now()<until){
      const result=messages.find(x=>x.type===type);
      if(result)return result;
      await new Promise(resolve=>setTimeout(resolve,35));
    }
    throw new Error("Waiting for "+type+"; got "+messages.map(x=>x.type));
  };
  return {ws,messages,wait};
}
test("browser host, guest, isolated room and resumable co-op convoy",async({page},testInfo)=>{
  test.setTimeout(100000);
  const errors=[];
  page.on("pageerror",error=>errors.push(error.message));
  await page.setViewportSize({width:1350,height:850});
  await page.goto("/",{waitUntil:"domcontentloaded"});
  await expect(page.locator("#loadOverlay")).toBeHidden({timeout:65000});
  await expect(page.locator("#netStatus")).toContainText(/Автономная мастерская|ОДИНОЧНАЯ/);
  await page.locator("#onlineBtn").click();
  await expect(page.locator("#onlinePanel")).toBeVisible();
  await page.locator("#driverName").fill("Host");
  await page.locator("#createLobbyBtn").click();
  await expect(page.locator("#lobbyConnected")).toBeVisible({timeout:12000});
  const code=(await page.locator("#roomCode").textContent()).trim();
  expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
  await expect(page.locator(".lobby-member")).toHaveCount(1);
  const guest=peer();
  await guest.wait("welcome");
  guest.ws.send(JSON.stringify({type:"name",name:"Guest"}));
  guest.ws.send(JSON.stringify({type:"join-room",code}));
  const joined=await guest.wait("room");
  expect(joined.members).toHaveLength(2);
  await expect(page.locator(".lobby-member")).toHaveCount(2,{timeout:12000});
  await expect.poll(()=>guest.last("physics")?.players?.length,{timeout:15000}).toBe(2);
  await expect.poll(()=>guest.last("physics")?.props?.length,{timeout:15000}).toBe(3);
  const original=guest.last("physics").players.find(p=>p.id===guest.last("welcome").id);
  expect(original).toBeTruthy();
  for(let i=0;i<18;i++){
    guest.ws.send(JSON.stringify({type:"input",input:{x:0,y:1,seq:i+1}}));
    await page.waitForTimeout(55);
  }
  await expect.poll(()=>{
    const current=guest.last("physics")?.players.find(p=>p.id===original.id);
    return current?.p[2]||0;
  },{timeout:16000}).toBeGreaterThan(original.p[2]+.35);
  await expect(page.locator("#startConvoyBtn")).toBeEnabled();
  await page.locator("#startConvoyBtn").click();
  await guest.wait("race-start");
  await expect(page.locator("#convoyHud")).toBeVisible();
  await expect(page.locator("#convoyStage")).toContainText("1/4");
  await page.screenshot({path:testInfo.outputPath("private-coop-convoy.png")});

  const token=(await guest.wait("welcome")).token;
  guest.ws.close();
  await expect(page.locator(".lobby-member.offline")).toHaveCount(1,{timeout:15000});
  const resumed=peer();
  await resumed.wait("welcome");
  resumed.ws.send(JSON.stringify({type:"resume",token}));
  const welcome=await resumed.wait("welcome");
  // Both provisional and restored welcome may exist; await actual resumed welcome.
  await expect.poll(()=>resumed.messages.some(x=>x.type==="welcome"&&x.resumed),
    {timeout:12000}).toBeTruthy();
  await expect(page.locator(".lobby-member.offline")).toHaveCount(0,{timeout:12000});
  await expect(page.locator(".lobby-member")).toHaveCount(2);
  resumed.ws.close();
  expect(errors).toEqual([]);
});
