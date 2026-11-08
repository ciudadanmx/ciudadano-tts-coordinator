#Requires -Version 5.1
# verify-install.ps1 — Verifica que la instalación del ciudadano-tts-coordinator
# esté completa en DSH1, DSH2 y Claude Code.

param(
    [string]$CoordinatorUrl = 'http://127.0.0.1:3199',
    [string]$Token = $env:CIUDADAN_TTS_TOKEN
)

$pass = 0; $fail = 0
function Check($name, $condition) {
    if ($condition) { Write-Host "  ✅ $name" -ForegroundColor Green; $script:pass++ }
    else { Write-Host "  ❌ $name" -ForegroundColor Red; $script:fail++ }
}

Write-Host "=== VERIFICACIÓN DE INSTALACIÓN ===" -ForegroundColor Cyan

# 1. Coordinador corriendo
Write-Host "`n[1] Coordinador TTS:" -ForegroundColor Yellow
try {
    $h = Invoke-RestMethod -Uri "$CoordinatorUrl/api/v1/health" -TimeoutSec 5
    Check "Health endpoint responde" $h.ok
    Check "Estado healthy" ($h.status -eq 'healthy')
    Check "Player ready" ($h.player -eq 'ready')
} catch {
    Check "Health endpoint responde (coordinador no corriendo)" $false
}

# 2. Bridge instalado en DSH2
Write-Host "`n[2] DSH2 ($env:USERPROFILE\.dsh-2):" -ForegroundColor Yellow
$dsh2Bridge = "C:\Users\$env:USERNAME\.dsh-2\profiles\web\node_modules\@ciudadan\dsh-tts-coordinator-bridge\lib\index.js"
Check "Bridge instalado en node_modules" (Test-Path $dsh2Bridge)
$patch2 = Get-Content "C:\Users\$env:USERNAME\.dsh-2\profiles\web\cordis.patch.yml" -Raw -ErrorAction SilentlyContinue
Check "Registrado en cordis.patch.yml" ($patch2 -match 'dsh-tts-coordinator-bridge')

# 3. Bridge instalado en DSH1
Write-Host "`n[3] DSH1 ($env:USERPROFILE\.dsh):" -ForegroundColor Yellow
$dsh1Bridge = "C:\Users\$env:USERNAME\.dsh\profiles\web\node_modules\@ciudadan\dsh-tts-coordinator-bridge\lib\index.js"
Check "Bridge instalado en node_modules" (Test-Path $dsh1Bridge)
$patch1 = Get-Content "C:\Users\$env:USERNAME\.dsh\profiles\web\cordis.patch.yml" -Raw -ErrorAction SilentlyContinue
Check "Registrado en cordis.patch.yml" ($patch1 -match 'dsh-tts-coordinator-bridge')

# 4. Plugin dsh-tts original intacto
Write-Host "`n[4] Plugin dsh-tts original:" -ForegroundColor Yellow
$tts2 = "C:\Users\$env:USERNAME\.dsh-2\profiles\web\node_modules\@goodandready\dsh-tts\package.json"
$tts1 = "C:\Users\$env:USERNAME\.dsh\profiles\web\node_modules\@goodandready\dsh-tts\package.json"
Check "DSH2 dsh-tts v0.4.33 intacto" ((Test-Path $tts2) -and ((Get-Content $tts2 | ConvertFrom-Json).version -eq '0.4.33'))
Check "DSH1 dsh-tts v0.4.33 intacto" ((Test-Path $tts1) -and ((Get-Content $tts1 | ConvertFrom-Json).version -eq '0.4.33'))

# 5. mpv instalado
Write-Host "`n[5] Reproductor mpv:" -ForegroundColor Yellow
Check "mpv.exe existe" (Test-Path 'C:\Program Files\MPV Player\mpv.exe')

# 6. edge-tts instalado
Write-Host "`n[6] Síntesis edge-tts:" -ForegroundColor Yellow
Check "edge-tts disponible" ($null -ne (Get-Command edge-tts -ErrorAction SilentlyContinue))

# 7. Token configurado
Write-Host "`n[7] Autenticación:" -ForegroundColor Yellow
Check "CIUDADAN_TTS_TOKEN definido" ($null -ne $Token -and $Token.Length -gt 0)
$tokenFile = Join-Path $env:USERPROFILE '.ciudadan-tts-coordinator\token'
Check "Archivo de token existe" (Test-Path $tokenFile)

# 8. Claude Code hook
Write-Host "`n[8] Claude Code:" -ForegroundColor Yellow
$claudeSettings = Join-Path $env:USERPROFILE '.claude\settings.json'
if (Test-Path $claudeSettings) {
    $cs = Get-Content $claudeSettings -Raw
    Check "Hook registrado en settings.json" ($cs -match 'ciudadan-tts-coordinator')
} else {
    Check "Hook registrado en settings.json (no instalado aún)" $false
}

# 9. API responde con auth
if ($Token) {
    Write-Host "`n[9] API con autenticación:" -ForegroundColor Yellow
    try {
        $h = @{ 'Authorization' = "Bearer $Token" }
        $s = Invoke-RestMethod -Uri "$CoordinatorUrl/api/v1/status" -Headers $h -TimeoutSec 5
        Check "Status con token → 200" $s.ok
        try { Invoke-RestMethod -Uri "$CoordinatorUrl/api/v1/status" -TimeoutSec 3 -ErrorAction Stop; Check "Sin token → 401" $false }
        catch { Check "Sin token → 401" ($_.Exception.Response.StatusCode.value__ -eq 401) }
    } catch {
        Check "Status con token" $false
    }
}

# 10. Servicios existentes no afectados
Write-Host "`n[10] Servicios existentes:" -ForegroundColor Yellow
foreach ($port in @(3080, 3081, 3091, 8765, 8770)) {
    $open = (Test-NetConnection -ComputerName 127.0.0.1 -Port $port -WarningAction SilentlyContinue).TcpTestSucceeded
    Check "Puerto $port sigue activo (no afectado)" $open
}

Write-Host "`n=== RESULTADO: $pass OK, $fail fallos ===" -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Yellow' })
exit $(if ($fail -eq 0) { 0 } else { 1 })
