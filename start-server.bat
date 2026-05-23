@echo off
chcp 65001 >nul
title B站直播录制助手
cd /d "%~dp0"

echo ==============================
echo   B站直播录制助手
echo ==============================
echo.
echo 启动服务中...
echo.
start /B node server.js
timeout /t 4 /nobreak >nul
echo 浏览器打开 http://localhost:3456
start http://localhost:3456
echo.
echo 服务运行中，关闭此窗口可停止服务。
echo ============================================
pause >nul
