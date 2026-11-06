@echo off
rem ==== Zaiko (inventory) server - start in this window ====
rem Change the port here if 28003 is already used (also change run-server.bat and register-autostart.bat).
set ZAIKO_PORT=28003
rem To store data in another folder, remove "rem" below and edit the path.
rem set ZAIKO_DATA_DIR=D:\zaiko-data

cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install Node.js 24 LTS from https://nodejs.org/
  pause
  exit /b 1
)
node dist\check-node.cjs || (pause & exit /b 1)
node --disable-warning=ExperimentalWarning dist\server.mjs
pause
