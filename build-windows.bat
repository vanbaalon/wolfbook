@echo off
REM build-windows.ps1 / build-windows.bat
REM Run this once on your Windows machine to build wstp-win32-x64.node
REM and copy it into the extension's prebuilt directory.
REM
REM Prerequisites:
REM   1. Wolfram Engine installed (default: C:\Program Files\Wolfram Research\Wolfram Engine\...)
REM   2. Node.js >= 18  (https://nodejs.org)
REM   3. Visual Studio Build Tools 2019+ with "Desktop development with C++" workload
REM      OR:  npm install -g windows-build-tools  (older approach)
REM
REM Usage:
REM   .\build-windows.bat
REM   (or: powershell -ExecutionPolicy Bypass -File build-windows.bat)

setlocal

REM ── Paths ─────────────────────────────────────────────────────────────────
set WSTP_BACKEND_DIR=%~dp0..\WSTP Backend
set EXT_PREBUILT_DIR=%~dp0wstp\prebuilt

REM ── Build ─────────────────────────────────────────────────────────────────
echo.
echo === Building wstp.node for Windows x64 ===
echo.

pushd "%WSTP_BACKEND_DIR%"

call npm ci
if errorlevel 1 ( echo [ERROR] npm ci failed & exit /b 1 )

call npm run build
if errorlevel 1 ( echo [ERROR] build failed & exit /b 1 )

popd

REM ── Copy prebuilt binary ───────────────────────────────────────────────────
if not exist "%EXT_PREBUILT_DIR%" mkdir "%EXT_PREBUILT_DIR%"

copy /Y "%WSTP_BACKEND_DIR%\build\Release\wstp.node" "%EXT_PREBUILT_DIR%\wstp-win32-x64.node"
if errorlevel 1 ( echo [ERROR] copy failed & exit /b 1 )

echo.
echo === Done! wstp-win32-x64.node saved to:
echo     %EXT_PREBUILT_DIR%\wstp-win32-x64.node
echo.
echo Next step: commit this file and run deploy-extension.sh package on your Mac.

endlocal
