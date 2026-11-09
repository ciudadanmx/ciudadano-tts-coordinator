import sys, json, os, glob
import zstandard as zstd

# CRÍTICO (Windows): la salida debe ser UTF-8. Por defecto Python usa cp1252 en
# stdout y Node decodifica como UTF-8 -> los acentos se pierden ("Cómo" -> "C?mo").
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

# Uso: read-titles.py <cache_file> <home1> [home2...]
# Devuelve JSON {sessionId: titulo_real} leyendo eventos "session/title" (el último gana)
# de las sesiones más recientes (máx 80) en <home>/sessions/<proyecto>/<session-*>/session*.jsonl.zstd
# Solo lee los primeros 2 MB de cada archivo (los títulos viven al inicio).
MAX_FILES = 150
MAX_BYTES = 1536 * 1024

cache_file = sys.argv[1]
homes = sys.argv[2:]
cache = {'titles': {}, 'files': {}}
try:
    cache = json.load(open(cache_file, encoding='utf-8'))
    cache.setdefault('titles', {})
    cache.setdefault('files', {})
except Exception:
    pass

out = dict(cache.get('titles') or {})
files = dict(cache.get('files') or {})
changed = False

# Emitir INMEDIATAMENTE el cache (para que el servidor tenga títulos al instante);
# al final se emite la versión actualizada tras el escaneo.
print(json.dumps(out, ensure_ascii=False), flush=True)

cands = []
for home in homes:
    try:
        for proj in os.scandir(os.path.join(home, 'sessions')):
            if not proj.is_dir():
                continue
            try:
                for sd in os.scandir(proj.path):
                    # NO se exige el prefijo 'session-': las sesiones NUEVAS usan el
                    # UUID puro como nombre de directorio (p.ej. ed00cf7a-b7c1-...).
                    # Con el filtro antiguo esas sesiones quedaban fuera del índice
                    # y el coordinador anunciaba el ID en vez del título real.
                    if not sd.is_dir():
                        continue
                    for sf in os.scandir(sd.path):
                        if sf.is_file() and sf.name.startswith('session') and sf.name.endswith('.jsonl.zstd'):
                            try:
                                cands.append((sf.stat().st_mtime, sf.path))
                            except Exception:
                                pass
            except Exception:
                pass
    except Exception:
        pass
cands.sort(reverse=True)
cands = cands[:MAX_FILES]

for mt, f in cands:
    if files.get(f) == mt:
        continue
    changed = True
    sid = os.path.basename(os.path.dirname(f))
    title = None
    try:
        with open(f, 'rb') as fh:
            reader = zstd.ZstdDecompressor().stream_reader(fh)
            buf = b''
            while len(buf) < MAX_BYTES:
                chunk = reader.read(256 * 1024)
                if not chunk:
                    break
                buf += chunk
            text = buf.decode('utf-8', 'replace')
        for line in text.splitlines():
            if '"session/title"' not in line:
                continue
            try:
                obj = json.loads(line)
                t = (obj.get('data') or {}).get('title')
                if t:
                    title = t  # el último session/title dentro del fragmento leído gana
            except Exception:
                pass
        if title:
            out[sid] = title
        files[f] = mt
    except Exception:
        pass

if changed:
    try:
        json.dump({'titles': out, 'files': files}, open(cache_file, 'w', encoding='utf-8'))
    except Exception:
        pass
print(json.dumps(out, ensure_ascii=False), flush=True)
