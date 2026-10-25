@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install || goto :error
)
if not exist node_modules\electron\dist\electron.exe (
  call npx install-electron || goto :error
)
if /i "%~1"=="dev" (call npm run dev) else (call npm start)
exit /b 0
:error
echo Setup failed. Make sure Node.js 22.12+ is installed: https://nodejs.org
pause
