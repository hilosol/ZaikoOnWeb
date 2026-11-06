@echo off
rem ==== Settings for this PC ====
rem settings.bat is created from this file on first run. Edit settings.bat, not this file.
rem settings.bat is NOT managed by GitHub, so update.bat keeps your changes.
rem
rem Port number (default 28003). After changing it:
rem   1. Run register-autostart.bat as administrator (firewall rule + restart).
rem   2. Reprint QR labels and update phone bookmarks (they contain the port).
set ZAIKO_PORT=28003
rem
rem To store data in another folder, remove "rem" below and edit the path.
rem set ZAIKO_DATA_DIR=D:\zaiko-data
