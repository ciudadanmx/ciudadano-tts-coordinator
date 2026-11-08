#Requires -Version 5.1
# install-autostart.ps1 — Autostart del coordinador TTS al iniciar sesión.
# Estrategia: acceso directo en carpeta Startup (no requiere elevación admin,
# a diferencia de Register-ScheduledTask que puede dar "Acceso denegado").
# Fallback: tarea programada via schtasks si se ejecuta elevado.

param(
    [string]$CoordinatorPath = "$PSScriptRoot\..",
    [switch]$Uninstall,
    [switch]$UseScheduledTask  # fuerza schtasks (requiere admin)
)

$TaskName = 'Ciudadan-TTS-Coordinator-3199'
$StartCmd = Join-Path (Resolve-Path $CoordinatorPath).Path 'scripts\start-coordinator.cmd'
$StartupDir = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup"
$ShortcutPath = Join-Path $StartupDir 'ciudadan-tts-coordinator-3199.lnk'
$VbsPath = Join-Path $env:LOCALAPPDATA 'Ciudadan\tts-coordinator-oculto.vbs'

if ($Uninstall) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Remove-Item $ShortcutPath -ErrorAction SilentlyContinue
    Remove-Item $VbsPath -ErrorAction SilentlyContinue
    Write-Host "✅ Autostart eliminado (startup + tarea programada)" -ForegroundColor Green
    exit 0
}

# Sincronizar script de inicio al TEMP (el .cmd usa %TEMP%\ciudadan-tts-coordinator)
$TempScripts = Join-Path $env:TEMP 'ciudadan-tts-coordinator\scripts'
New-Item -ItemType Directory -Path $TempScripts -Force | Out-Null
Copy-Item -Path $StartCmd -Destination $TempScripts -Force

# VBS para lanzar oculto (mismo patrón que DSH1/DSH2) — una línea por comando
New-Item -ItemType Directory -Path (Split-Path $VbsPath) -Force | Out-Null
$TempCmd = Join-Path $env:TEMP 'ciudadan-tts-coordinator\scripts\start-coordinator.cmd'
$nl = [char]10
$vbs = 'Set ws = CreateObject("Wscript.Shell")' + $nl + 'ws.Run "cmd /c " & Chr(34) & "' + $TempCmd + '" & Chr(34), 0, False'
[System.IO.File]::WriteAllText($VbsPath, $vbs)

if ($UseScheduledTask) {
    # Requiere sesión elevada
    $xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>
  <Principals><Principal><UserId>$env:USERNAME</UserId><LogonType>Interactive</LogonType></Principal></Principals>
  <Settings><AllowStartIfOnBatteries>true</AllowStartIfOnBatteries><DontStopIfGoingOnBatteries>true</DontStopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><MultipleInstances>IgnoreNew</MultipleInstances></Settings>
  <Actions><Exec><Command>wscript.exe</Command><Arguments>//B //Nologo "$VbsPath"</Arguments></Exec></Actions>
</Task>
"@
    $xmlFile = Join-Path $env:TEMP 'tts-coordinator-task.xml'
    Set-Content -Path $xmlFile -Value $xml -Encoding Unicode
    schtasks /Create /TN $TaskName /XML $xmlFile /F 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Host "✅ Tarea programada $TaskName creada (schtasks)" -ForegroundColor Green }
    else { Write-Host "⚠️ schtasks falló (exit $LASTEXITCODE) — usando Startup folder" -ForegroundColor Yellow }
}

# Principal: acceso directo en carpeta Startup
$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = 'wscript.exe'
$Shortcut.Arguments = "//B //Nologo `"$VbsPath`""
$Shortcut.WorkingDirectory = $env:TEMP
$Shortcut.WindowStyle = 7  # Minimizado
$Shortcut.IconLocation = 'shell32.dll,137'
$Shortcut.Save()

Write-Host "✅ Autostart instalado en carpeta Startup:" -ForegroundColor Green
Write-Host "   $ShortcutPath"
Write-Host "   → ejecuta: wscript.exe //B //Nologo $VbsPath"
Write-Host "   → que lanza: $TempCmd"
Write-Host ""
Write-Host "Al reiniciar el equipo e iniciar sesión, el coordinador arrancará solo en 127.0.0.1:3199"
Write-Host "Verificar: Get-ChildItem `"$StartupDir`" | Where-Object Name -match 'tts'"
Write-Host "Desinstalar: powershell -File install-autostart.ps1 -Uninstall"
