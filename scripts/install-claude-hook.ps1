#Requires -Version 5.1
# install-claude-hook.ps1 — Instala el hook de Claude Code para el coordinador TTS.
# Crea/actualiza ~/.claude/settings.json con el hook Stop → coordinador.

param(
    [string]$CoordinatorPath = "$PSScriptRoot\..",
    [switch]$Uninstall
)

$ClaudeDir = Join-Path $env:USERPROFILE '.claude'
$SettingsFile = Join-Path $ClaudeDir 'settings.json'
$HookScript = Join-Path (Resolve-Path $CoordinatorPath).Path 'src\integrations\claude-code.js'

New-Item -ItemType Directory -Path $ClaudeDir -Force | Out-Null

if ($Uninstall) {
    if (Test-Path $SettingsFile) {
        $settings = Get-Content $SettingsFile -Raw | ConvertFrom-Json
        if ($settings.hooks -and $settings.hooks.Stop) {
            $settings.hooks.Stop = @($settings.hooks.Stop | Where-Object {
                $_.hooks | Where-Object { $_.command -notlike "*ciudadan-tts-coordinator*" }
            })
            if ($settings.hooks.Stop.Count -eq 0) { $settings.hooks.PSObject.Properties.Remove('Stop') }
        }
        $settings | ConvertTo-Json -Depth 10 | Set-Content $SettingsFile
        Write-Host "Hook desinstalado de $SettingsFile" -ForegroundColor Green
    }
    exit 0
}

# Leer settings existente o crear nuevo
$settings = @{}
if (Test-Path $SettingsFile) {
    try { $settings = Get-Content $SettingsFile -Raw | ConvertFrom-Json -AsHashtable } catch { $settings = @{} }
}

if (-not $settings.ContainsKey('hooks')) { $settings['hooks'] = @{} }
if (-not $settings['hooks'].ContainsKey('Stop')) { $settings['hooks']['Stop'] = @() }

# Eliminar hook previo nuestro para evitar duplicados
$settings['hooks']['Stop'] = @($settings['hooks']['Stop'] | Where-Object {
    -not ($_.hooks | Where-Object { $_.command -like "*ciudadan-tts-coordinator*" })
})

# Agregar nuestro hook
$hookEntry = @{
    matcher = ''
    hooks = @(@{
        type = 'command'
        command = "node $HookScript"
    })
}
$settings['hooks']['Stop'] += $hookEntry

$json = $settings | ConvertTo-Json -Depth 10
Set-Content $SettingsFile $json
Write-Host "✅ Hook instalado en $SettingsFile" -ForegroundColor Green
Write-Host "   Comando: node $HookScript"
Write-Host "   Evento: Stop (cada vez que Claude Code termina una respuesta)"
Write-Host ""
Write-Host "Para desinstalar: powershell -File install-claude-hook.ps1 -Uninstall" -ForegroundColor Yellow
