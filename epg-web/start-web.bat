@echo off
setlocal EnableExtensions
REM VLC EPG web server launcher (Windows)
REM Uses a system Node.js if present; otherwise downloads a portable Node into
REM .node/ (no admin, no system install) on first run.
cd /d "%~dp0"

where node >nul 2>nul
if not errorlevel 1 (
  node server.js
  exit /b %errorlevel%
)

set "NODE_DIR=%~dp0.node\node-v20.19.4-win-x64"
if exist "%NODE_DIR%\node.exe" goto :run

if not exist "%~dp0.node" mkdir "%~dp0.node"
cd /d "%~dp0.node"
echo Downloading portable Node.js (first run only)...
curl -sSL -o node.zip "https://nodejs.org/dist/v20.19.4/node-v20.19.4-win-x64.zip"
tar -xf node.zip
del node.zip
if errorlevel 1 goto :manual

:run
"%NODE_DIR%\node.exe" "%~dp0server.js"
exit /b %errorlevel%

:manual
echo.
echo Could not download Node.js automatically. Install it from https://nodejs.org
echo then run "node server.js" in this folder, or open http://127.0.0.1:8123/
exit /b 1
