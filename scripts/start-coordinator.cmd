@echo off
REM start-coordinator.cmd — Inicia el coordinador desacoplado, leyendo el token
REM desde ~/.ciudadan-tts-coordinator/token (no depende de env vars externas).
setlocal
set "COORD_DIR=%~dp0.."
set "LOG=%USERPROFILE%\.ciudadan-tts-coordinator\server-stdout.log"
if not exist "%USERPROFILE%\.ciudadan-tts-coordinator" mkdir "%USERPROFILE%\.ciudadan-tts-coordinator"
cd /d "%TEMP%\ciudadan-tts-coordinator"
if errorlevel 1 cd /d "%COORD_DIR%"
node src\server\index.js >> "%LOG%" 2>&1
