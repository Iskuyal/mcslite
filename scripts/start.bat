@echo off
rem ============================================================
rem  MCSLite launcher - double-click to run
rem  Keep this file ASCII-only and CRLF: cmd.exe reads .bat in
rem  the OEM codepage (936 on Chinese Windows), so non-ASCII text
rem  here turns into mojibake or, worse, breaks parsing.
rem  Chinese messages live in scripts\start.ps1 (UTF-8 + BOM).
rem ============================================================
setlocal
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo [MCSLite] node not found - install Node.js LTS x64 and check "Add to PATH"
  pause
  exit /b 3
)

if "%MCSLITE_HEAP%"=="" set "MCSLITE_HEAP=96"

echo [MCSLite] starting panel... (first run prints the initial password once)
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\start.ps1" -HeapMB %MCSLITE_HEAP%

echo.
echo [MCSLite] panel exited.
if "%1"=="" pause
