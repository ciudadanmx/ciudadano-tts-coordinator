# start-clipboard-watcher.ps1 — lanza (o relanza) el monitor del portapapeles.
#
# El script del watcher vive en Kompa (ruta UNC). powershell.exe -File NO
# acepta rutas UNC, asi que SIEMPRE se copia a %TEMP% con un hash en el nombre
# (mismo patron que el daemon SAPI). Si ya hay un watcher corriendo, no se
# lanza otro.

param(
  [string]$Runtime = '\\192.168.1.7\Kompa\_ciudadan-tts-coordinator\runtime',
  [string]$State   = '\\192.168.1.7\Kompa\_ciudadan-tts-coordinator\state'
)
$ErrorActionPreference = 'Stop'

$src = Join-Path $Runtime 'scripts\clipboard-watcher.ps1'
if (-not (Test-Path -LiteralPath $src)) {
  Write-Output "  ERROR: no existe $src"
  exit 1
}

$localDir = Join-Path $env:TEMP 'ciudadan-tts-clipboard'
New-Item -ItemType Directory -Force -Path $localDir | Out-Null
$hash = (Get-FileHash -LiteralPath $src -Algorithm SHA256).Hash.Substring(0, 12)
$local = Join-Path $localDir "clipboard-watcher-$hash.ps1"
Copy-Item -LiteralPath $src -Destination $local -Force

$logDir = Join-Path $State 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$out = Join-Path $logDir 'clipboard-watcher.out.log'
$err = Join-Path $logDir 'clipboard-watcher.err.log'

$existing = Get-CimInstance Win32_Process | Where-Object {
  # Ojo: el patron debe excluir a ESTE starter (start-clipboard-watcher.ps1);
  # solo cuenta el watcher copiado a %TEMP% (clipboard-watcher-<hash>.ps1).
  $_.Name -eq 'powershell.exe' -and $_.CommandLine -match 'ciudadan-tts-clipboard\\clipboard-watcher-[0-9A-Fa-f]{12}\.ps1'
}
if ($existing) {
  Write-Output ("  ya hay {0} watcher(s) corriendo (PID {1}); no se lanza otro" -f $existing.Count, (($existing.ProcessId) -join ', '))
  exit 0
}

$p = Start-Process -FilePath 'powershell.exe' `
  -ArgumentList '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $local `
  -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden -PassThru
Write-Output ("  watcher lanzado PID {0}" -f $p.Id)
Write-Output ("  script: {0}" -f $local)
Write-Output ("  log:    {0}" -f $out)
