@echo off
REM start-coordinator.cmd — Inicia el coordinador desacoplado, leyendo el token
REM desde ~/.ciudadan-tts-coordinator/token (no depende de env vars externas).
REM
REM IDEMPOTENTE Y SEGURO (cambio 2026-11-09):
REM   1) Si ya hay un coordinador sano en 127.0.0.1:3199 -> NO hace nada.
REM   2) Si el puerto 3199 esta ocupado por otro proceso -> NO mata nada.
REM   3) Solo arranca cuando el puerto esta libre.
REM Asi, otros clientes (Claude Code, DSH, scripts de arranque) pueden invocar
REM este script sin riesgo de tumbar el servicio que ya esta funcionando.
setlocal
set "COORD_DIR=%~dp0.."
set "LOG=%USERPROFILE%\.ciudadan-tts-coordinator\server-stdout.log"
if not exist "%USERPROFILE%\.ciudadan-tts-coordinator" mkdir "%USERPROFILE%\.ciudadan-tts-coordinator"

REM 1) ¿Ya hay un coordinador sano? -> salir sin tocar nada.
for /f "usebackq delims=" %%C in (`curl -s -o nul -m 4 -w "%%{http_code}" http://127.0.0.1:3199/api/v1/health 2^>nul`) do (
  if "%%C"=="200" (
    echo [ciudadan-tts] Ya hay un coordinador sano en 127.0.0.1:3199 - no se arranca otro.>> "%LOG%"
    echo [ciudadan-tts] Ya hay un coordinador sano en 127.0.0.1:3199 - no se arranca otro.
    exit /b 0
  )
)

REM 2) Puerto ocupado por otro proceso -> no se mata nada (regla de seguridad).
netstat -ano | findstr "127.0.0.1:3199" | findstr "LISTENING" >nul
if not errorlevel 1 (
  echo [ciudadan-tts] AVISO: el puerto 3199 esta ocupado por otro proceso - no se modifica nada.>> "%LOG%"
  echo [ciudadan-tts] AVISO: el puerto 3199 esta ocupado por otro proceso - no se modifica nada.
  exit /b 0
)

cd /d "%TEMP%\ciudadan-tts-coordinator"
if errorlevel 1 cd /d "%COORD_DIR%"
echo [%DATE% %TIME%] Arranque del coordinador solicitado.>> "%LOG%"
node src\server\index.js >> "%LOG%" 2>&1
