@echo off
title iPad Restock Screen
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org then run this again. & pause & exit /b 1)
:loop
node server.js
echo.
echo Server stopped. Restarting in 3 seconds... (close this window to stop)
timeout /t 3 /nobreak >nul
goto loop
