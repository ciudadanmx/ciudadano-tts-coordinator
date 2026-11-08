# 🎙️ ciudadano-tts-coordinator

**Sistema unificado de voces, sesiones y control multimedia para DSH1, DSH2 y Claude Code.**

Servicio independiente en Node.js que coordina la síntesis de voz (TTS) de múltiples agentes,
garantizando que solo una voz se reproduzca a la vez, con voces distintas por sesión,
anuncios de tarea, lectura completa de Markdown y control multimedia de Windows.

## Características principales

- ✅ **Cola global única** — todos los agentes (DSH1, DSH2, Claude Code) comparten una cola
- ✅ **Una sola voz a la vez** — reproducción secuencial garantizada via locks atómicos
- ✅ **Voces por sesión** — cada sessionId tiene su voz persistente (Salomé, Dalia, Jorge, Tomás)
- ✅ **Anuncios de tarea** — anuncia el nombre real de la sesión/tarea antes de hablar
- ✅ **Markdown semántico** — listas, párrafos y respuestas largas se leen completos; código se omite
- ✅ **Reproductor independiente** — mpv via IPC (no usa Chrome para audio)
- ✅ **Control multimedia** — reduce volumen de Chrome/Spotify/VLC y pausa YouTube automáticamente
- ✅ **Recuperación automática** — detecta fallos de mpv, locks expirados, errores de síntesis
- ✅ **API local segura** — 127.0.0.1 con autenticación Bearer token
- ✅ **Panel web** — interfaz de administración en el navegador
- ✅ **Reversible** — se puede desactivar y volver al plugin original sin pérdida

## Inicio rápido

```powershell
# 1. Instalar dependencias (mpv requerido)
powershell -File scripts/install-mpv.ps1

# 2. Iniciar el coordinador
$env:CIUDADAN_TTS_TOKEN = 'tu-token-seguro'
node src/server/index.js

# 3. Abrir panel de control
# http://127.0.0.1:3199/

# 4. Ejecutar pruebas
node --test tests/
powershell -File scripts/test-coordinator.ps1 -Token 'tu-token-seguro'
```

## Arquitectura

```
┌─────────────┐  ┌─────────────┐  ┌──────────────┐
│   DSH1      │  │   DSH2      │  │ Claude Code  │
│  (puerto    │  │  (puerto    │  │   (hooks)    │
│   3080)     │  │   3081)     │  │              │
└──────┬──────┘  └──────┬──────┘  └──────┬───────┘
       │                │                │
       │  POST /api/v1/speech (Bearer token)
       ▼                ▼                ▼
┌─────────────────────────────────────────────┐
│     ciudadano-tts-coordinator               │
│  ┌─────────┐  ┌──────────┐  ┌───────────┐  │
│  │  Cola   │→ │ Síntesis │→ │   mpv     │  │
│  │ global  │  │ edge-tts │  │  (IPC)    │  │
│  └─────────┘  └──────────┘  └───────────┘  │
│       │                          │          │
│       ▼                          ▼          │
│  ┌─────────┐              ┌──────────┐     │
│  │ Sesiones│              │ Multimedia│    │
│  │+voces   │              │ (ducking) │    │
│  └─────────┘              └──────────┘     │
│  127.0.0.1:3199                              │
└─────────────────────────────────────────────┘
```

## API

Todas las rutas (excepto `/api/v1/health` y `/`) requieren header:
```
Authorization: Bearer <token>
```

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/v1/health` | Estado del servicio (sin auth) |
| GET | `/api/v1/status` | Estado actual: speaking, cola, lock |
| POST | `/api/v1/speech` | Encolar locución |
| GET | `/api/v1/queue` | Ver cola completa |
| POST | `/api/v1/playback/pause` | Pausar reproducción |
| POST | `/api/v1/playback/resume` | Reanudar |
| POST | `/api/v1/playback/stop` | Detener |
| POST | `/api/v1/playback/skip` | Saltar actual |
| DELETE | `/api/v1/queue/:id` | Cancelar solicitud |
| GET | `/api/v1/sessions` | Sesiones registradas |
| POST | `/api/v1/sessions` | Registrar sesión |
| PUT | `/api/v1/sessions/:id/voice` | Asignar voz |
| GET/PUT | `/api/v1/config` | Leer/modificar config |
| GET | `/api/v1/voices` | Voces disponibles |
| POST | `/v1/audio/speech` | OpenAI-compatible (solo genera audio) |

### Ejemplo de solicitud

```json
POST /api/v1/speech
{
  "requestId": "uuid",
  "source": "dsh2",
  "sessionId": "sesion-123",
  "sessionTitle": "Infraestructura Discord",
  "taskTitle": "Infraestructura Discord",
  "voice": "es-CO-SalomeNeural",
  "text": "Tenemos tres tareas: 1. Revisar conexiones. 2. Actualizar servicios. 3. Ejecutar pruebas.",
  "priority": "normal"
}
```

## Voces asignadas

| Perfil | Voz | Locale |
|---|---|---|
| DSH sesión A | `es-CO-SalomeNeural` | Colombia, femenina |
| DSH sesión B | `es-MX-DaliaNeural` | México, femenina |
| DSH sesión C | `es-MX-JorgeNeural` | México, masculino |
| Claude Code | `es-AR-TomasNeural` | Argentina, masculino |

Las asignaciones se guardan en `~/.ciudadan-tts-coordinator/voice-assignments.json`.

## Reversión

Para volver al comportamiento anterior (plugin TTS reproduciendo en navegador):

```powershell
# En cada DSH:
powershell -File ciudadano-tts-coordinator/scripts/configure-dsh-plugin.ps1 -DSHHome "C:\Users\elyiz\.dsh-2" -Action disable
powershell -File ciudadano-tts-coordinator/scripts/configure-dsh-plugin.ps1 -DSHHome "C:\Users\elyiz\.dsh" -Action disable

# Detener el coordinador:
# Ctrl+C en la terminal donde corre, o:
Get-Process | Where-Object { $_.CommandLine -like '*ciudadan-tts-coordinator*' } | Stop-Process
```

## Estructura del proyecto

```
ciudadan-tts-coordinator/
├── src/
│   ├── server/index.js          — Servidor HTTP + API + panel
│   ├── queue/manager.js         — Cola global con locks atómicos
│   ├── player/mpv.js            — Reproductor mpv via IPC
│   ├── synthesis/edge.js        — Síntesis edge-tts + cache
│   ├── synthesis/text-processor.js — Markdown semántico
│   ├── sessions/registry.js     — Voces persistentes por sesión
│   ├── multimedia/              — Control volumen + YouTube
│   ├── integrations/claude-code.js — Hook de Claude Code
│   ├── security/token.js        — Auth Bearer
│   ├── configuration/store.js   — Config persistente
│   └── monitoring/              — Logger + health
├── dsh-bridge/                  — Plugin puente para DSH
├── config/default.json          — Configuración por defecto
├── tests/                       — Pruebas automatizadas (23 tests)
├── scripts/                     — Instalación y pruebas
└── docs/                        — Documentación
```

## Pruebas

```bash
node --test tests/                    # 23 tests (cola + texto)
powershell -File scripts/test-coordinator.ps1 -Token <token>  # 9 tests end-to-end
```

## Requisitos

- Windows 11
- Node.js >= 20
- mpv (instalable via `scripts/install-mpv.ps1`)
- edge-tts (ya instalado en el perfil de DSH)
- Token de auth: variable de entorno `CIUDADAN_TTS_TOKEN` o archivo `~/.ciudadan-tts-coordinator/token`

## Licencia

MIT — Uso interno del ecosistema Ciudadan.
