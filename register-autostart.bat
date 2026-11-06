@echo off
rem ==== Register auto-start and firewall rule. Right-click > "Run as administrator" ====
net session >nul 2>&1
if errorlevel 1 (
  echo Please right-click this file and choose "Run as administrator".
  pause
  exit /b 1
)
cd /d "%~dp0"
rem Port (default 28003) is set in settings.bat.
call load-settings.bat
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install Node.js 24 LTS from https://nodejs.org/
  pause
  exit /b 1
)
node -e "const p=Number(process.env.ZAIKO_PORT);process.exit(Number.isInteger(p)&&p>=1&&p<=65535?0:1)"
if errorlevel 1 (
  echo The port in settings.bat is not valid: "%ZAIKO_PORT%"
  echo Set a number from 1 to 65535, for example: set ZAIKO_PORT=28003
  pause
  exit /b 1
)
echo Port: %ZAIKO_PORT%
rem Stop the server if it is already running (so the new port setting takes effect)
schtasks /End /TN "ZaikoWeb" >nul 2>&1
rem Start at PC boot (even before anyone logs on), as SYSTEM
schtasks /Create /TN "ZaikoWeb" /TR "\"%~dp0run-server.bat\"" /SC ONSTART /RU SYSTEM /RL HIGHEST /F
rem Task for the update button on this PC's screen (started only from the screen; never runs on a schedule)
schtasks /Create /TN "ZaikoWebUpdate" /TR "\"%~dp0update-task.bat\"" /SC ONCE /ST 00:00 /SD 2000/01/01 /RU SYSTEM /RL HIGHEST /F >nul 2>&1
if errorlevel 1 schtasks /Create /TN "ZaikoWebUpdate" /TR "\"%~dp0update-task.bat\"" /SC ONCE /ST 00:00 /RU SYSTEM /RL HIGHEST /F
rem Allow access only from the same subnet (local network) on private/domain networks
netsh advfirewall firewall delete rule name="ZaikoWeb" >nul 2>&1
netsh advfirewall firewall add rule name="ZaikoWeb" dir=in action=allow protocol=TCP localport=%ZAIKO_PORT% profile=private,domain remoteip=localsubnet
schtasks /Run /TN "ZaikoWeb"
echo.
echo Done. The server starts automatically when this PC boots.
pause
