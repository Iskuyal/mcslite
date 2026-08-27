@echo off
rem ============================================================
rem  MCSLite - one-click deploy & start (double-click me)
rem  ASCII only + CRLF: cmd parses .bat in the OEM codepage.
rem  All Chinese UI lives in the .ps1 files (UTF-8 with BOM).
rem ============================================================
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [MCSLite] node not found. Install Node.js LTS x64 first, tick "Add to PATH".
  pause
  exit /b 3
)

powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\deploy.ps1" %*
if errorlevel 1 (
  echo.
  echo [MCSLite] deploy did not finish. See messages above.
  pause
)
