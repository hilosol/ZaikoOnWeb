@echo off
rem ==== Used by the scheduled task (no window, output goes to data\server.log) ====
set ZAIKO_PORT=28003
rem set ZAIKO_DATA_DIR=D:\zaiko-data
cd /d "%~dp0"
if not exist data mkdir data
node --disable-warning=ExperimentalWarning dist\server.mjs >> data\server.log 2>&1
