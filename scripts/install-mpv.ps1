#Requires -Version 5.1
# Instala mpv en Windows usando winget o descarga directa.
# Ejecutar como: powershell -ExecutionPolicy Bypass -File install-mpv.ps1

$ErrorActionPreference = 'Stop'

Write-Host "=== Instalador de mpv para ciudadano-tts-coordinator ===" -ForegroundColor Cyan

# 1. Intentar winget
try {
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
        Write-Host "winget detectado. Instalando mpv..." -ForegroundColor Yellow
        winget install --id=Gyan.mpv -e --accept-source-agreements --accept-package-agreements
        if ($LASTEXITCODE -eq 0) {
            Write-Host "mpv instalado via winget." -ForegroundColor Green
            # Asegurar que esté en PATH
            $mpvPath = "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Gyan.mpv_Microsoft.Winget.Source_8wekyb3d8bbwe\mpv.exe"
            if (Test-Path $mpvPath) {
                Write-Host "Ubicación: $mpvPath"
            }
            exit 0
        }
    }
} catch {
    Write-Host "winget no disponible o falló: $_" -ForegroundColor Yellow
}

# 2. Descarga directa desde GitHub releases
Write-Host "Descargando mpv directamente..." -ForegroundColor Yellow
$downloadUrl = "https://github.com/mpv-player/mpv/releases/latest/download/mpv-x86_64-v3-ucrt64.zip"
$tempZip = "$env:TEMP\mpv-download.zip"
$installDir = "$env:ProgramFiles\mpv"

try {
    Invoke-WebRequest -Uri $downloadUrl -OutFile $tempZip -UseBasicParsing
    Write-Host "Descarga completada. Extrayendo a $installDir..." -ForegroundColor Yellow
    if (-not (Test-Path $installDir)) { New-Item -ItemType Directory -Path $installDir -Force | Out-Null }
    Expand-Archive -Path $tempZip -DestinationPath $installDir -Force
    # Agregar al PATH del usuario
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($userPath -notlike "*$installDir*") {
        [Environment]::SetEnvironmentVariable('Path', "$userPath;$installDir", 'User')
        Write-Host "mpv agregado al PATH del usuario. Reinicia la terminal para usarlo." -ForegroundColor Green
    }
    Write-Host "✓ mpv instalado en $installDir" -ForegroundColor Green
} catch {
    Write-Host "ERROR: No se pudo instalar mpv automáticamente." -ForegroundColor Red
    Write-Host "Descarga manual desde: https://mpv.io/installation/" -ForegroundColor Yellow
    Write-Host "Detalle: $_" -ForegroundColor Red
    exit 1
} finally {
    if (Test-Path $tempZip) { Remove-Item $tempZip -Force -ErrorAction SilentlyContinue }
}

# Verificar
Start-Sleep -Seconds 1
$mpvCheck = Get-Command mpv -ErrorAction SilentlyContinue
if ($mpvCheck) {
    Write-Host "✓ mpv verificado: $($mpvCheck.Source)" -ForegroundColor Green
} else {
    Write-Host "⚠ mpv instalado pero no en PATH de esta sesión. Reinicia PowerShell." -ForegroundColor Yellow
}
