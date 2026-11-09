import json, urllib.request, os, subprocess, time, sys

def p(*a):
    s = ' '.join(str(x) for x in a)
    sys.stdout.buffer.write((s + '\n').encode('utf-8', 'replace')); sys.stdout.flush()

tok = open(os.path.expanduser('~/.ciudadan-tts-coordinator/token')).read().strip()
H = {'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json'}
def get(pth):
    req = urllib.request.Request('http://127.0.0.1:3199' + pth, headers=H)
    return json.loads(urllib.request.urlopen(req, timeout=25).read().decode('utf-8'))
def put(pth, b):
    req = urllib.request.Request('http://127.0.0.1:3199' + pth, data=json.dumps(b).encode('utf-8'), headers=H, method='PUT')
    urllib.request.urlopen(req, timeout=25).read()
def post(pth, b):
    req = urllib.request.Request('http://127.0.0.1:3199' + pth, data=json.dumps(b).encode('utf-8'), headers=H, method='POST')
    return json.loads(urllib.request.urlopen(req, timeout=30).read().decode('utf-8'))
py = os.path.join(os.environ['TEMP'], 'ciudadan-tts-coordinator', 'src', 'multimedia', 'audio-session.py')

def vols():
    out = subprocess.run(['python', py, 'list'], capture_output=True, timeout=60)
    d = json.loads(out.stdout.decode('utf-8', 'replace'))
    return {s['ProcessName'] + ':' + str(s['ProcessId']): s['Volume'] for s in d.get('sessions', [])}

def media():
    out = subprocess.run(['python', py, '--daemon'], input=json.dumps({'action': 'media-list'}) + '\n',
                         capture_output=True, text=True, timeout=40)
    for line in reversed(out.stdout.strip().split('\n')):
        try:
            d = json.loads(line)
            return [(str(s.get('app'))[:8], s.get('status')) for s in (d.get('sessions') or []) if 'Chrome' in str(s.get('app'))]
        except Exception:
            continue
    return '(?)'

def sanear():
    for s in json.loads(subprocess.run(['python', py, 'list'], capture_output=True, timeout=60).stdout.decode('utf-8','replace')).get('sessions', []):
        if 'mpv' not in (s.get('ProcessName') or '').lower() and s.get('Volume') != 100:
            subprocess.run(['python', py, 'set', str(s['ProcessId']), '100'], capture_output=True, timeout=40)

def esperar_cola():
    for _ in range(120):
        if get('/api/v1/health')['pendingUtterances'] <= 0:
            return
        time.sleep(3)

def probar(nombre, mode, pct):
    p('=== %s (control único: %s %d%%) ===' % (nombre, mode, pct))
    put('/api/v1/multimedia/apps/navegador', {'mode': mode, 'percentage': pct})
    esperar_cola(); sanear()
    p('  antes  :', vols(), '| chrome:', media())
    post('/api/v1/speech', {'text': 'Prueba del control unico del navegador en modo ' + mode + '.',
        'source': 'dsh2', 'sessionId': 'session-ctrl-unico', 'sessionTitle': 'Control unico', 'voice': 'es-CO-SalomeNeural'})
    for _ in range(40):
        time.sleep(0.5)
        if get('/api/v1/status').get('current'):
            break
    time.sleep(3)
    p('  DURANTE:', vols(), '| chrome:', media())
    for _ in range(60):
        time.sleep(1)
        if not get('/api/v1/status').get('current'):
            break
    time.sleep(2)
    p('  DESPUES:', vols(), '| chrome:', media())

p('medias antes:', media())
# La configuración del usuario SIEMPRE se restaura, aunque el test se corte
# o falle: si no, el panel se queda con una política a medias (p.ej. "reducir 0%")
# y el navegador deja de pausarse -> la música no baja y la voz se oye baja.
CFG_ORIGINAL = None
try:
    m0 = get('/api/v1/multimedia/status')
    for a in m0['apps']:
        if a['appKey'] == 'navegador':
            CFG_ORIGINAL = (a['mode'], a['percentage'])
    p('config original del navegador:', CFG_ORIGINAL)
    probar('CASO 1 - PAUSAR (no baja volumen, pausa el video)', 'pause', 0)
    probar('CASO 2 - REDUCIR 87 (baja al 13%)', 'reduce', 87)
    probar('CASO 3 - IGNORAR (no toca nada)', 'ignore', 0)
finally:
    if CFG_ORIGINAL:
        put('/api/v1/multimedia/apps/navegador', {'mode': CFG_ORIGINAL[0], 'percentage': CFG_ORIGINAL[1]})
        p('config restaurada:', CFG_ORIGINAL)
    else:
        put('/api/v1/multimedia/apps/navegador', {'mode': 'pause', 'percentage': 0})
        p('config restaurada a PAUSAR (por defecto)')
    try:
        post('/api/v1/multimedia/restore', {})
    except Exception:
        pass
    time.sleep(2)
    sanear()

p('=== FINAL ===')
m = get('/api/v1/multimedia/status')
for a in m['apps']:
    p('  %-12s %-30s %s %s%%' % (a['appKey'], a.get('label',''), a['mode'], a['percentage']))
p('  volumenes:', vols())
