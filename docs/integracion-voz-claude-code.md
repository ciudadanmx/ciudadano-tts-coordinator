# Integración de voz (TTS) para Claude Code — informe de entrega

Fecha: 2026-11-09
Alcance: Claude Code como **cliente adicional** del `ciudadan-tts-coordinator` compartido.
Restricción arquitectónica respetada: **tres clientes (DSH1, DSH2, Dany), un solo servicio TTS**.
Claude Code **no** instala, implementa ni ejecuta síntesis o reproducción de voz propias.

---

## 1. Componentes existentes reutilizados

| Componente | Ubicación | Uso |
|---|---|---|
| `ciudadan-tts-coordinator` | `K:\agente2ciudadanmex\ciudadan-tts-coordinator` (despliegue: `%TEMP%\ciudadan-tts-coordinator`) | Servicio central: síntesis Edge Neural, mpv, cola global, registro de voces |
| Puente DSH | `src/dsh-bridge/` | Referencia del contrato `POST /api/v1/speech` (mismo cuerpo, mismos fragmentos) |
| Preprocesador de texto | `src/synthesis/text-processor.js` | `markdownToSpeech` + `chunkForSpeech` reutilizados por el adaptador |
| Token del coordinador | `~/.ciudadan-tts-coordinator/token` | Autenticación Bearer |
| `openai-whisper` (base) + `ffmpeg` | Ya instalados en la máquina | STT (sin instalar motores nuevos) |

## 2. Archivos creados

| Archivo | Descripción |
|---|---|
| `src/integrations/claude-code.js` | Adaptador/hook `Stop` + CLI de control (336 líneas). Worker desacoplado: no bloquea a Claude. |
| `src/integrations/claude-orch-common.js` | Contrato HTTP, tokens, preprocesado, deduplicación, `ensureVoice`. |
| `C:\Users\elyiz\.ciudadan-stt\*` | Adaptador STT independiente (daemon Node, motor Python, ayudante de portapapeles/pegado, atajo AHK, `config.json`, `README.md`). **Hoy apagado.** |
| `K:\free-claude-code-windows\home\.claude\skills\ciudadan-tts\SKILL.md` | Skill de uso del TTS (copia idéntica en `C:\Users\elyiz\.claude\skills\ciudadan-tts\SKILL.md`). |

## 3. Archivos modificados

| Archivo | Cambio | Backup |
|---|---|---|
| `src/integrations/claude-orch-common.js` | `coordinatorTokens()` + reintento en 401 (el token del servicio puede vivir bajo otro perfil) | Git/red de origen |
| `K:\free-claude-code-windows\home\.claude\settings.json` | Añadido hook `Stop` del TTS, **conservando** `permissions`, `model`, `theme`, `skipDangerousModePermissionPrompt` | `settings.json.bak-20261109-133341` |
| `C:\Users\elyiz\.claude\settings.json` | Ya contenía el hook `Stop`; sin cambios de contenido | `settings.json.bak-voice` |
| `C:\Users\elyiz\.ciudadan-stt\config.json` | Micrófono alternado durante una prueba y **restaurado** a `Micrófono (Realtek High Definition Audio)` | `config.json.bak` (restaurado) |

**No se tocó**: DSH1 (:3080), DSH2 (:3081), DSH de Dany, Cline Hub, GameView, Agent Monitor,
orquestador de tareas, configuración de FCC ni proveedor de Claude. El coordinador TTS
**no se reinició ni reconfiguró**: se consumió como cliente (PID 197012, uptime continuo).

## 4. Endpoints y contratos verificados

Autenticación: `Authorization: Bearer <token>`; sólo `GET /api/v1/health` es público.

| Endpoint | Verificado |
|---|---|
| `GET /api/v1/health` | `{"ok":true,"service":"ciudadan-tts-coordinator","status":"healthy","player":"ready"}` |
| `POST /api/v1/speech` | 202 encolado; cuerpo `{source, sessionId, sessionTitle, taskTitle, voice, text, priority, interventionId, fragmentIndex, totalFragments}` |
| `GET /api/v1/queue` | `items[]` + `status{speaking,current,queueLength,lock,player}` |
| `GET /api/v1/history` | `items[]` con `status`, `playStatus`, `durationMs`, `error`, `voice`, `source` |
| `GET /api/v1/voices` | `catalog` + `assignments` (asignación persistida por sesión) |
| `PUT /api/v1/sessions/:sessionId/voice` | Asigna y persiste la voz de la sesión |
| `DELETE /api/v1/queue/:requestId` | Cancela **una** locución (por fuente) |
| `DELETE /api/v1/sessions/:sessionId/queue` | Cancela la cola de una sesión |
| `POST /api/v1/playback/pause\|resume\|stop\|skip`, `volume` | **Globales**: afectan a DSH1/DSH2/Dany. Sólo con petición expresa del usuario |

