@echo off
setlocal enableextensions
cd /d "%~dp0"

echo ===== Mini Car 3D local server =====
if not exist node_modules (
  echo Installing npm dependencies...
  npm install
)

echo Launching Node.js server on port 3000...
start "Mini Car 3D server" cmd /k "node server.js"

set "CLOUDFLARE_DIR=%USERPROFILE%\.cloudflared"
set "CLOUDFLARE_CONFIG=%CLOUDFLARE_DIR%\config.yml"
if not exist "%CLOUDFLARE_DIR%" mkdir "%CLOUDFLARE_DIR%"
copy /y "%~dp0cloudflared-config.yml" "%CLOUDFLARE_CONFIG%" >nul

echo Launching Cloudflare tunnel (irgri-tunnel) using %CLOUDFLARE_CONFIG%...
start "Cloudflare Tunnel" cmd /k "cloudflared tunnel --config \"%CLOUDFLARE_CONFIG%\" run"

echo Processes started. Windows will stay open for logs and errors.
endlocal
