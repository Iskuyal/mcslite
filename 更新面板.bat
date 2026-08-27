@echo off
rem ============================================================
rem  MCSLite - one-click upgrade (double-click me)
rem  Backs up data + current code, replaces code only, health-checks,
rem  auto-rolls back if the panel does not come up.
rem  Never touches data\ or the Minecraft instance directory.
rem ============================================================
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [MCSLite] node not found.
  pause
  exit /b 3
)

echo.
echo  MCSLite upgrade. Press Ctrl+C to abort.
echo  Useful switches:
echo    -Test            run the 42 unit tests after upgrade
echo    -FullTest        also run the 44 end-to-end checks
echo    -StopServer      gracefully stop Minecraft first (saves the world)
echo    -From ^<dir^>      upgrade from an unzipped GitHub download instead of git pull
echo    -Rollback        restore the newest snapshot under .rollback\
echo.
timeout /t 4 >nul

powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\update.ps1" -Test %*
if errorlevel 1 (
  echo.
  echo [MCSLite] upgrade failed. Your data is safe; rollback with:
  echo     powershell -NoProfile -ExecutionPolicy Bypass -File scripts\update.ps1 -Rollback
  pause
)
