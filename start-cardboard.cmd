@echo off
rem Starts Cardboard, online with Tailscale. Double-click it, or let "node src/cli.ts autostart on"
rem start it when you sign in to Windows. It gets the newest version first (and keeps getting them while it runs),
rem and starts again if it stops.
title Cardboard
cd /d "%~dp0"
:again
where git >nul 2>nul && git pull --ff-only
rem --self-update: while it runs, a newer version stops it (every hour it looks), and this starts it again on that.
node src/cli.ts start --tunnel tailscale --self-update
echo.
echo Cardboard stopped. It starts again in 15 seconds. Close this window to keep it off.
timeout /t 15 /nobreak >nul
goto again
