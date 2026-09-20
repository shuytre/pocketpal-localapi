@echo off
rem ===========================================================================
rem  PocketPal - Windows one-click build entry point (double-click to run)
rem  The real logic lives in one-click-windows-build.ps1. This wrapper only
rem  invokes it with -ExecutionPolicy Bypass, so a locked-down execution
rem  policy cannot silently block the build.
rem
rem  Pass-through arguments, e.g.:
rem    one-click-windows-build.cmd -SkipDeps -Install
rem ===========================================================================
setlocal
set "PS1=%~dp0one-click-windows-build.ps1"
if not exist "%PS1%" (
  echo [X] one-click-windows-build.ps1 not found next to this file.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" (
  echo.
  echo [X] Script exited with code %CODE%. Please send the output above.
)
echo.
pause
exit /b %CODE%
