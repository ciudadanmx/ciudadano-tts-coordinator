# coordinator-watchdog.ps1
# Vigilante del coordinador de voz (ciudadan-tts-coordinator).
#
# Por qué existe: el 09/11/2026 el coordinator se cayó y NO había nada que lo
# levantara. Durante ~8 horas todos los agentes (DSH1, DSH2, Dany, Claude)
# quedaron mudos y el ingress de Dany dejó de recibir locuciones.
#
# Qué hace:
#   1. Comprueba GET /api/v1/health (sin token) cada 60 s.
#   2. Si no responde, mata SOLO las instancias del coordinator (node
#      .../server/index.js que ocupan 127.0.0.1:3199) y arranca exactamente una.
#
# Qué NO hace (reglas permanentes):
#   - No toca DSH1 (3080), DSH2 (3081), Dany (3091), 8765 ni 8770.
#   - No reinicia dsh-dany.service ni el Media Player.
#   - No modifica el volumen de mpv ni el del sistema.
#   - No toca el ingress de Dany (3200): lo mantiene su propio supervisor.

$ErrorActionPreference = 'SilentlyContinue'

$AppDir    = 'C:\Users\elyiz\AppData\Local\Ciudadan'
$LogDir    = Join-Path $AppDir 'log'
$LogFile   = Join-Path $LogDir 'ciudadan-tts-coordinator-watchdog.log'
$LockFile  = Join-Path $AppDir 'ciudadan-tts-coordinator-watchdog.lock'
# El runtime vive en KOMPA (no en %TEMP%, que Windows limpia y que llenaba el
# disco local). Si Kompa no esta disponible, se usa el runtime local.
$KOMPA     = '\\192.168.1.7\Kompa\_ciudadan-tts-coordinator'
$Runtime   = Join-Path $KOMPA 'runtime'
if (-not (Test-Path (Join-Path $Runtime 'src\server\index.js'))) {
  $Runtime = Join-Path $env:TEMP 'ciudadan-tts-coordinator'
}
$StartCmd  = Join-Path $Runtime 'scripts\start-coordinator.cmd'
$HealthUrl = 'http://127.0.0.1:3199/api/v1/health'
$Port      = 3199

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

function Write-Log([string]$Message) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  try { Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8 -ErrorAction Stop } catch { }
}

function Test-Healthy {
  try {
    $r = Invoke-WebRequest -Uri $HealthUrl -TimeoutSec 10 -UseBasicParsing
    return ($r.StatusCode -eq 200)
  } catch {
    return $false
  }
}

# PIDs de node que ejecutan el servidor del coordinator (nada más).
function Get-CoordinatorPids {
  $found = @()
  try {
    $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $conns) {
      $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)" -ErrorAction SilentlyContinue
      if ($proc -and $proc.Name -match '^node(\.exe)?$' -and $proc.CommandLine -match 'server[\\/]index\.js') {
        $found += $c.OwningProcess
      }
    }
  } catch { }
  try {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -match 'server[\\/]index\.js' } |
      ForEach-Object { $found += $_.ProcessId }
  } catch { }
  return ($found | Select-Object -Unique)
}

function Start-Coordinator {
  if (-not (Test-Path $StartCmd)) {
    Write-Log "ERROR: no existe el script de arranque $StartCmd"
    return
  }
  Write-Log 'el coordinator no responde: arrancando una instancia'
  Start-Sleep -Seconds 3
  try {
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', ('"' + $StartCmd + '"') -WindowStyle Hidden
    Write-Log '  arranque solicitado (start-coordinator.cmd)'
  } catch {
    Write-Log "  ERROR al arrancar: $($_.Exception.Message)"
  }
}

# Espera activa a que responda el health. Desde Kompa el arranque puede tardar
# 30-60 s (lee el codigo por la red), asi que se espera con margen.
function Wait-Healthy([int]$MaxSeconds, [int]$StepSeconds = 10) {
  for ($i = 0; $i -lt [math]::Floor($MaxSeconds / $StepSeconds); $i++) {
    Start-Sleep -Seconds $StepSeconds
    if (Test-Healthy) { return $true }
  }
  return (Test-Healthy)
}

# --- Lock: una sola instancia del watchdog ---
$lock = $null
try {
  $lock = [System.IO.File]::Open($LockFile, 'OpenOrCreate', 'ReadWrite', 'None')
} catch {
  Write-Log 'otra instancia del watchdog ya está activa; saliendo'
  exit 0
}

try {
  Write-Log '=== watchdog del coordinator de voz iniciado ==='
  while ($true) {
    if (Test-Healthy) {
      # sano: no hacer nada
    } else {
      # dar margen: puede estar arrancando
      Start-Sleep -Seconds 8
      if (-not (Test-Healthy)) {
        # REGLA (10/11/2026): si hay una instancia VIVA, NO se mata. Con el
        # runtime en Kompa el arranque dura 30-60 s y antes el watchdog mataba
        # al proceso sano a los 25 s: bucle de reinicio endless (el daemon de
        # pycaw caia y se rearrancaba cada 2 min, dejando el ducking sin efecto).
        $vivos = @(Get-CoordinatorPids)
        if ($vivos.Count -gt 0) {
          Write-Log "  hay una instancia viva (pid=$($vivos -join ',')): se espera a que termine de arrancar, sin matarla"
          if (Wait-Healthy 180) {
            Write-Log '  coordinator sano (arranque lento, sin intervencion)'
          } else {
            Write-Log '  WARNING: la instancia viva no responde tras 3 min'
          }
        } else {
          Start-Coordinator
          if (Wait-Healthy 150) {
            Write-Log '  coordinator recuperado y sano'
          } else {
            Write-Log '  WARNING: el coordinator sigue sin responder tras el arranque'
          }
        }
      }
    }
    Start-Sleep -Seconds 60
  }
} finally {
  Write-Log 'watchdog detenido'
  if ($lock) { try { $lock.Close() } catch { } }
}
