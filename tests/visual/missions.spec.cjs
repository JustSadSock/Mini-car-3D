const {test,expect}=require("@playwright/test");
test.setTimeout(95000);

async function ready(page) {
 const errors=[];
 page.on("pageerror",err=>errors.push(err.message));
 await page.goto("/",{waitUntil:"domcontentloaded"});
 await expect(page.locator("#loadOverlay")).toBeHidden({timeout:65000});
 await expect(page.locator("#modeBtn")).toBeVisible();
 return errors;
}
test("missions: four modes open, start, reset and switch without losing gameplay",async({page},testInfo)=>{
 await page.setViewportSize({width:1440,height:900});
 const errors=await ready(page);
 await page.locator("#modeBtn").click();
 await expect(page.locator("#modePanel")).toBeVisible();
 await expect(page.locator("#modePanel [data-mode]")).toHaveCount(4);
 await page.screenshot({path:testInfo.outputPath("mode-board.png")});
 for(const [id,label] of [
   ["courier","КУРЬЕР"],["parking","ПАРКОВКА"],["stunt","ПОЛЁТ"],["slalom","СЛАЛОМ"]
 ]) {
   await page.locator("#modePanel [data-mode='"+id+"']").click();
   await expect(page.locator("#modePanel")).toBeHidden();
   await expect(page.locator("#modeName")).toHaveText(label);
   await page.locator("#modeBtn").click();
   await expect(page.locator("#modePanel")).toBeVisible();
 }
 await page.locator("#modeCloseBtn").click();
 await page.keyboard.down("w");
 try {
   // Software WebGL in CI may render at only a few frames per second;
   // wait for actual simulation advancement instead of a fixed wall clock.
   await expect.poll(async()=>Number(await page.locator("#speedValue").textContent()),
     {timeout:18000,intervals:[400,800,1500]}).toBeGreaterThan(0);
 } finally {
   await page.keyboard.up("w");
 }
 await page.locator("#resetBtn").click();
 await expect(page.locator("#courseStatus")).toContainText("Ворота 1/");
 expect(errors).toEqual([]);
});
test("courier, parking and stunt HUD show actual mission targets",async({page},testInfo)=>{
 await page.setViewportSize({width:1270,height:780});
 const errors=await ready(page);
 for(const mode of ["courier","parking","stunt"]) {
   await page.locator("#modeBtn").click();
   await page.locator("#modePanel [data-mode='"+mode+"']").click();
   const progress=await page.locator("#modeProgress").textContent();
   expect(progress).toMatch(/0\/(4|3|2)/);
   await page.keyboard.down("w");
   await page.waitForTimeout(500);
   await page.keyboard.up("w");
   await page.screenshot({path:testInfo.outputPath(mode+"-in-world.png")});
   await page.locator("#resetBtn").click();
 }
 expect(errors).toEqual([]);
});
test.describe("touch mission selection",()=>{
 test.use({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:2});
 test("mission board and controls fit a real touch viewport",async({page},testInfo)=>{
   const errors=await ready(page);
   await page.locator("#modeBtn").tap();
   await expect(page.locator("#modePanel")).toBeVisible();
   const menu=page.locator("#modePanel [data-mode='parking']");
   await menu.scrollIntoViewIfNeeded();
   await menu.tap();
   await expect(page.locator("#modeName")).toHaveText("ПАРКОВКА");
   await page.locator("#modeBtn").tap();
   await page.screenshot({path:testInfo.outputPath("mobile-missions.png")});
   await page.locator("#modeCloseBtn").tap();
   await page.locator("#cameraBtn").tap();
   await expect(page.locator("#cameraBtn")).toContainText("СВЕРХУ");
   expect(errors).toEqual([]);
 });
});
