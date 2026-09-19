@echo off
REM ---------------------------------------------------------------------
REM  Arabic Live Notes
REM
REM  Double-click this file to start the app.
REM
REM  The first time, it installs everything it needs and puts a shortcut
REM  on your desktop. After that it opens straight away.
REM ---------------------------------------------------------------------
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0scripts\launcher.ps1"
if errorlevel 1 pause
