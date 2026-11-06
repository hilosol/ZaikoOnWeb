@echo off
rem ==== Run by the scheduled task "ZaikoWebUpdate" (the update button on the server PC's screen) ====
rem Do not run this file by hand. Use update.bat instead.
rem Output goes to data\update.log, the result to data\update-result.json (shown on the screen).
cd /d "%~dp0"
call load-settings.bat
if "%ZAIKO_DATA_DIR%"=="" set "ZAIKO_DATA_DIR=%~dp0data"
if not exist "%ZAIKO_DATA_DIR%" mkdir "%ZAIKO_DATA_DIR%"
set "ZAIKO_UPDATE_RESULT=%ZAIKO_DATA_DIR%\update-result.json"
rem Never show a sign-in window (nobody is watching). Allow running git as SYSTEM in this folder.
set GIT_TERMINAL_PROMPT=0
set GCM_INTERACTIVE=never
set GIT_CONFIG_COUNT=1
set GIT_CONFIG_KEY_0=safe.directory
set GIT_CONFIG_VALUE_0=*
echo.>> "%ZAIKO_DATA_DIR%\update.log"
echo ===== %date% %time% update from the screen >> "%ZAIKO_DATA_DIR%\update.log"
node scripts\update.mjs --unattended >> "%ZAIKO_DATA_DIR%\update.log" 2>&1
