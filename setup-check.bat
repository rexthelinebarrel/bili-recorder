@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================
echo   B站直播录制助手 — 环境检查
echo ============================================
echo.

set OK=1

:: --- Node.js ---
echo [1/2] 检查 Node.js...
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo   ❌ 未找到 Node.js
    echo   👉 请到 https://nodejs.org 下载安装 LTS 版本
    echo     安装完成后重新运行本脚本
    set OK=0
) else (
    for /f "tokens=*" %%i in ('node --version') do echo   ✅ Node.js %%i
)
echo.

:: --- ffmpeg ---
echo [2/2] 检查 ffmpeg...
where ffmpeg >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    for /f "tokens=*" %%i in ('ffmpeg -version 2^>nul ^| findstr "ffmpeg version"') do echo   ✅ ffmpeg 已就绪 ^(PATH^)
    goto :ffmpeg_ok
)

:: Try winget install path
if exist "%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg_*" (
    echo   ✅ ffmpeg 已找到 ^(winget安装^)
    goto :ffmpeg_ok
)

echo   ❌ 未找到 ffmpeg
echo   👉 安装方式（任选其一）：
echo      1. winget install Gyan.FFmpeg   ^(推荐，自动配置^)
echo      2. 到 https://ffmpeg.org/download.html 下载
echo         解压后将 bin 目录加入系统 PATH
set OK=0

:ffmpeg_ok
echo.

:: --- Result ---
if %OK% EQU 1 (
    echo ============================================
    echo   ✅ 环境检查通过！可以启动录制助手：
    echo     双击 start.bat 或在终端运行 node server.js
    echo     浏览器打开 http://localhost:3456
    echo ============================================
) else (
    echo ============================================
    echo   ⚠️  请先安装缺少的依赖，再重新运行本脚本
    echo ============================================
)

pause
