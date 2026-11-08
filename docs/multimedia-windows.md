# Control multimedia en Windows — Ducking configurable por aplicación

## Estado actual (2026-11-05) — IMPLEMENTADO Y VERIFICADO CON SESIONES REALES

El control de volumen por aplicación usa la **Core Audio API via Python (pycaw/comtypes)**,
que accede a `IAudioSessionManager2` de forma nativa y confiable (el interop COM manual desde
PowerShell/Add-Type fallaba con QI E_NOINTERFACE en este entorno; por eso el puente es Python).

### Arquitectura

- `src/multimedia/audio-session.py` — puente Python (pycaw). Acciones: `list`, `get <pid>`,
  `set <pid> <0-100>`, `duck <nombres-csv> <pct>`, `restore <snapshots-json>`.
  Opera sobre **ISimpleAudioVolume por sesión de proceso** — NUNCA sobre el volumen maestro
  de Windows.
- `src/multimedia/windows-audio.js` — `WindowsAudioBridge`: ejecuta el script Python con
  `spawn('python', ...)` y parsea el JSON resultante.
- `src/multimedia/controller.js` — políticas por app, snapshot/restore, rescan cada 2s,
  respeto de cambios manuales.
- `src/multimedia/youtube.js` — pausa selectiva de pestañas YouTube via CDP (puerto 9222).

### Modos por app (configurables desde el panel web y via API)

| Modo | Comportamiento |
|---|---|
| `pause` | Suspende la reproducción de la app (solo YouTube via CDP; solo pestañas que reproducen y coinciden con `matchUrl`). Si la app no admite pausa selectiva, el panel lo indica (`pauseSupported:false`) y NO se simula. |
| `reduce` | Reduce el volumen de cada sesión de la app al X% respecto a su **volumen original** (0=sin cambio, 100=silencio). Se restaura al terminar la secuencia. |
| `ignore` | No toca la app. |

### Reglas obligatorias implementadas

- Nunca se toca el volumen maestro de Windows (solo por sesión).
- Nunca se toca la voz del coordinador (mpv está excluido siempre).
- No se restaura entre fragmentos consecutivos de una misma cola (una sola aplicación por secuencia).
- Se respetan los cambios manuales del usuario: al restaurar, si el volumen actual difiere
  más de 3% del que pusimos nosotros, no lo pisamos.
- Múltiples sesiones por app y sesiones que aparecen durante la locución (rescan cada 2s).
- Recuperación ante cancelación/error (restore en finally + snapshot en disco).
- No se reanuda contenido pausado manualmente (solo lo que nosotros pausamos, `pausedByUs`).

### Config por defecto (`config/default.json` → `~/.ciudadan-tts-coordinator/config.json`)

```json
"multimedia": {
  "applications": {
    "youtube": { "mode": "pause", "percentage": 100, "processNames": ["chrome"], "matchUrl": "youtube.com", "pauseSupported": true },
    "chrome":  { "mode": "reduce", "percentage": 30, "processNames": ["chrome"], "pauseSupported": false },
    "spotify": { "mode": "ignore", "percentage": 0, "processNames": ["spotify"] },
    "vlc":     { "mode": "ignore", "percentage": 0, "processNames": ["vlc"] }
  },
  "youtube": { "pauseEnabled": true, "resumeAutomatically": true, "port": 9222 }
}
```

### API

- `GET /api/v1/multimedia/status` — estado por app: sesiones detectadas, volumen actual,
  estado ducking, config persistida, `audioBridgeAvailable`.
- `GET /api/v1/multimedia/sessions` — sesiones de audio crudas (pid, proceso, volumen).
- `PUT /api/v1/multimedia/apps/:appKey` — body `{ mode, percentage }` → persiste en config.
- `POST /api/v1/multimedia/restore` — fuerza restauración inmediata.

### Verificación realizada (2026-11-05, sesiones reales)

- Chrome con 2-3 sesiones: reduce 30% → 100→70; reduce 80% → 55→11 (sobre original 55).
- Spotify en `ignore`: siempre 100. mpv (voz del coordinador): siempre 100. Volumen maestro intacto.
- YouTube (Chrome temporal con `--remote-debugging-port=9222`, video real reproduciéndose):
  pausado durante la locución (`paused:true` verificado via CDP), reanudado al terminar.
  Solo pestañas `youtube.com`; no se pausa todo Chrome.
- Cambio manual durante ducking (chrome→90): respetado, no restaurado a 55.
- Sesión chrome nueva aparecida mid-locución: ducked por el rescan (100→20).
- Restauración al final de la cola: chrome volvió a 100.

### Dependencia

`python` en PATH con `pycaw` instalado (`pip install pycaw`). Si falta, el coordinador
arranca igual y reporta `audioBridgeAvailable:false` en el panel (modo stub, no rompe el TTS).
