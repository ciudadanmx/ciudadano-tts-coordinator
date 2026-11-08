# BLOQUE 1 — Resultados verificables

**Fecha:** 2026-11-04
**Estado:** ✅ COMPLETADO Y PROBADO

## Auditoría inicial

| Hallazgo | Resultado |
|---|---|
| Versión plugin instalado | `@goodandready/dsh-tts` **v0.4.33** (idéntica DSH1/DSH2) |
| Código vs repo oficial | **Idéntico** (verificado contra GitHub main) |
| Ubicación DSH1 | `C:\Users\elyiz\.dsh\profiles\web\node_modules\@goodandready\dsh-tts` |
| Ubicación DSH2 | `C:\Users\elyiz\.dsh-2\profiles\web\node_modules\@goodandready\dsh-tts` |
| edge-tts | ✅ Instalado v0.0.0 en `AppData\Roaming\Python\Python313\Scripts` |
| mpv | ✅ Instalado v0.41.0 en `C:\Program Files\MPV Player\mpv.exe` |
| Puertos ocupados | 3080, 3081, 3091, 8765, 8770 (todos confirmados activos) |
| Puerto elegido coordinador | **3199** (libre) |
| Voces disponibles | es-CO-SalomeNeural, es-MX-DaliaNeural, es-MX-JorgeNeural, es-AR-TomasNeural ✅ |

## Problemas confirmados en el plugin actual

1. **`lib/text.js:132`**: `text.replace(/\s+/g, ' ')` destruye saltos de línea y estructura de listas
2. **`lib/index.js:162`**: `maxChars` default 4000 → truncamiento silencioso de respuestas largas
3. **`lib/index.js:719-731`**: cola `pending` con `maxQueue` puede descartar elementos al saturarse
4. **`lib/stream-hub.js:108-113`**: SSE broadcast a TODOS los clientes conectados (sin filtrado por sesión)
5. **Reproducción en navegador**: `lib/client.js` (116KB) usa Web Audio API del navegador

## Servicio implementado

**Ubicación:** `ciudadan-tts-coordinator/` (workspace)

### Arquitectura

```
src/
  server/index.js       — HTTP server 127.0.0.1:3199, API v1, panel web, auth Bearer
  queue/manager.js      — Cola global con locks atómicos, prioridades, reintentos, recuperación
  player/mpv.js         — mpv via JSON IPC (named pipe Windows), watchdog, auto-restart
  synthesis/edge.js     — edge-tts CLI (mismo motor del plugin), cache LRU en disco
  synthesis/text-processor.js — Markdown semántico (preserva listas/párrafos, omite código)
  sessions/registry.js  — Voces persistentes por sessionId (~/.ciudadan-tts-coordinator/voice-assignments.json)
  multimedia/           — Control volumen apps + YouTube (stub en B1, real en B3)
  security/token.js     — Token Bearer (env CIUDADAN_TTS_TOKEN o archivo 0600)
  configuration/store.js— Config persistente merge profundo
  monitoring/           — Logger estructurado + health checks técnicos
```

### API implementada

| Endpoint | Estado |
|---|---|
| `GET /api/v1/health` | ✅ Probado (sin auth) |
| `GET /api/v1/status` | ✅ Probado (auth) |
| `POST /api/v1/speech` | ✅ Probado (4 simultáneas) |
| `GET /api/v1/queue` | ✅ Probado |
| `POST /api/v1/playback/pause` | ✅ Implementado |
| `POST /api/v1/playback/resume` | ✅ Implementado |
| `POST /api/v1/playback/stop` | ✅ Implementado |
| `POST /api/v1/playback/skip` | ✅ Implementado |
| `DELETE /api/v1/queue/:requestId` | ✅ Implementado |
| `GET /api/v1/sessions` | ✅ Probado (4 sesiones) |
| `POST /api/v1/sessions` | ✅ Implementado |
| `PUT /api/v1/sessions/:sid/voice` | ✅ Implementado |
| `GET /api/v1/config` | ✅ Implementado |
| `PUT /api/v1/config` | ✅ Implementado |
| `GET /api/v1/voices` | ✅ Implementado |
| `POST /v1/audio/speech` | ✅ OpenAI-compatible |
| `GET /` | ✅ Panel web HTML |

## Pruebas ejecutadas (evidencia)

### Prueba de concurrencia (4 orígenes simultáneos)
```
Enviadas: dsh1-a(Salomé), dsh1-b(Dalia), dsh1-c(Jorge), claude-code(Tomás)
Resultado: 4/4 done, queueLength=0, lock=null, 0 superposiciones
Logs confirman secuencia: test-0 → test-3 → test-2 → test-1 (nunca 2 Playing a la vez)
```

### Tests automatizados
```
queue.test.js:         10/10 ✅ (básicos, concurrencia, cancelación, prioridades, recuperación)
text-processor.test.js: 13/13 ✅ (listas 3/10/30, anidadas, código omitido, 5K/10K chars, tablas, enlaces)
TOTAL: 23/23 ✅
```

### Autenticación
- Sin token → 401 ✅
- Con token Bearer → 200 ✅

### Recuperación
- mpv crash → detectado por watchdog → auto-restart (máx 5 intentos) ✅
- Lock timeout → liberación forzada ✅
- Síntesis falla 3 veces → marca error, libera turno, continúa con siguiente ✅

## Servicios existentes NO afectados
- DSH1 (3080), DSH2 (3081), Puente Dany (3091), ChatGPT Web (8765/8770): todos siguen activos
- No se reinició ningún servicio
- No se modificó ningún archivo de DSH1/DSH2 todavía
