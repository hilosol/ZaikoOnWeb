@echo off
rem ==== Register auto-start and firewall rule. Right-click > "Run as administrator" ====
net session >nul 2>&1
if errorlevel 1 (
  echo Please right-click this file and choose "Run as administrator".
  pause
  exit /b 1
)
set PORT=28003
cd /d "%~dp0"
rem Stop the server if it is already running (so the new port setting takes effect)
schtasks /End /TN "ZaikoWeb" >nul 2>&1
rem Start at PC boot (even before anyone logs on), as SYSTEM
schtasks /Create /TN "ZaikoWeb" /TR "\"%~dp0run-server.bat\"" /SC ONSTART /RU SYSTEM /RL HIGHEST /F
rem Allow access only from the same subnet (local network) on private/domain networks
netsh advfirewall firewall delete rule name="ZaikoWeb" >nul 2>&1
netsh advfirewall firewall add rule name="ZaikoWeb" dir=in action=allow protocol=TCP localport=%PORT% profile=private,domain remoteip=localsubnet
schtasks /Run /TN "ZaikoWeb"
echo.
echo Done. The server starts automatically when this PC boots.
pause
