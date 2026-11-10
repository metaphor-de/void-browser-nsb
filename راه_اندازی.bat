@echo off
chcp 65001 >nul
echo Starting VOID Browser setup...
echo --------------------------------------
powershell -ExecutionPolicy Bypass -File "%~dp0setup-tools.ps1"
echo.
echo Finished. Press any key to close...
pause >nul
