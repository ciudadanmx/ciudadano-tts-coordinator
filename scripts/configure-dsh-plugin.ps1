#Requires -Version 5.1
# configura-dsh-plugin.ps1 — Configura el plugin dsh-tts existente para usar
# el ciudadano-tts-coordinator en lugar de reproducir en el navegador.
#
# Uso:
#   powershell -File configure-dsh-plugin.ps1 -DSHHome "C:\Users\elyiz\.dsh-2" -Action enable
#   powershell -File configure-dsh-plugin.ps1 -DSHHome "C:\Users\elyiz\.dsh-2" -Action disable   # REVERTIR
#
# enable:  desactiva speakReplies en dsh-tts (no reproduce en navegador)
#          y documenta que el bridge enviará al coordinador.
# disable: restaura el comportamiento original (reproducción en navegador).

param(
    [Parameter(Mandatory=$true)]
    [string]$DSHHome,
    [Parameter(Mandatory=$true)]
    [ValidateSet('enable', 'disable', 'status')]
    [string]$Action
)

$ErrorActionPreference = 'Stop'
$TtsDataDir = Join-Path $DSHHome 'data\dsh-tts'
$BackupDir = Join-Path $DSHHome 'data\dsh-tts-backup-coordinator'
$SettingsFile = Join-Path $DSHHome 'settings.yaml.imported'

function Get-TtsConfig {
    # Leer la config de dsh-tts desde el archivo de settings o data
    $candidates = @(
        (Join-Path $TtsDataDir 'settings.yaml'),
        (Join-Path $TtsDataDir 'config.json'),
        (Join-Path $DSHHome 'profiles\web\dsh-tts\settings.yaml')
    )
    foreach ($f in $candidates) {
        if (Test-Path $f) { return @{ Path = $f; Content = Get-Content $f -Raw } }
    }
    return $null
}

switch ($Action) {
    'status' {
        Write-Host "=== Estado del plugin dsh-tts en $DSHHome ===" -ForegroundColor Cyan
        $cfg = Get-TtsConfig
        if ($cfg) {
            Write-Host "Archivo de config: $($cfg.Path)"
            if ($cfg.Content -match 'speakReplies:\s*(true|false)') {
                Write-Host "speakReplies = $($Matches[1])"
                if ($Matches[1] -eq 'false') {
                    Write-Host "→ El plugin NO reproducirá en el navegador (modo coordinador)" -ForegroundColor Green
                } else {
                    Write-Host "→ El plugin SÍ reproduce en el navegador (modo original)" -ForegroundColor Yellow
                }
            } else {
                Write-Host "speakReplies no encontrado explícitamente (default: false)"
            }
        } else {
            Write-Host "No se encontró archivo de config de dsh-tts" -ForegroundColor Red
        }
        if (Test-Path $BackupDir) {
            Write-Host "Backup existente: $BackupDir" -ForegroundColor Green
        }
        break
    }

    'enable' {
        Write-Host "=== Habilitando modo coordinador en $DSHHome ===" -ForegroundColor Cyan
        $cfg = Get-TtsConfig
        if (-not $cfg) {
            Write-Host "No se encontró config de dsh-tts — se creará entrada en settings" -ForegroundColor Yellow
        }

        # 1. Backup
        if (-not (Test-Path $BackupDir)) {
            New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
            if ($cfg) { Copy-Item $cfg.Path (Join-Path $BackupDir (Split-Path $cfg.Path -Leaf)) -Force }
            if (Test-Path $SettingsFile) { Copy-Item $SettingsFile (Join-Path $BackupDir 'settings.yaml.imported') -Force }
            Write-Host "Backup creado en $BackupDir" -ForegroundColor Green
        }

        # 2. Desactivar TODA reproducción en navegador vía settings:
        #    speakReplies (respuesta final), streamingEnabled (SSE /dsh-tts/stream),
        #    speakAsItGoes (hablar mientras llega). Sin esto el cliente sigue sonando.
        if (Test-Path $SettingsFile) {
            $content = Get-Content $SettingsFile -Raw
            $flags = @('speakReplies', 'streamingEnabled', 'speakAsItGoes')
            foreach ($flag in $flags) {
                if ($content -match "(?m)^(\s*)$flag\s*:\s*true\s*$") {
                    $content = $content -replace "(?m)^(\s*)$flag\s*:\s*true\s*$", "`${1}$flag`: false"
                    Write-Host "$flag cambiado a false" -ForegroundColor Green
                } elseif ($content -notmatch "(?m)^\s*$flag\s*:") {
                    # agregar al bloque dsh-tts si existe, o al final
                    if ($content -match '(?s)(dsh-tts:\s*\n)') {
                        $content = $content -replace '(?s)(dsh-tts:\s*\n)', "dsh-tts:`n  $flag`: false`n"
                    } else {
                        $content += "`ndsh-tts:`n  $flag`: false`n"
                    }
                    Write-Host "$flag`: false agregado" -ForegroundColor Green
                } else {
                    Write-Host "$flag ya está en false" -ForegroundColor Green
                }
            }
            Set-Content $SettingsFile $content -NoNewline
        }

        Write-Host ""
        Write-Host "✅ Plugin configurado para NO reproducir en navegador." -ForegroundColor Green
        Write-Host "   El bridge @ciudadan/dsh-tts-coordinator-bridge enviará las locuciones al coordinador." -ForegroundColor Cyan
        Write-Host "   Para revertir: powershell -File configure-dsh-plugin.ps1 -DSHHome '$DSHHome' -Action disable" -ForegroundColor Yellow
        break
    }

    'disable' {
        Write-Host "=== REVERTENDO a modo original en $DSHHome ===" -ForegroundColor Yellow
        if (Test-Path $BackupDir) {
            $backupSettings = Join-Path $BackupDir 'settings.yaml.imported'
            if (Test-Path $backupSettings -and (Test-Path $SettingsFile)) {
                Copy-Item $backupSettings $SettingsFile -Force
                Write-Host "settings.yaml.imported restaurado desde backup" -ForegroundColor Green
            }
            # Restaurar cualquier otro archivo respaldado
            Get-ChildItem $BackupDir -File | ForEach-Object {
                $dest = Join-Path (Split-Path $SettingsFile) $_.Name
                if ($_.Name -ne 'settings.yaml.imported') {
                    Copy-Item $_.FullName $dest -Force -ErrorAction SilentlyContinue
                }
            }
            Write-Host "✅ Configuración original restaurada desde $BackupDir" -ForegroundColor Green
        } else {
            Write-Host "No hay backup — cambiando speakReplies a true manualmente" -ForegroundColor Yellow
            if (Test-Path $SettingsFile) {
                $content = Get-Content $SettingsFile -Raw
                $content = $content -replace 'speakReplies:\s*false', 'speakReplies: true'
                Set-Content $SettingsFile $content -NoNewline
                Write-Host "speakReplies cambiado a true" -ForegroundColor Green
            }
        }
        Write-Host "   El plugin volverá a reproducir en el navegador como antes." -ForegroundColor Cyan
        break
    }
}
