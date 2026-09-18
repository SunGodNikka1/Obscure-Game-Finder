@echo off
setlocal EnableExtensions
title Obscure Game Finder - production server

rem Always run from the folder this script lives in, however it was launched.
cd /d "%~dp0"

set "PORT=3000"
set "URL=http://localhost:%PORT%"

echo.
echo  ==============================================
echo   Obscure Game Finder  -  production launcher
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

rem --- 3. Build only when there is no build or the build is STALE -----------
rem A stamp file is written after every successful build. If any file under
rem src\ (or package.json / package-lock.json / next.config.ts / tsconfig.json /
rem postcss.config.mjs) is newer than that stamp, the sources changed since the
rem last build and we rebuild; otherwise the existing build is reused.
set "STAMP=.next\ogf-build.stamp"
set "NEED_BUILD=0"
set "BUILD_REASON="
if not exist ".next\BUILD_ID" (
  set "NEED_BUILD=1"
  set "BUILD_REASON=no production build found"
)
if "%NEED_BUILD%"=="0" if not exist "%STAMP%" (
  set "NEED_BUILD=1"
  set "BUILD_REASON=no build stamp found"
)
if "%NEED_BUILD%"=="0" (
  for /f "usebackq delims=" %%f in (`powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$stamp = (Get-Item '%STAMP%').LastWriteTimeUtc;" ^
    "$files = @(Get-ChildItem -Path 'src' -Recurse -File);" ^
    "foreach ($n in 'package.json','package-lock.json','next.config.ts','tsconfig.json','postcss.config.mjs') { if (Test-Path $n) { $files += Get-Item $n } };" ^
    "$stale = $files | Where-Object { $_.LastWriteTimeUtc -gt $stamp } | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1;" ^
    "if ($stale) { Write-Output $stale.FullName }"`) do (
    set "NEED_BUILD=1"
    set "BUILD_REASON=changed since last build: %%f"
  )
)
if "%NEED_BUILD%"=="1" (
  echo  [OGF] Rebuilding - %BUILD_REASON%
  echo.
  call npm run build
  if errorlevel 1 (
    echo.
    echo  [OGF] npm run build failed. See the output above.
    pause
    exit /b 1
  )
  type nul > "%STAMP%"
  echo.
) else (
  echo  [OGF] Production build is up to date - skipping npm run build.
)

rem --- 4. Do not start a second server on the same port ----------------------
netstat -ano -p tcp 2>nul | findstr /r /c:":%PORT% .*LISTENING" >nul
if not errorlevel 1 (
  echo  [OGF] Something is already listening on port %PORT% - is OGF already running?
  echo        Opening %URL% instead of starting a second server.
  start "" "%URL%"
  echo.
  pause
  exit /b 0
)

rem --- 5. Open the browser as soon as the server actually answers ------------
start "" /b powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$deadline = (Get-Date).AddSeconds(120);" ^
  "while ((Get-Date) -lt $deadline) {" ^
  "  $c = New-Object System.Net.Sockets.TcpClient;" ^
  "  try { $c.Connect('localhost', %PORT%); if ($c.Connected) { Start-Process '%URL%'; exit 0 } } catch {} finally { $c.Dispose() };" ^
  "  Start-Sleep -Milliseconds 500" ^
  "}"

rem --- 6. Run the production server in THIS window ---------------------------
echo  [OGF] Starting: npm start   (Ctrl+C stops the server)
echo  [OGF] The browser opens automatically once %URL% is reachable.
echo.
call npm start

echo.
echo  [OGF] Server exited.
pause
endlocal
