@echo off
rem MiaBot launcher for the new server (2026-11-01). Lives next to mia-entry.cjs.
rem The MiaBot scheduled task runs "mia-task.cmd task"; both start .vbs files run it too.
rem   1. Never starts a second Mia: two copies on the QQ gateway answer every message twice.
rem   2. Deletes headless-browser profiles (ongeki-exe-*) that earlier renders left in %TEMP%.
rem      When Mia runs as a scheduled task, nothing else ever cleans that folder.
rem   3. mia.log only grows: once it passes 50 MB it becomes mia.old.log (one old copy kept).
cd /d "%~dp0"
powershell.exe -NoProfile -Command "if (Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*mia-entry*' }) { exit 7 }"
if "%errorlevel%"=="7" (
  echo Mia is already running. Not starting a second copy.
  exit /b 0
)
for /d %%d in ("%TEMP%\ongeki-exe-*") do rd /s /q "%%d" 2>nul
if exist mia.log for %%f in (mia.log) do if %%~zf gtr 52428800 move /y mia.log mia.old.log >nul
if /i "%~1"=="task" (
  node mia-entry.cjs 2>> mia-stderr.log
) else (
  node mia-entry.cjs
)
