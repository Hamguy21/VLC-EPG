@echo off
REM Start the VLC EPG web UI, then open it in the default browser.
cd /d "%~dp0"
start "" http://127.0.0.1:8123
node server.js
