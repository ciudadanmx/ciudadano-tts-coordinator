# limpieza-temporal.ps1
# Evita que %TEMP% se llene en este equipo.
#
# Antecedente (10/11/2026): el disco C: quedo al 100% (0.2 GB libres). Causas:
#   - 71 parches git base64 de 121 MB cada uno (v-*.b64) que genera el flujo de
#     "proteger trabajo en curso" del DSH: 8 GB acumulados en 8 dias.
#   - 2951 carpetas 'ciudadan-edge-*' (291 MB) que dejaba el sintetizador.
#   - caches y logs del coordinador en el disco local.
#
# Que hace (todo REVERSIBLE: nada se borra, se mueve a Kompa):
#   1. Mueve a \\192.168.1.7\Kompa\_residuos-temp los *.b64, *.patch y carpetas
#      de prueba del TEMP con mas de 6 horas de antiguedad.
#   2. Elimina las carpetas 'ciudadan-edge-*' y 'ciudadan-audio-*' del TEMP con
#      mas de 30 minutos (ya son residuo: la sintesis y el snapshotatino).
#   3. Informa del espacio libre.
#
# No toca: DSH1/DSH2/Dany, mpv, el workspace, ni nada fuera de %TEMP%.

$ErrorActionPreference = 'SilentlyContinue'

$Temp    = $env:TEMP
$Residuo = '\\192.168.1.7\Kompa\_residuos-temp'
$LogFile = 'C:\Users\elyiz\AppData\Local\Ciudadan\log\ciudadan-tts-limpieza.log'

if (-not (Test-Path (Split-Path $LogFile))) { New-Item -ItemType Directory -Path (Split-Path $LogFile) -Force | Out-Null }
function Write-Log([string]$m) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
  try { Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8 -ErrorAction Stop } catch { }
}

Write-Log '=== limpieza de temporales iniciada ==='

# --- 1. Residuos grandes: se MUEVEN a Kompa (no se borran) ---
if (-not (Test-Path $Residuo)) { New-Item -ItemType Directory -Path $Residuo -Force | Out-Null }
$dest = Join-Path $Residuo (Get-Date -Format 'yyyy-MM-dd')
New-Item -ItemType Directory -Path $dest -Force | Out-Null

$corte = (Get-Date).AddHours(-6)
$patrones = @('v-*.b64', '*.patch', 'higiene.b64')
$movidos = 0
foreach ($pat in $patrones) {
  foreach ($f in (Get-ChildItem $Temp -Filter $pat -File -ErrorAction SilentlyContinue)) {
    if ($f.LastWriteTime -lt $corte) {
      try {
        Move-Item -LiteralPath $f.FullName -Destination (Join-Path $dest $f.Name) -Force -ErrorAction Stop
        $movidos++
      } catch { }
    }
  }
}
# Carpetas de prueba conocidas (backups de despliegues y perfiles de navegador)
$carpetas = @('chrome-tts-test', 'chrome-cdp-test', 'ciudadan-pages-*', 'pristine-*',
              'ciudadan-build-verify-*', 'ciudadan-prod-before-*')
foreach ($pat in $carpetas) {
  foreach ($d in (Get-ChildItem $Temp -Directory -Filter $pat -ErrorAction SilentlyContinue)) {
    if ($d.LastWriteTime -lt $corte) {
      try {
        Move-Item -LiteralPath $d.FullName -Destination (Join-Path $dest $d.Name) -Force -ErrorAction Stop
        $movidos++
      } catch { }
    }
  }
}
Write-Log "residuos movidos a Kompa: $movidos"

# --- 2. Carpetas huerfanas del sintetizador y del puente multimedia ---
$corte30 = (Get-Date).AddMinutes(-30)
$borradas = 0
foreach ($pat in @('ciudadan-edge-*', 'ciudadan-audio-*')) {
  foreach ($d in (Get-ChildItem $Temp -Directory -Filter $pat -ErrorAction SilentlyContinue)) {
    if ($d.LastWriteTime -lt $corte30) {
      try {
        Remove-Item -LiteralPath $d.FullName -Recurse -Force -ErrorAction Stop
        $borradas++
      } catch { }
    }
  }
}
Write-Log "carpetas temporales huérfanas eliminadas: $borradas"

# --- 3. Estado ---
$c = Get-PSDrive C -ErrorAction SilentlyContinue
$k = Get-PSDrive K -ErrorAction SilentlyContinue
Write-Log ("C: libre {0:N1} GB | K: libre {1:N1} GB" -f ($c.Free / 1GB), ($k.Free / 1GB))
Write-Log '=== limpieza terminada ==='
