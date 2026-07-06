@echo off
setlocal
chcp 65001 >nul
title Claude Code Server

echo.
echo ============================================================
echo    Claude Code API Server
echo ============================================================
echo.
echo Select startup mode:
echo.
echo   [1] Local only (127.0.0.1) - safest
echo   [2] Network access (0.0.0.0) - for Android devices
echo   [3] Exit
echo.
set /p MODE=Enter option (1-3): 

if "%MODE%"=="1" goto local
if "%MODE%"=="2" goto public
if "%MODE%"=="3" goto end
echo.
echo Invalid option. Defaulting to local mode...
goto local

:local
echo.
echo ============================================================
echo    Starting local mode...
echo ============================================================
echo.
set SERVER_HOST=127.0.0.1
goto start

:public
echo.
echo ============================================================
echo    Starting network mode...
echo ============================================================
echo.
echo Detecting local IPv4 addresses...
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /i "IPv4"') do (
  echo   IPv4: %%a
)
echo.
echo Important:
echo  - Set SERVER_ACCESS_TOKEN in .env
echo  - Allow inbound TCP 3456 in Windows Firewall
echo.
set SERVER_HOST=0.0.0.0
goto start

:start
echo.
echo Starting server...
echo.
set SERVER_PORT=3456
set CLAUDE_CONFIG_DIR=%CD%\.runtime\android-claude-config
bun run src/server/index.ts

if errorlevel 1 (
  echo.
  echo Server startup failed.
  echo Check:
  echo   1. Bun is installed
  echo   2. .env configuration is correct
  echo.
)

:end
echo.
pause
endlocal
