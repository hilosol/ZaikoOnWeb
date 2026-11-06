@echo off
rem ==== Remove auto-start and firewall rule. Right-click > "Run as administrator" ====
net session >nul 2>&1
if errorlevel 1 (
  echo Please right-click this file and choose "Run as administrator".
  pause
  exit /b 1
)
schtasks /End /TN "ZaikoWeb" >nul 2>&1
schtasks /Delete /TN "ZaikoWeb" /F
schtasks /Delete /TN "ZaikoWebUpdate" /F >nul 2>&1
netsh advfirewall firewall delete rule name="ZaikoWeb"
pause