## 5. Voz asignada a Claude

- `source` registrado: **`claude-orch`**
- Voz: **`es-AR-TomasNeural`** (es-AR, español)
- Asignación persistente en el registro del coordinador: clave `claude-code` → `es-AR-TomasNeural`;
  `ensureVoice(sessionId)` la reasigna y persiste para cada sesión nueva de Claude en su primer `Stop`.
- `body.voice` en cada envío fuerza la voz de Tomás aunque el registro tuviera otro valor por defecto.

## 6. Resultados TTS y STT (por separado)

### 6.1 TTS — operativo como cliente

Adaptador: hook oficial `Stop` (payload `last_assistant_message`, `session_id`, `transcript_path`,
`stop_hook_active`). El texto se limpia de código/tablas, se fragmenta a 320 caracteres y se encola
en orden; el trabajo corre en un worker desacoplado (no bloquea Claude). Anti-duplicado: una locución
por turno (ventana 5 min). El texto locutado es contenido, nunca instrucciones.

### 6.2 STT — construido, probado y **cerrado** (no en uso)

Adaptador independiente en `C:\Users\elyiz\.ciudadan-stt`: `ffmpeg` (dshow) + `openai-whisper` base,
`es`, sin instalar motores. Inserción del texto transcrito en la línea de entrada **sin pulsar Enter**
(`auto_send: false`), para que el usuario lo revise y edite. Atajo `Alt + Shift + M` (no usa Ctrl)
y control por API sin atajo. Micrófonos de DSH1/DSH2 independientes: sólo micrófono local.
**Estado: daemon y AHK detenidos, puerto 3207 cerrado, sin autoinicio.** Se conserva el código y el
`README.md` con el procedimiento de encendido/apagado.

## 7. Pruebas con evidencia de ejecución real

| # | Prueba | Resultado | Evidencia |
|---|---|---|---|
| A | Respuesta corta de Claude reproducida por Tomás | **Superada** | `history`: `source=claude-orch`, `voice=es-AR-TomasNeural`, `status=done`, `playStatus=done`, `durationMs=8514`, `error=null` |
| B | Respuesta larga y respeto de la cola | **Superada** | `say` de texto largo → `{"ok":true,"fragments":6}`; 6 items `queued` con `fragmentIndex 0..5` y `totalFragments=6`; uno cancelado por `DELETE` (200) sin afectar a los demás |
| C | Claude y DSH2 locutan sin interferir | **Superada** | Cola global compartida con `dsh1`, `dsh2`, `dany-oracle` y `claude-orch` entrelazados; todos `status=done`, `error=null`; `queueLength` compartido sin bloqueos |
| D | El dictado en español aparece en la entrada de Claude | **Parcial (no superada)** | Transcripción real OK: whisper sobre audio español real → *«Verificado volúmenes nuevos con la K-9A…»* (42 s con carga de modelo). Inserción en ventana CASCADIA probada: log del daemon `OK 1 class=CASCADIA_HOSTING_WINDOW_CLASS via=WM_PASTE` (mismo mecanismo del marcador `PRUEBA_STT_UNO_DOS_TRES` que llegó al chat). **La vuelta completa mic→whisper→pegado en una sesión real no se cerró**: la captura por "Mezcla estéreo" no llegó a completarse y el STT quedó apagado por indicación del usuario. **No se marca como superada.** |
| E | Interrumpir una reproducción sin afectar a otros agentes | **Superada** | `DELETE /api/v1/queue/<requestId>` → `{"ok":true}`; el item cancelado desaparece de la cola; los 12 items de otras fuentes intactos |
| F | Persistencia de la configuración sin reiniciar la sesión activa | **Superada con nota** | `assignments` incluye `claude-code` → `es-AR-TomasNeural` y `ensureVoice` la persiste; `settings.json` (HOME remapeado y perfil real) contiene el hook `Stop` y **conserva** el resto de la configuración; el servicio no se reinició |

