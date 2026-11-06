@echo off
rem ==== First-time setup: connect this folder to GitHub (hilosol/ZaikoOnWeb), then update ====
rem Put this file in the zaiko-web folder (the folder that has "data"), then double-click.
rem If auto-start is registered, right-click > "Run as administrator".
rem The "data" folder (database, photos, settings) is NOT touched.
rem Program files (bat files etc.) are replaced with the GitHub version.
cd /d "%~dp0"
set REPO=https://github.com/hilosol/ZaikoOnWeb.git

where git >nul 2>&1
if errorlevel 1 (
  echo Git is not installed. Install "Git for Windows" first: https://git-scm.com/download/win
  goto :fail
)
if exist ".git" (
  echo This folder is already connected to GitHub. Running update.bat instead.
  goto :update
)
if not exist "data" (
  echo WARNING: "data" folder was not found here: %CD%
  echo Make sure this file is in the zaiko-web folder that has the "data" folder.
  choice /M "Continue anyway"
  if errorlevel 2 goto :fail
)

echo.
echo This will replace the program files in:
echo   %CD%
echo with the latest version from GitHub. The "data" folder is kept.
choice /M "Continue"
if errorlevel 2 goto :fail

git init -b main || goto :fail
git remote add origin %REPO% || goto :fail
echo.
echo Connecting to GitHub. If a sign-in window appears, sign in with an account that can read the repository.
git fetch origin || goto :fail_fetch
git reset --hard origin/main || goto :fail
git branch --set-upstream-to=origin/main main || goto :fail
echo.
echo Connected to GitHub.

:update
if not exist "update.bat" (
  echo update.bat was not found after setup.
  goto :fail
)
call update.bat --force
exit /b 0

:fail_fetch
echo.
echo Could not get the files from GitHub (sign-in failed or no network).
echo The folder was prepared; run this file again to retry.
rmdir /s /q ".git"
:fail
echo.
echo Setup was not completed.
pause
exit /b 1
