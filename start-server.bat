@echo off
chcp 65001 >nul
title Bili Recorder
cd /d "%~dp0"

echo ==============================
echo   Bili Recorder
echo ==============================
echo.
echo Starting server...
echo.
start /B node server.js
timeout /t 4 /nobreak >nul
echo Opening http://localhost:3456
start http://localhost:3456
echo.
echo Server running. Close this window to stop.
echo ============================================
pause >nul
