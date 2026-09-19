@echo off
REM  Reinstalls everything. Use this if the app stopped working.
cd /d "%~dp0"
echo.
echo  This will reinstall the Python packages and Electron.
echo.
pause
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0scripts\launcher.ps1" -Reinstall -NoLaunch
pause
