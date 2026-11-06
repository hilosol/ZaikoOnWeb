@echo off
rem ==== Zaiko (inventory) server - start in this window ====
rem Port (default 28003) and data folder are set in settings.bat.
cd /d "%~dp0"
call load-settings.bat
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install Node.js 24 LTS from https://nodejs.org/
  pause
  exit /b 1
)
node dist\check-node.cjs || (pause & exit /b 1)
node --disable-warning=ExperimentalWarning dist\server.mjs
pause
