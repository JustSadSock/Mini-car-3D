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

echo Launching Cloudflare tunnel (irgri-tunnel)...
start "Cloudflare Tunnel" cmd /k "cloudflared tunnel --config \"%~dp0cloudflared-config.yml\" run"

echo Processes started. Windows will stay open for logs and errors.
endlocal
