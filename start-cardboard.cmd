@echo off
rem Starts Cardboard, online with Tailscale. Double-click it, or let "node src/cli.ts autostart on"
rem start it when you sign in to Windows. It gets the newest version first, and starts again if it stops.
title Cardboard
cd /d "%~dp0"
:again
where git >/dev/null 2>/dev/null && git pull --ff-only
node src/cli.ts start --tunnel tailscale
echo.
echo Cardboard stopped. It starts again in 15 seconds. Close this window to keep it off.
timeout /t 15 /nobreak >nul
goto again
