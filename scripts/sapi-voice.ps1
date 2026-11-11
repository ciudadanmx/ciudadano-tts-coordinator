# sapi-voice.ps1 — daemon de voz local de Windows (respaldo del sintetizador).
#
# POR QUE EXISTE (10/11/2026): edge-tts (servicio de Microsoft por internet) se
# cuelga de forma intermitente. Medido en este equipo: 2 de 3 pruebas pasaron de
# 120 s sin escribir un solo byte, y las que funcionaron tardaron 87 s (antes
# tardaban 23-39 s). Con edge-tts caido, las locuciones se perdian o sonaban
# entrecortadas.
#
# QUE HACE: lee una peticion JSON por linea en stdin:
#   {"id":"1","text":"hola","out":"C:\\...\\voz.wav","voice":"Microsoft Sabina Desktop"}
# y responde una linea JSON:
#   {"id":"1","ok":true,"bytes":171094}   |   {"id":"1","ok":false,"error":"..."}
#
# El motor de voz se carga UNA vez al arrancar (la primera sintesis tarda ~15 s,
# las siguientes <1 s). Es 100% local: no necesita internet.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech

# Voz por defecto: la de español de Mexico instalada en Windows.
$DefaultVoice = 'Microsoft Sabina Desktop'

# Comprobar que la voz existe antes de arrancar.
$sp = New-Object System.Speech.Synthesis.SpeechSynthesizer
$installed = @($sp.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name })
$preferidas = @('Microsoft Sabina Desktop', 'Microsoft Raul', 'Microsoft Sabina')
$voz = $null
foreach ($v in $preferidas) { if ($installed -contains $v) { $voz = $v; break } }
if (-not $voz) { $voz = $sp.Voice.Name }
$sp.Dispose()

# Escribir DIRECTO a la consola: Write-Output se bufferiza en el pipeline y el
# cliente no recibia la linea 'ready' (el daemon parecia vivo pero mudo).
function Emit([string]$Line) {
  [Console]::Out.WriteLine($Line)
  [Console]::Out.Flush()
}

Emit ('{{"ok":true,"ready":true,"voice":"{0}"}}' -f ($voz -replace '"', '\"'))

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if (-not $line) { continue }

  $id = ''
  try {
    $req = $line | ConvertFrom-Json
    $id = [string]$req.id
    $texto = [string]$req.text
    $salida = [string]$req.out
    $v = if ($req.voice) { [string]$req.voice } else { $voz }
    if (-not $texto) { throw 'texto vacio' }
    if (-not $salida) { throw 'falta la ruta de salida' }

    $syn = New-Object System.Speech.Synthesis.SpeechSynthesizer
    try {
      try { $syn.SelectVoice($v) } catch { }
      $syn.Rate = if ($null -ne $req.rate) { [int]$req.rate } else { 0 }
      $syn.Volume = if ($null -ne $req.volume) { [int]$req.volume } else { 100 }
      $syn.SetOutputToWaveFile($salida)
      $syn.Speak($texto)
      $syn.SetOutputToNull()
    } finally {
      $syn.Dispose()
    }

    $bytes = 0
    if (Test-Path -LiteralPath $salida) { $bytes = (Get-Item -LiteralPath $salida).Length }
    if ($bytes -lt 512) { throw 'el audio generado esta vacio' }
    Emit ('{{"id":"{0}","ok":true,"bytes":{1},"voice":"{2}"}}' -f ($id -replace '"', '\"'), $bytes, ($v -replace '"', '\"'))
  } catch {
    $msg = $_.Exception.Message -replace '"', "'"
    Emit ('{{"id":"{0}","ok":false,"error":"{1}"}}' -f ($id -replace '"', '\"'), $msg)
  }
}
