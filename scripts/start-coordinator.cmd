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
REM
REM UBICACION (cambio 2026-11-09): el runtime vive en KOMPA, no en %TEMP%
REM (Windows limpia %TEMP% en los reinicios y ahi se iba el espacio del disco
REM local). Si Kompa no esta disponible, cae de vuelta a %TEMP%.
setlocal
set "COORD_DIR=%~dp0.."
set "KOMPA_ROOT=\\192.168.1.7\Kompa\_ciudadan-tts-coordinator"
set "RUNTIME=%KOMPA_ROOT%\runtime"
set "STATE=%KOMPA_ROOT%\state"
if not exist "%RUNTIME%\src\server\index.js" (
  set "RUNTIME=%TEMP%\ciudadan-tts-coordinator"
  set "STATE=%USERPROFILE%\.ciudadan-tts-coordinator"
)
set "LOG=%STATE%\server-stdout.log"
if not exist "%STATE%" mkdir "%STATE%" 2>nul

REM 1) ¿Ya hay un coordinador sano? -> salir sin tocar nada.
for /f "usebackq delims=" %%C in (`curl -s -o nul -m 4 -w "%%{http_code}" http://127.0.0.1:3199/api/v1/health 2^>nul`) do (
  if "%%C"=="200" (
    echo [ciudadan-tts] Ya hay un coordinador sano en 127.0.0.1:3199 - no se arranca otro.>> "%LOG%"
    echo [ciudadan-tts] Ya hay un coordinator sano en 127.0.0.1:3199 - no se arranca otro.
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

REM 3) Arrancar. Se pasa la ruta COMPLETA al node: cmd.exe no puede hacer
REM    cd a una ruta UNC, pero node si acepta UNC como argumento.
echo [%DATE% %TIME%] Arranque del coordinador solicitado (runtime=%RUNTIME%).>> "%LOG%"
node "%RUNTIME%\src\server\index.js" >> "%LOG%" 2>&1
