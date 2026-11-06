@echo off
rem ==== DEMO server (for trying out / explaining). NOT the real inventory. ====
rem Uses the "demo-data" folder and port 28004, so the real data and server (28003) are not affected.
rem To open it from other PCs/phones, allow port 28004 once (admin PowerShell):
rem   New-NetFirewallRule -DisplayName "ZaikoWeb DEMO 28004" -Direction Inbound -Protocol TCP -LocalPort 28004 -Action Allow -Profile Private,Domain -RemoteAddress LocalSubnet
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install Node.js 24 LTS from https://nodejs.org/
  pause
  exit /b 1
)
if not exist "demo-data\DEMO.txt" (
  echo The "demo-data" folder was not found in %CD%
  echo Copy the demo-data folder here, then run this file again.
  pause
  exit /b 1
)
node dist\check-node.cjs || (pause & exit /b 1)
set ZAIKO_DATA_DIR=%~dp0demo-data
set ZAIKO_PORT=28004
set ZAIKO_DEMO=1
echo Starting DEMO server: http://localhost:28004/
node --disable-warning=ExperimentalWarning dist\server.mjs
pause
