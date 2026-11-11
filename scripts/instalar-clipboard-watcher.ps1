# instalar-clipboard-watcher.ps1 — registra el monitor del portapapeles para
# que arranque solo al iniciar sesion interactiva de Windows (no al boot del
# sistema: el portapapeles solo existe en la sesion del usuario).
#
# Crea una tarea programada "Ciudadan-Clipboard-Watcher" con trigger ONLOGON.
# Es reversible: para quitarla, Ejecutar como admin:
#   Unregister-ScheduledTask -TaskName 'Ciudadan-Clipboard-Watcher' -Confirm:$false

param(
  [string]$Runtime = '\\192.168.1.7\Kompa\_ciudadan-tts-coordinator\runtime'
)
$ErrorActionPreference = 'Stop'

$starter = Join-Path $Runtime 'scripts\start-clipboard-watcher.ps1'
if (-not (Test-Path -LiteralPath $starter)) { throw "No existe $starter" }

# El starter vive en UNC: copiarlo a local (persistente) para la tarea.
$localDir = Join-Path $env:LOCALAPPDATA 'CiudadanTTS'
New-Item -ItemType Directory -Force -Path $localDir | Out-Null
$hash = (Get-FileHash -LiteralPath $starter -Algorithm SHA256).Hash.Substring(0, 12)
$localStarter = Join-Path $localDir "start-clipboard-watcher-$hash.ps1"
Copy-Item -LiteralPath $starter -Destination $localStarter -Force

# Registrar en la tarea programada ONLOGON si hay permisos; si no (sesion sin
# elevar), usar la clave Run de HKCU, que no necesita admin y arranca igual al
# iniciar sesion interactiva del usuario.
$registered = $false
try {
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$localStarter`""
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
  Register-ScheduledTask -TaskName 'Ciudadan-Clipboard-Watcher' `
    -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null
  Write-Output "  Tarea programada 'Ciudadan-Clipboard-Watcher' registrada (ONLOGON)."
  $registered = $true
} catch {
  Write-Output "  (sin permiso para tarea programada: $($_.Exception.Message.Split("`n")[0]))"
}
if (-not $registered) {
  $rk = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
  Set-ItemProperty -Path $rk -Name 'CiudadanClipboardWatcher' -Value `
    "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$localStarter`"" -ErrorAction Stop
  Write-Output "  Registrado en HKCU\\...\\Run como 'CiudadanClipboardWatcher' (arranca al iniciar sesion)."
}
Write-Output "  Starter local: $localStarter"
Write-Output "  Para quitarlo: borra la entrada 'CiudadanClipboardWatcher' de HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run (o la tarea 'Ciudadan-Clipboard-Watcher')."

# lanzar ahora tambien
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $localStarter
