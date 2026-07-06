@echo off
setlocal
chcp 65001 >nul
title Claude Code Server - Network Access

echo.
echo ============================================================
echo    Claude Code API Server - Network Mode
echo ============================================================
echo.

echo [1/3] Checking configuration...
if not exist .env (
  echo ERROR: .env file not found.
  pause
  exit /b 1
)

echo [2/3] Detecting local IPv4 addresses...
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /i "IPv4"') do (
  echo   IPv4: %%a
)
echo.
echo [3/3] Starting server...
echo.
echo ============================================================
echo  Settings:
echo    Host: 0.0.0.0
echo    Port: 3456
echo    Auth: enabled (requires access token)
echo ============================================================
echo.
echo Important:
echo  1. Set SERVER_ACCESS_TOKEN in .env
echo  2. Allow inbound TCP 3456 in Windows Firewall
echo  3. Keep Android device on the same LAN
echo.
echo Press Ctrl+C to stop the server.
echo.

set SERVER_HOST=0.0.0.0
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
  pause
)

endlocal
