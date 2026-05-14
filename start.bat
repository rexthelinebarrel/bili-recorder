@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================
echo   B站直播录制助手 - 持续录制模式
echo   按 Ctrl+C 退出
echo ============================================

:loop
echo [%date% %time%] 启动录制服务...
node server.js
echo [%date% %time%] 服务已停止，3秒后自动重启...
timeout /t 3 /nobreak >nul
goto loop
