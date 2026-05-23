@echo off
chcp 65001 >nul
title B站直播录制助手
cd /d "%~dp0"

echo ==============================
echo   B站直播录制助手
echo ==============================
echo.
echo 浏览器打开 http://localhost:3456
start http://localhost:3456

:loop
echo [%date% %time%] 启动录制服务...
echo.
node server.js

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ============================================
    echo   服务已正常关闭。
    echo ============================================
    pause
    exit /b 0
)

echo.
echo ============================================
echo   服务异常停止（退出码: %ERRORLEVEL%）
echo   5秒后自动重启，按 Ctrl+C 取消...
echo ============================================
timeout /t 5 /nobreak >nul
goto loop
