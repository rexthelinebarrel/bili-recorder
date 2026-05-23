@echo off
title B站直播录制助手
cd /d "%~dp0"

echo ==============================
echo   B站直播录制助手
echo ==============================
echo.

REM 清理已占用 3456 端口的旧进程
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3456.*LISTENING"') do (
    echo 关闭旧进程 PID %%a...
    taskkill /F /PID %%a >nul 2>&1
    timeout /t 1 /nobreak >nul
)

echo 启动服务中... 按 Ctrl+C 可停止
echo.
start /B node server.js
timeout /t 3 /nobreak >nul
echo 浏览器打开 http://localhost:3456
start http://localhost:3456
echo.
echo 服务运行中，关闭此窗口可停止服务。
pause >nul