## 8. Limitaciones y bloqueos reales

1. **El hook exige un arranque nuevo de Claude Code.** Los hooks se leen al inicio de la sesión;
   la sesión activa no se reinició (prohibido). La voz automática de Claude empezará en el próximo
   arranque, sin tocar nada más.
2. **El `HOME` de esta máquina está remapeado** a `K:\free-claude-code-windows\home`, mientras que
   `C:\Users\elyiz\.claude\settings.json` es el perfil del SO. El hook se registró **en ambos** para que
   funcione con cualquiera de los dos perfis.
3. **`edge-tts` depende del PATH del proceso que arranca el coordinador.** Si el servicio se levanta
   sin `C:\Users\elyiz\AppData\Roaming\Python\Python313\Scripts` en el PATH, la síntesis falla con
   `spawn edge-tts ENOENT` (los items entran en cola pero con `error`). Cuando DSH2 levantó el servicio
   con su PATH, la síntesis funcionó (`status=done`). **No se corrigió**: es configuración del servicio.
4. **Servidor MCP `ciudadanos_knowledge` desconectado** en esta sesión (fallo de conexión, no de
   configuración). Requiere reconexión manual del usuario.
5. **STT sin ciclo completo verificado** (ver prueba D). El pegado y la transcripción están probados
   por separado; la unión mic→texto→pegado en sesión real queda pendiente si se retoma.
6. **`pause/stop/skip/volume` son globales**: interrumpen la voz de DSH1/DSH2/Dany. Sólo se usaron
   cancelaciones por fuente.

### Incidentes propios que deben quedar registrados

- En una sesión anterior se ejecutó un `taskkill /F /IM node.exe` que tumbó DSH1, DSH2, el coordinador
  y el servidor MCP. DSH1/DSH2/coordinador se restauraron (3080/3081/3199 contestan; el coordinador
  lleva PID 197012 desde las 13:36 sin reinicios de mi parte). El MCP sigue desconectado.
- Un script de diagnóstico pegó y **envió** el marcador `PRUEBA_STT_UNO_DOS_TRES` en la terminal viva
  de Claude Code. Fue un error mío; el portapapeles/`WM_PASTE` quedó Validado como mecanismo real.

## 9. Procedimiento de rollback

1. **Quitar la voz automática de Claude**: borrar el bloque `hooks.Stop` de
   `K:\free-claude-code-windows\home\.claude\settings.json` y de `C:\Users\elyiz\.claude\settings.json`
   (o restaurar `settings.json.bak-20261109-133341` y `settings.json.bak-voice`). Sin reiniciar el servicio.
2. **Quitar la skill**: borrar `~/.claude/skills/ciudadan-tts/` (ambos perfiles). Visible tras el próximo arranque.
3. **Quitar el adaptador**: eliminar `src/integrations/claude-code.js` y `src/integrations/claude-orch-common.js`
   del share `K:\agente2ciudadanmex\ciudadan-tts-coordinator` (y del despliegue en `%TEMP%` si se copió).
4. **Dejar la asignación de voz**: es inocua (`PUT /api/v1/sessions/:id/voice`); si se quiere,
   `DELETE` no existe para asignaciones, se reasigna la voz desde `PUT` con la voz por defecto.
5. **STT**: está apagado; para borrarlo del todo, eliminar `C:\Users\elyiz\.ciudadan-stt`.
   Nada de esto afecta al coordinador TTS ni a DSH1/DSH2.

## 10. Cómo usar el TTS (resumen operativo)

Skill: `ciudadan-tts` (carga en el próximo arranque de Claude Code).

```powershell
Set-Location 'K:\agente2ciudadanmex\ciudadan-tts-coordinator\src\integrations'
node claude-code.js status              # estado del coordinador + cola de Claude
node claude-code.js say "texto a decir" # encola con la voz de Tomás
node claude-code.js cancel <requestId>  # cancela SOLO una locución de Claude
node claude-code.js cancel-session <sessionId>
node claude-code.js volume              # volumen (global)
node claude-code.js pause|resume|stop|skip   # GLOBALES: sólo si lo pide el usuario
```

Verificación de que algo sonó de verdad: `GET /api/v1/history` → el item debe tener
`status: "done"`, `playStatus: "done"` y `error: null`. `queued` sólo significa encolado.
