@echo off
title B站直播录制助手
cd /d "%~dp0"

echo ==============================
echo   B站直播录制助手
echo ==============================
echo.
echo 启动服务中... 按 Ctrl+C 可停止
echo 浏览器打开 http://localhost:3456
echo.
start http://localhost:3456
node server.js
pause
