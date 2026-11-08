#Requires -Version 5.1
# test-coordinator.ps1 — Pruebas end-to-end del ciudadano-tts-coordinator
# Ejecutar con el coordinador ya corriendo.

param(
    [string]$Token = $env:CIUDADAN_TTS_TOKEN,
    [string]$BaseUrl = 'http://127.0.0.1:3199',
    [switch]$SkipAudio
)

$ErrorActionPreference = 'Continue'
$headers = @{ 'Authorization' = "Bearer $Token"; 'Content-Type' = 'application/json' }
$pass = 0; $fail = 0

function Test-Step($name, $scriptBlock) {
    Write-Host "  [$name] " -NoNewline
    try {
        $result = & $scriptBlock
        if ($result) { Write-Host "✅ PASS" -ForegroundColor Green; $script:pass++ }
        else { Write-Host "❌ FAIL" -ForegroundColor Red; $script:fail++ }
    } catch {
        Write-Host "❌ ERROR: $_" -ForegroundColor Red; $script:fail++
    }
}

Write-Host "=== PRUEBAS DEL COORDINADOR ($BaseUrl) ===" -ForegroundColor Cyan

# 1. Health
Test-Step "health endpoint" {
    $r = Invoke-RestMethod -Uri "$BaseUrl/api/v1/health" -ErrorAction Stop
    return $r.status -eq 'healthy'
}

# 2. Auth requerida
Test-Step "auth requerida (401 sin token)" {
    try { Invoke-RestMethod -Uri "$BaseUrl/api/v1/status" -ErrorAction Stop; return $false }
    catch { return $_.Exception.Response.StatusCode.value__ -eq 401 }
}

# 3. Status con auth
Test-Step "status con token" {
    $r = Invoke-RestMethod -Uri "$BaseUrl/api/v1/status" -Headers $headers -ErrorAction Stop
    return $r.ok -eq $true
}

# 4. Enviar locución
Test-Step "POST /api/v1/speech" {
    $body = @{ requestId = "test-$(Get-Random)"; source = 'test'; sessionId = 'test-sess'; text = 'Prueba de locución.'; voice = 'es-CO-SalomeNeural' } | ConvertTo-Json
    $r = Invoke-RestMethod -Uri "$BaseUrl/api/v1/speech" -Method POST -Headers $headers -Body $body -ErrorAction Stop
    return $r.ok -eq $true
}

# 5. Cola observable
Test-Step "GET /api/v1/queue" {
    $r = Invoke-RestMethod -Uri "$BaseUrl/api/v1/queue" -Headers $headers -ErrorAction Stop
    return $r.ok -eq $true -and $null -ne $r.items
}

# 6. Sesiones
Test-Step "GET /api/v1/sessions" {
    $r = Invoke-RestMethod -Uri "$BaseUrl/api/v1/sessions" -Headers $headers -ErrorAction Stop
    return $r.ok -eq $true
}

# 7. Config
Test-Step "GET /api/v1/config" {
    $r = Invoke-RestMethod -Uri "$BaseUrl/api/v1/config" -Headers $headers -ErrorAction Stop
    return $r.ok -eq $true -and $null -ne $r.config
}

# 8. Voces
Test-Step "GET /api/v1/voices" {
    $r = Invoke-RestMethod -Uri "$BaseUrl/api/v1/voices" -Headers $headers -ErrorAction Stop
    return $r.ok -eq $true
}

# 9. OpenAI-compatible endpoint
if (-not $SkipAudio) {
    Test-Step "POST /v1/audio/speech (OpenAI compat)" {
        $body = @{ input = 'Prueba de audio.'; voice = 'es-CO-SalomeNeural' } | ConvertTo-Json
        $r = Invoke-RestMethod -Uri "$BaseUrl/v1/audio/speech" -Method POST -Headers $headers -Body $body -ErrorAction Stop -ContentType 'application/json'
        return $null -ne $r
    }
}

# 10. Panel web
Test-Step "GET / (panel HTML)" {
    $r = Invoke-WebRequest -Uri "$BaseUrl/" -ErrorAction Stop
    return $r.Content -match 'CIUDADAN TTS COORDINATOR'
}

Write-Host ""
Write-Host "=== RESULTADOS: $pass pasaron, $fail fallaron ===" -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Red' })
exit $(if ($fail -eq 0) { 0 } else { 1 })
