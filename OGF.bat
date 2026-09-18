@echo off
setlocal EnableExtensions
title Obscure Game Finder - dev server

rem Always run from the folder this script lives in, however it was launched.
cd /d "%~dp0"

set "PORT=3000"
set "URL=http://localhost:%PORT%"

echo.
echo  ==============================================
echo   Obscure Game Finder  -  development launcher
echo  ==============================================
echo.

rem --- 1. Node.js must be installed ----------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo  [OGF] Node.js was not found on PATH.
  echo        Install the LTS release from https://nodejs.org/ and run this again.
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node --version') do set "NODE_VERSION=%%v"
echo  [OGF] Node.js %NODE_VERSION%

rem --- 2. Install dependencies ONLY when they are missing --------------------
if not exist "node_modules\" (
  echo  [OGF] node_modules not found - running npm install once...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo  [OGF] npm install failed. See the output above.
    pause
    exit /b 1
  )
  echo.
) else (
  echo  [OGF] Dependencies present - skipping npm install.
)

rem --- 3. Do not start a second server on the same port ----------------------
netstat -ano -p tcp 2>nul | findstr /r /c:":%PORT% .*LISTENING" >nul
if not errorlevel 1 (
  echo  [OGF] Something is already listening on port %PORT% - is OGF already running?
  echo        Opening %URL% instead of starting a second server.
  start "" "%URL%"
  echo.
  pause
  exit /b 0
)

rem --- 4. Open the browser as soon as the server actually answers ------------
rem Background watcher: polls the port (for up to 2 minutes) instead of sleeping
rem a fixed time, then opens the URL in the default browser and exits.
start "" /b powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$deadline = (Get-Date).AddSeconds(120);" ^
  "while ((Get-Date) -lt $deadline) {" ^
  "  $c = New-Object System.Net.Sockets.TcpClient;" ^
  "  try { $c.Connect('localhost', %PORT%); if ($c.Connected) { Start-Process '%URL%'; exit 0 } } catch {} finally { $c.Dispose() };" ^
  "  Start-Sleep -Milliseconds 500" ^
  "}"

rem --- 5. Run the dev server in THIS window so its output stays visible ------
echo  [OGF] Starting: npm run dev   (Ctrl+C stops the server)
echo  [OGF] The browser opens automatically once %URL% is reachable.
echo.
call npm run dev

echo.
echo  [OGF] Dev server exited.
pause
endlocal
