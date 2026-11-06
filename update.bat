@echo off
rem ==== Update from GitHub: get latest, build, restart ====
rem If auto-start is registered, right-click > "Run as administrator" (needed to restart the server).
cd /d "%~dp0"
where git >nul 2>&1
if errorlevel 1 (
  echo Git is not installed. Install "Git for Windows": https://git-scm.com/download/win
  pause
  exit /b 1
)
schtasks /Query /TN "ZaikoWeb" >nul 2>&1
if not errorlevel 1 (
  net session >nul 2>&1
  if errorlevel 1 (
    echo Auto-start is registered. Please right-click this file and choose "Run as administrator".
    pause
    exit /b 1
  )
)
node scripts\check-node.cjs
if errorlevel 1 (
  pause
  exit /b 1
)
node scripts\update.mjs %*
pause
