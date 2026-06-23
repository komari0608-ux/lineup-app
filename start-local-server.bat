@echo off
setlocal
cd /d "%~dp0"

echo.
echo Lineup Planner local server
echo.
echo PC IPv4 address:
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | Select-Object -ExpandProperty IPAddress"
echo.
echo Open this on iPhone Safari:
echo   http://PC-IP-ADDRESS:8080
echo Example:
echo   http://192.168.1.10:8080
echo.
echo Press Ctrl+C to stop.
echo.

where py >nul 2>nul
if not errorlevel 1 (
  py -3 -m http.server 8080
  goto :eof
)

where python >nul 2>nul
if not errorlevel 1 (
  python -m http.server 8080
  goto :eof
)

echo Python was not found. Install Python 3 and run this file again.
pause
