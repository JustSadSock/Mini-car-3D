const {test,expect}=require("@playwright/test");
const fs=require("node:fs");

async function loadGame(page){
  const errors=[];
  page.on("pageerror",error=>errors.push(error.message));
  await page.goto("/",{waitUntil:"domcontentloaded"});
  await expect(page.locator("#loadOverlay")).toBeHidden({timeout:65000});
  await expect(page.locator("#wrap canvas")).toBeVisible();
  await page.waitForTimeout(1100);
  expect(errors).toEqual([]);
}

test("desktop: render an active 3D diorama and drive",async({page},testInfo)=>{
  await page.setViewportSize({width:1440,height:900});
  await loadGame(page);
  const shot=await page.screenshot({path:testInfo.outputPath("desktop-workshop.png")});
  expect(shot.byteLength).toBeGreaterThan(40000);
  await page.keyboard.down("w");
  await page.waitForTimeout(1700);
  await page.keyboard.up("w");
  const speed=Number(await page.locator("#speedValue").innerText());
  expect(speed).toBeGreaterThan(0);
  await page.locator("#cameraBtn").click();
  await expect(page.locator("#cameraBtn")).toContainText("СВЕРХУ");
  await page.locator("#cameraBtn").click();
  await expect(page.locator("#cameraBtn")).toContainText("КАРТА");
  await page.locator("#cameraBtn").click();
  await expect(page.locator("#cameraBtn")).toContainText("ПОГОНЯ");
  await page.locator("#physicsBtn").click();
  await expect(page.locator("#physicsDebug")).toBeVisible();
  await page.locator("#resetBtn").click();
  await expect(page.locator("#courseStatus")).toContainText("Ворота 1/");
});

test("mobile portrait: viewport-safe controls and full world",async({page},testInfo)=>{
  await page.setViewportSize({width:390,height:844});
  await loadGame(page);
  await expect(page.locator("#driveActions button")).toHaveCount(5);
  await expect(page.locator("#brandPlate")).toBeVisible();
  const ids=["resetBtn","lightsBtn","recoverBtn","physicsBtn","cameraBtn"];
  for(const id of ids){
    const r=await page.locator("#"+id).boundingBox();
    expect(r).not.toBeNull();
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.x+r.width).toBeLessThanOrEqual(391);
    expect(r.y+r.height).toBeLessThanOrEqual(844);
  }
  await page.locator("#lightsBtn").click();
  await expect(page.locator("#lightsBtn")).toHaveAttribute("aria-pressed","false");
  await page.screenshot({path:testInfo.outputPath("mobile-workshop.png")});
});

test("landscape: camera and touch controls remain accessible",async({page},testInfo)=>{
  await page.setViewportSize({width:844,height:390});
  await loadGame(page);
  await page.locator("#cameraBtn").click();
  await page.screenshot({path:testInfo.outputPath("landscape-workshop.png")});
  await expect(page.locator("#cameraBtn")).toContainText("СВЕРХУ");
});
