@echo off
cd /d "%~dp0"
node fastml-node-runner.js > fastml-run.log 2>&1
if errorlevel 1 (
  echo FastML failed. See fastml-run.log
  exit /b 1
)
echo FastML finished. See results\ and fastml-run.log
