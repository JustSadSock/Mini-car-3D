const {defineConfig}=require("@playwright/test");
module.exports=defineConfig({
  testDir:"./tests/visual",
  timeout:90000,
  expect:{timeout:45000},
  fullyParallel:false,
  retries:1,
  workers:1,
  reporter:[["list"],["html",{outputFolder:"playwright-report",open:"never"}]],
  outputDir:"test-results",
  use:{
    baseURL:"http://127.0.0.1:3000",
    browserName:"chromium",
    headless:true,
    screenshot:"only-on-failure",
    trace:"retain-on-failure",
    launchOptions:{
      args:["--enable-webgl","--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader",
            "--disable-dev-shm-usage"]
    }
  },
  webServer:{
    command:"npm start",
    url:"http://127.0.0.1:3000/health",
    reuseExistingServer:!process.env.CI,
    timeout:60000
  }
});
