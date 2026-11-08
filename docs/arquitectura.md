# Arquitectura técnica — ciudadano-tts-coordinator

## Componentes

### 1. Servidor HTTP (`src/server/index.js`)
- Escucha en `127.0.0.1:3199` (configurable)
- API versionada `/api/v1/*`
- Autenticación Bearer token (comparación constant-time)
- Panel web HTML en `/`
- Endpoint OpenAI-compatible `/v1/audio/speech`

### 2. Cola global (`src/queue/manager.js`)
- **Locks atómicos**: `acquireLock()` con timeout configurable
- **Ordenamiento**: por prioridad (high/normal/low), luego por llegada (seq), luego por fragmento
- **Estados**: queued → synthesizing → ready → playing → done/error/cancelled
- **Deduplicación**: requestId único rechaza duplicados activos
- **Reintentos**: hasta 3 intentos en síntesis con backoff exponencial
- **Recuperación**: lock timeout libera turno forzosamente; player crash detectado por watchdog

### 3. Reproductor mpv (`src/player/mpv.js`)
- IPC via named pipe (Windows) o Unix socket
- Watchdog cada 3s detecta proceso caído
- Auto-restart hasta 5 intentos en ventana de 60s
- Comandos: play, pause, resume, stop, skip, setVolume
- Evento `end-file` confirma terminación real del audio

### 4. Síntesis (`src/synthesis/edge.js`)
- Usa `edge-tts` CLI (mismo motor que el plugin dsh-tts)
- Cache LRU en disco (`~/.ciudadan-tts-coordinator/audio-cache/`)
- Límite de cache configurable (default 200MB)

### 5. Procesador de texto (`src/synthesis/text-processor.js`)
- Markdown → texto hablado preservando estructura semántica
- Listas numeradas/viñetas/anidadas se conservan con indicadores de nivel
- Código en bloque e inline se omite
- Tablas se resumen; imágenes se omiten (o anuncian alt text)
- Respuestas largas se dividen en chunks sin truncamiento silencioso

### 6. Sesiones y voces (`src/sessions/registry.js`)
- Asignación persistente en `~/.ciudadan-tts-coordinator/voice-assignments.json`
- Auto-asignación por source (dsh1/dsh2/claude-code)
- Resolución de nombre: taskTitle > title > displayTitle > cwd basename > sessionId corto

### 7. Multimedia (`src/multimedia/`)
- `controller.js`: orquesta ducking + YouTube
- `windows-audio.js`: puente a Core Audio API (COM via PowerShell helper)
- `youtube.js`: CDP en puerto 9222 para pausar/reanudar YouTube
- Snapshots por app para restauración segura
- No modifica volumen maestro ni mpv

### 8. Seguridad (`src/security/token.js`)
- Token generado con `randomBytes(32)` si no hay env var
- Almacenado con permisos 0600 en `~/.ciudadan-tts-coordinator/token`
- Validación constant-time (SHA-256 comparison)
- CORS restringido a `null` (no acepta requests de páginas web arbitrarias)

## Flujo de una locución

```
1. Agente envía POST /api/v1/speech {source, sessionId, text, voice, ...}
2. Servidor registra sesión y asigna voz si es nueva
3. Cola encola utterance con lock atómico
4. Síntesis: edge-tts genera MP3 (con cache)
5. Anuncio de tarea se antepone si está habilitado y fragmentIndex=0
6. Multimedia aplica ducking (si modo != none)
7. mpv reproduce el archivo via IPC
8. Al terminar (end-file): estado → done, lock liberado
9. Si no hay más pendientes: multimedia restaura volúmenes
10. Cola procesa siguiente utterance
```

## Recuperación ante fallos

| Fallo | Detección | Recuperación |
|---|---|---|
| mpv crash | Watchdog 3s / proceso close | Auto-restart máx 5 intentos |
| Lock bloqueado | Timeout configurable (120s) | Liberación forzada + siguiente |
| Síntesis falla | 3 intentos con backoff | Marca error, libera turno, continúa |
| Sesión cerrada | cancelSession() | Cancela todas sus solicitudes pendientes |
| Node cierra inesperadamente | Estado persistido en disco | Al reiniciar, cola reconstruye desde estado |
