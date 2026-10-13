@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-FarmGuard.ps1"
if errorlevel 1 pause
