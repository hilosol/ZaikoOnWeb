@echo off
rem ==== Used by the scheduled task (no window, output goes to data\server.log) ====
rem Port (default 28003) and data folder are set in settings.bat.
cd /d "%~dp0"
call load-settings.bat
if not exist data mkdir data
node --disable-warning=ExperimentalWarning dist\server.mjs >> data\server.log 2>&1
