@echo off
title KnowLattice Launcher
cd /d "%~dp0"

set "PORT=4173"
set "APP_URL=http://localhost:%PORT%"

echo ==========================================
echo    KnowLattice Launcher
echo ==========================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js not found on this PC.
  echo Please install Node.js LTS first:  https://nodejs.org/zh-cn
  echo Use the default options, then double-click this file again.
  echo.
  pause
  exit /b 1
)

netstat -ano | findstr ":%PORT%" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo Server is already running. Opening browser...
  start "" "%APP_URL%"
  exit /b 0
)

if /i "%~1"=="build" (
  echo Rebuilding the app, 1-2 min...
  call npm run build
  if errorlevel 1 (
    echo [ERROR] Build failed. See messages above.
    pause
    exit /b 1
  )
)

if not exist "node_modules" (
  echo [1/3] First run: installing dependencies, 1-5 min, needs internet...
  call npm install --allow-remote=all
  if errorlevel 1 (
    echo.
    echo Retrying in compatibility mode...
    call npm install
    if errorlevel 1 (
      echo [ERROR] npm install failed. Usually a network problem - check your internet and try again.
      pause
      exit /b 1
    )
  )
)

if not exist "dist\index.html" (
  echo [2/3] First run: building the app, 1-2 min...
  call npm run build
  if errorlevel 1 (
    echo [ERROR] Build failed. See messages above.
    pause
    exit /b 1
  )
)

echo [3/3] Starting local server. A minimized window "KnowLattice Server" will open.
echo       Keep it open while using the app; close it when done.
start "KnowLattice Server" /min cmd /c "npm run preview -- --port %PORT% --strictPort"

set /a tries=0
:waitloop
netstat -ano | findstr ":%PORT%" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 goto ready
ping -n 2 127.0.0.1 >nul 2>&1
set /a tries+=1
if %tries% LSS 30 goto waitloop

echo [ERROR] Server did not start within 30s. Check the "KnowLattice Server" window.
pause
exit /b 1

:ready
start "" "%APP_URL%"
echo.
echo Opened: %APP_URL%
echo Please use Chrome or Edge. Do not use Incognito mode.
ping -n 4 127.0.0.1 >nul 2>&1
exit /b 0
