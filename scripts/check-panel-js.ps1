# check-panel-js.ps1 — guard de regresion del panel.
#
# El HTML del panel es un TEMPLATE LITERAL (backticks) dentro de
# src/server/index.js. Cualquier escape dentro de un string JS embebido
# (\' o \n) se colapsa al servir y ROMPE todo el <script>: el panel queda
# en blanco (sin colas ni configuracion) aunque la API responda bien.
#
# Este script descarga http://127.0.0.1:3199/, extrae el <script> inline y
# le pasa `node --check`. Si falla, el despliegue del panel esta roto.
# Úsalo ANTES de reiniciar el coordinador tras tocar el HTML/JS del panel.
#
# Uso:  powershell.exe -File scripts\check-panel-js.ps1
#   (o contra el fuente sin servidor: extrae el template de index.js)

param(
  [string]$Url = 'http://127.0.0.1:3199/',
  [string]$IndexJs = ''
)
$ErrorActionPreference = 'Stop'

$tmp = Join-Path $env:TEMP 'ciudadan-panel-check'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$py = @"
import re, sys, urllib.request
html = urllib.request.urlopen('$Url', timeout=20).read().decode('utf-8', 'replace')
scripts = re.findall(r'<script>(.*?)</script>', html, re.S)
open(r'$tmp\panel-served.js', 'w', encoding='utf-8').write('\n;\n'.join(scripts))
print('  bloques <script> inline:', len(scripts))
"@

if ($IndexJs -and (Test-Path -LiteralPath $IndexJs)) {
  # modo "fuente": extrae el template literal del index.js y lo evalua como html
  $py = @"
import re
src = open(r'$IndexJs', encoding='utf-8').read()
m = re.search(r'const html = \x60(.*?)\x60', src, re.S)
html = m.group(1)
scripts = re.findall(r'<script>(.*?)</script>', html, re.S)
open(r'$tmp\panel-served.js', 'w', encoding='utf-8').write('\n;\n'.join(scripts))
print('  bloques <script> inline (desde fuente):', len(scripts))
"@
}

python -c $py | ForEach-Object { Write-Output "  $_" }
node --check (Join-Path $tmp 'panel-served.js')
if ($LASTEXITCODE -eq 0) {
  Write-Output '  OK: el JS del panel compila (node --check = 0). Se puede desplegar.'
  exit 0
} else {
  Write-Output '  FALLO: el JS servido del panel NO compila. NO reinicies el coordinador: arregla los escapes del template literal primero.'
  exit 1
}
