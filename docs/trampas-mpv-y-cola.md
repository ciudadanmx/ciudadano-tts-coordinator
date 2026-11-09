# Trampas del reproductor mpv y del ciclo de vida de la cola

Notas operativas verificadas en producción (Windows 11, mpv v0.41.0).
**Léelas antes de tocar `src/player/mpv.js` o `src/queue/manager.js`.**

## 1. mpv: `end-file` no trae el nombre del archivo

El evento es exactamente:

```json
{"event":"end-file","reason":"eof","playlist_entry_id":17}
```

- **No existe** el campo `file`.
- `playlist_entry_id` **no sirve**: con `loadfile ... replace` se queda en `1` (aquí `17`, pero no correlaciona con el archivo).
- mpv emite un **`end-file` espurio con `reason:"stop"` ~7 ms después de cada `loadfile`** (al reemplazar el archivo anterior). Si se resuelve la promesa con ese evento, la locución se corta.
- `start-file` **nunca** se emite en esta versión.
- La propiedad `eof-reached` **no existe** (`property unavailable`).
- `playback-pos` puede devolver `null` durante la reproducción (no sirve para detectar avance).
- `core-idle` = `true` cuando mpv está ocioso.

**Regla**: solo un `end-file` con `reason === "eof"` cierra la reproducción actual.

## 2. mpv: una reproducción = una promesa, con estado propio

El error que congeló la cola (varios días): `finish()` empezaba con

```js
if (!this._playResolve) return   // ❌ no resolvía la promesa
```

`this._playResolve` es un slot **global**. Si otra reproducción tomaba el slot, `finish()` de la anterior **no resolvía su promesa** → el `await player.play()` del manager quedaba colgado para siempre → `processing` se quedaba en `true` → **la cola se congelaba y nada más sonaba**.

**Regla**: cada `play()` usa un `settled` **propio**:

```js
let settled = false
const finish = () => {
  if (settled) return
  settled = true
  ...limpiar timers...
  origResolve()          // resuelve SIEMPRE su propia promesa
}
```

## 3. mpv: el timeout de seguridad NUNCA debe quedar huérfano

`setTimeout` de seguridad que se creaba al iniciar la reproducción y **no se limpiaba** al terminar: 10 minutos después disparaba y resolvía la reproducción **nueva** a medias (la locución actual quedaba colgada y la cola se congelaba). En el log se veía así:

```
21:19:12 warn Play timeout, forzando resolución  file=7b1923b2...   <- archivo VIEJO
21:19:19 info mpv end-file event ... hasResolve:false               <- la actual ya estaba muerta
```

**Regla**: guardar el timer en `this._playSafetyTimer` y limpiarlo en `finish()`; además, el timer solo actúa si su `finish` sigue siendo el vigente:

```js
this._playSafetyTimer = setTimeout(() => {
  if (this._playResolve !== finish) return  // ❌ este play ya no es el vigente
  finish()
}, safetyMs)
```

## 4. `stop()`: resolver antes de limpiar

```js
const r = this._playResolve
r()                      // primero resuelve (finish es idempotente)
this._playResolve = null // después limpia
```

Poner `null` antes de llamar `finish()` reintroducía el bug del punto 2.

## 5. Cola: el lock se renueva mientras reproduce

El lock del turno (`_acquireLock`) expira a `queue.lockTimeoutMs` (10 min). Con textos muy largos (hasta 50 000 chars) el audio puede durar más → el lock expiraba y la locución se marcaba `error` a mitad.

**Regla**: heartbeat con `setInterval` que actualice `lock.expiresAt` mientras se reproduce (ver `_process` en `src/queue/manager.js`).

## 6. Cola: watchdog + red de seguridad

`await player.play()` está envuelto en un watchdog (`playTimeoutMs`): si no resuelve, se llama `player.stop()` (que resuelve la promesa) y la utterance se marca `error`. **Nunca** debe quedar un `await` sin resolver: `processing = true` bloquea toda la cola.

`_forceReleaseLock()` también llama `player.stop()` para desbloquear cualquier reproducción colgada.

## 7. Persistencia en disco (48 h)

| Archivo | Contenido | TTL |
|---|---|---|
| `~/.ciudadan-tts-coordinator/history.jsonl` | locuciones ya reproducidas (texto + metadatos, **nunca audio**) | 48 h |
| `~/.ciudadan-tts-coordinator/queue.jsonl` | eventos de cola (`queued` / `done` / `error` / `cancelled`) | pendiente = se restaura al arrancar |

Al arrancar, `_loadHistory()` y `_loadQueue()` reconstruyen el estado. Lo que quedó `queued` **vuelve a encolarse** → un reinicio no pierde la cola.

## 8. Rutas y binarios: NO depender del PATH

Los procesos lanzados con `start-coordinator.cmd` pueden no tener el PATH completo:

- `edge-tts` → usar la ruta absoluta en `synthesis.edgeBin`
  (`C:\Users\elyiz\AppData\Roaming\Python\Python313\Scripts\edge-tts.exe`).
  Sin esto: `spawn edge-tts ENOENT` → **toda locución falla**.
- `python` → `C:\Python313\python.exe` (usado por `read-titles.py`).

## 9. Homes DSH migrados a Kompa (2026-11-07)

Los perfiles ya **no** están en `~/.dsh` / `~/.dsh-2`:

```
\\192.168.1.7\Kompa\_dsh_profiles\dsh1
\\192.168.1.7\Kompa\_dsh_profiles\dsh2
```

`read-titles.py` lee de ahí (además de los locales como fallback). El escaneo sobre UNC tarda ~60-90 s, por eso el script **emite el caché inmediatamente** y el resolver consume las líneas al vuelo (`dsh-titles.js`). Títulos conocidos: **"TTS (1)"**, "PRUEBA DEL PUENTE GPT...", etc.

## 10. El panel: nunca escapar comillas dentro de plantillas

El HTML del panel se genera con *template literals* en `src/server/index.js`. Escribir

```js
'<button onclick="saveAppCfg(\'' + appKey + '\')">'
```

produce JavaScript **inválido** en el script servido → **todo el JS del panel muere** y ningún botón responde (ni "Configurar volumen y acciones", ni guardar, ni pausar).

**Regla**: usar `data-attributes` y `this.dataset`:

```js
'<button data-app="' + esc(a.appKey) + '" onclick="saveAppCfg(this.dataset.app)">'
```

### Diseño actual del modal (2026-11-07)

- El botón **⚙️** vive en la barra de controles (junto a ⏮ ANTERIOR / ⏭ SIGUIENTE) y abre `openCfg()`.
- **No hay botón "Guardar" por app**: el modal se guarda con **un solo botón general** (`#cfgSave` → `saveAll()`), que:
  1. hace `POST /api/v1/playback/volume` (volumen de mpv),
  2. hace `PUT /api/v1/multimedia/apps/<key>` por cada app del modal (modo + %),
  3. **cierra el modal solo** (`closeCfg()`) y refresca el panel.
- Las apps del modal se listan en `__cfgApps` (array global) para poder guardarlas
  sin depender de `querySelectorAll` sobre HTML inyectado.
- El estado del modal se declara con `var` (no `let`) para que las funciones del
  script lo vean sin problemas de scope/TDZ.

**Verificación obligatoria tras tocar el panel**:

```powershell
node -e "fetch('http://127.0.0.1:3199/').then(r=>r.text()).then(h=>{require('fs').writeFileSync('C:/Users/elyiz/AppData/Local/Temp/panel-script.js', h.match(/<script>([\s\S]*?)<\/script>/)[1])})"
node --check "$env:TEMP\panel-script.js"   # debe decir "SINTAXIS OK"
```

## 11. Ducking: reglas vigentes (2026-11-07)

### YouTube no tiene volumen propio: su volumen es el de Chrome

El modo `pause` de youtube pausa el contenido vía GSMTC (`paused:1` /
`resumed:1` en el log) y **no** baja el volumen. El modo `reduce` de chrome sí lo
baja, y ese volumen es el que se oye en YouTube.

### Regla: reproducción activa → NO reducir Chrome

Si **Chrome tiene una sesión multimedia en Playing** (GSMTC `media-list` con
`onlyPlaying`, estado `4`), el volumen de Chrome **no se reduce** durante la
locución: el contenido ya se pausa de forma selectiva, así que bajarlo solo
dejaría el audio bajo al reanudar. Si Chrome **no** tiene nada reproduciéndose,
entonces sí se reduce según su % configurado.

```
[youtube] Chrome tiene reproducción activa (se pausa de forma selectiva) — NO se reduce su volumen
[chrome]  Chrome tiene reproducción activa (se pausa de forma selectiva) — NO se reduce su volumen
[spotify] duck Spotify(4828): 100%→70% (original 100%)
```

Implementación: `_hayMediaActivo('chrome')` (caché de 5 s) al inicio de
`_duckAppSessions` en `src/multimedia/controller.js`.

### Bugs corregidos en el ducking

1. **Degradación acumulativa**: el "original" se tomaba del volumen actual de
   cada ciclo, así que si un restore no se aplicaba la cadena era
   100 → 70 → 49 → 34 → 24 → 17 → 12 (sin retorno al 100). Ahora
   `this._originalByPid` conserva el original real y `this._lastDuckedByPid`
   detecta que el restore no se aplicó → se duckea desde el original, no desde
   el valor ya reducido. Verificado: 3 ciclos seguidos 100% → 70% → **100%**.
2. **Doble reducción sobre la misma sesión**: `youtube` y `chrome` apuntan a la
   misma sesión de audio de Chrome; con dos políticas `reduce` se reducía dos
   veces (100 → 20 → 14 %). Ahora `this._duckedThisCycle` garantiza que **una
   sesión de audio solo se reduce una vez** por ciclo.

## 12. UTF-8: cuatro puntos donde se pierden los acentos (2026-11-07)

Síntoma: los títulos de sesión salían como `C?mo configurar Obsidian` y la voz
pronunciaba "interrogante" en vez de "Cómo". **Cuatro fallos encadenados**:

1. **Python → stdout en cp1252**: `read-titles.py` imprimía con la codificación
   de la consola. Fix: `sys.stdout.reconfigure(encoding='utf-8')` al inicio del
   script **y** `PYTHONIOENCODING=utf-8` / `PYTHONUTF8=1` en el `spawn` de Node.
2. **Node decodificaba por chunk**: `d.toString()` sobre cada chunk rompe los
   caracteres multibyte que caen en el borde entre dos chunks → `U+FFFD` (`�`).
   Fix: `new StringDecoder('utf8')` de `node:string_decoder` (mantiene los bytes
   parciales entre chunks) + `decoder.end()` en `close`.
3. **Título recibido con `�`**: si el cliente manda un título ya corrupto, se
   descartaba. Fix en `src/server/index.js`: `tituloLimpio()` descarta cualquier
   título con `U+FFFD` y se prefiere siempre el título real del disco.
4. **edge-tts con `--text`**: el texto iba como argumento de línea de comandos
   (decodificado con la code page del sistema, con límite de ~32k). Fix:
   `src/synthesis/edge.js` escribe el texto en un archivo **UTF-8** y llama a
   `edge-tts --file input.txt`.

**Verificación (no basta con "se ve bien" en la consola de PowerShell)**: la
consola cp437 muestra `?` o `�` por caracteres válidos. Comprobar siempre los
**bytes**: `raw.count(b'\xef\xbf\xbd') == 0` y los bytes UTF-8 de la vocal
(`\xc3\x93` para `Ó`, `\xc3\xb1` para `ñ`).

Los archivos de sesión en disco **están bien**: `session*.jsonl.zstd` contiene
UTF-8 correcto (`"est\xc3\xa1s listo?"`).

**Las filas viejas del historial** que se grabaron con el texto corrupto no se
pueden recuperar (por diseño no se guarda audio); sus **nombres** sí se
resuelven en vivo desde el disco y ya salen correctos.

## 13. Ducking: el volumen NUNCA debe quedarse bajo (2026-11-07)

Síntoma reportado: **YouTube/Chrome se quedó en 8%** y no volvía a 100.

### Causa raíz (3 capas)

1. **El snapshot vivía dentro del estado de la app** (`appStates`), que
   `applyDucking` **reemplaza** en cada ciclo. Si la política pasaba a `reduce 0`
   (o `ignore`), el estado nuevo quedaba **sin snapshot** → el restore ya no
   sabía a qué volumen volver → **el volumen se quedaba bajo para siempre**.
2. **El proceso perdía el "original" al reiniciarse**: arrancaba con el volumen
   ya reducido (70%) y tomaba ese valor como original → `duck 70%→49% (original
   70%)` → nunca volvía a 100.
3. **Orden de arranque**: la cola se restauraba desde disco **en el constructor
   del manager** y empezaba a procesar antes de `multimedia.init()` y
   `player.start()` → `"mpv no está conectado"` y el restore corría **sin bridge**
   (el snapshot se limpiaba sin restaurar nada).

### Fixes aplicados

- **Registro global** `this._pendingRestore` (`pid -> {original, ducked, appKey}`) en
  `src/multimedia/controller.js`: no depende del estado de la app; `restoreVolumes()`
  restaura desde ahí **incluso con `active === false`**.
- **Originales persistidos en disco**: `~/.ciudadan-tts-coordinator/volume-originals.json`.
  Un proceso nuevo sabe cuál era el volumen real antes del ducking y lo restaura
  al arrancar (`_loadOriginals()` + `restoreVolumes()`).
- **Snapshot en disco** incluye la sección `pending` (además de `apps.snapshots`).
- **La cola no arranca hasta que todo está listo**: `queue.start()` se llama en el
  servidor después de `multimedia.init()` y `player.start()`; `_pump()` no hace
  nada mientras `started === false`.
- **Restore ENTRE locuciones** (no solo al vaciar la cola): en el `finally` de
  `_process`, salvo que la siguiente sea **otro fragmento de la misma intervención**.
  Va **encadenado y sin bloquear** (`this._restoreChain`) para no añadir retardo:
  el siguiente `_process` espera a que termine antes de aplicar su ducking.
- **Restore previo** antes de cada `applyDucking` (por si quedó algo pendiente).
- Si el bridge no está listo, `_recoverPendingSnapshot()` **no borra** el snapshot
  (se reintenta después).

### Verificado

```
durante locución 2: Spotify 70%   (duck 30%)
ENTRE locuciones:    Spotify 100%  (restablecido)
--- cambiar la config con el volumen reducido (el bug reportado) ---
durante:              Spotify 70%
>>> config -> reduce 0
después:              Spotify 100%   <-- antes se quedaba en 70 para siempre

--- crash real a mitad de la locución ---
durante:              Spotify 70% | volume-originals.json: {4828: {original:100, ducked:70}}
crash:                Spotify 70%  (nadie restaura)
reinicio:             [recuperación] pid 4828 → 100% (estaba en 70%)
                      Cola iniciada {"pendientes": 1}   <-- mpv ya conectado ✅
al terminar:          [spotify] restaurado pid 4828 → 100%
FINAL:                todas las apps al 100%
```

## 14. Ducking de YouTube: la regla correcta (2026-11-07)

Síntoma: **"no se está bajando el volumen de YouTube"** (con `youtube = reducir 87%`).

### Lo que pasaba

La regla implementada era *"si Chrome tiene reproducción activa → NO se baja su
volumen"* (porque se asumía que el contenido se pausaba). Pero esa regla se
aplicaba **siempre**, incluso con la política **reducir**, donde **no se pausa
nada** → el video se quedaba al 100% y se mezclaba con la locución.

Además, la detección tenía **dos fallos**:

1. **Orden**: `applyDucking` pausaba YouTube (política `pause`) **antes** de
   preguntar "¿hay reproducción activa?" → la respuesta ya era "no" → Chrome se
   bajaba cuando no debía.
2. **El daemon ignora los filtros**: `media-list` con `app`/`onlyPlaying` devuelve
   **todas** las sesiones (no filtra) → el resultado dependía del estado devuelto.
   Además el estado GSMTC tiene **lag**: tras reanudar, la sesión sigue marcada
   como "pausada" un instante → la detección daba falso.

### Regla final (determinista)

| Política de YouTube | ¿Chrome tiene un video? | Volumen de Chrome |
|---|---|---|
| **reducir X%** | sí o no | **siempre baja** a `100 - X` % (el video **no** se pausa) |
| **pausar** | sí (sesión multimedia presente, reproduciendo o pausada) | **no baja** — el contenido se pausa/reanuda selectivamente |
| **pausar** | no | baja según su propia política |
| **ignorar** | — | no baja |

- La medición de "hay video" se hace **ANTES** de aplicar cualquier política
  (`_estadoMediaChrome()`), y se cachea 5 s.
- La caché se invalida al pausar y al reanudar (el estado cambió).

### Verificado (con "Oppenheimer" reproduciéndose en Chrome)

```
CASO A: youtube reducir 87%
  DURANTE:  chrome 13%  (100 - 87)   | el video SIGUE reproduciendo (no se pausa)
  DESPUES:  chrome 100%

CASO B: youtube pausar + chrome reducir 30%
  DURANTE:  chrome 100%  (no baja, el video se pausa)  | spotify 70% (según su config)
  DESPUES:  chrome 100%  | video reanudado
```

## 15. Títulos de sesión: por qué volvían a salir los IDs (2026-11-08)

Síntoma: las locuciones anunciaban **`ed00cf7a`** (y `53be07a5-d84`) en vez del
nombre real de la sesión.

### Causa raíz

`src/sessions/read-titles.py` filtraba los directorios de sesión así:

```python
if not sd.is_dir() or not sd.name.startswith('session-'):   # ← el bug
    continue
```

Las sesiones **nuevas** de DSH usan el **UUID puro** como nombre de directorio
(`sessions/<slug-cwd>/ed00cf7a-b7c1-.../session.v4.jsonl.zstd`), no
`session-<uuid>`. Esas sesiones **quedaban fuera del índice de títulos**, así que
el coordinador no tenía título real y caía al ID.

Además, el plugin `dsh-tts-coordinator-bridge` nunca recibía los metadatos:
`client-inject.js` depende de `window.__DSH_SESSIONS__`, que el cliente **no
expone** → `sessionMeta` quedaba vacío → el bridge usaba su fallback
`sessionId.slice(0, 8)` **como si fuera un título**.

### Fixes (4 capas)

1. **`read-titles.py`**: se acepta **cualquier** directorio que contenga un
   `session*.jsonl.zstd` (ya no se exige el prefijo `session-`).
2. **`dsh-titles.js` → `resolve()`**: normaliza el id (con/sin prefijo
   `session-`, y comparación por UUID) → el cliente y el disco pueden usar
   cualquiera de las dos formas.
3. **`server/index.js`**: `pareceSessionId(t, sessionId)` descarta cualquier
   título que **sea o parezca un identificador** (hex de 8, UUID, forma corta
   `ed00cf7a-b7c1`, prefijo `session-`, o fragmento del sessionId real).
   Si no hay título real se usa un nombre legible: **"Sesión de DSH1"**,
   "Sesión de Dany", etc. — **nunca un ID**.
4. **`dsh-bridge/lib/index.js`**: `getSessionTitle()` ya **no** devuelve el
   sessionId como título; devuelve `''` y el coordinador lo resuelve.

### Verificado

```
índice de títulos:  122  ->  178   (aparecieron las sesiones con UUID puro)
ed00cf7a-b7c1-…     ->  "Perform read-only network/service reacha…"
locución nueva (sessionTitle enviado = "ed00cf7a"):
   sessionName : Perform read-only network/service reacha
   log         : ▶ REPRODUCIENDO {"source":"dsh1","session":"Perform read-only network/service reacha"}
cola: dsh1 → "Read-only diagnostic of the existing…" | dany → "Publia dev" | dsh2 → "# MISIÓN: CIUDADAN MEDIA PLAYER,"
```

## 16. Un solo control para Chrome / YouTube (2026-11-08)

Síntoma: el usuario puso **Chrome en "ignorar"** y el volumen **seguía bajando**.

### Por qué

En Windows **el audio de YouTube sale por la sesión de audio de Chrome**: es el
**mismo proceso** (`chrome.exe`). El panel tenía **dos** controles sobre ese
proceso:

- `youtube` → `processNames: ["chrome"]`
- `chrome` → `processNames: ["chrome"]`

Con `youtube = reducir 87%` y `chrome = ignorar`, la política de YouTube duckeaba
el proceso **Chrome** igualmente: el "ignorar" de Chrome no lo detenía.

### Solución: un control único

Se fusionaron en **una sola entrada `navegador` ("Navegador (Chrome / YouTube)")**:

| Modo | Efecto |
|---|---|
| **Pausar** | pausa el video de YouTube (GSMTC/CDP) y lo reanuda al terminar — **no baja el volumen** |
| **Reducir X%** | baja el volumen de Chrome (y por tanto el de YouTube) a `100 − X`% |
| **Ignorar** | no se toca nada |

- `getAppPolicies()` fusiona las claves legacy `youtube` + `chrome` → `navegador`;
  `"reduce 0%"` se normaliza a `"ignorar"`; si una de las dos estaba activa
  (pausar/reducir con % > 0) gana esa.
- La migración se **persiste** al arrancar (`persistMigration()` + `saveConfig`),
  así la config y el panel quedan con una sola fila.
- La API acepta `youtube`/`chrome` como alias de `navegador` (compatibilidad).
- Defensa extra: una app en **ignorar** bloquea su proceso para *todas* las
  políticas (`_procesosIgnorados` / `_esIgnorada`).
- El panel avisa si dos apps comparten proceso y una está en ignorar (`conflicts`).

### Verificado (con video reproduciéndose en Chrome)

```
CASO 1 - PAUSAR:    chrome 100% | Chrome status 4 → 5 (pausado) → 4 (reanudado)
CASO 2 - REDUCIR 87: chrome 13%  | el video sigue reproduciéndose (4) → chrome 100% al final
CASO 3 - IGNORAR:    chrome 100% | el video no se toca (4)
Spotify (su propia config, reducir 30): 70% durante → 100% entre locuciones
```

## 18. El video se quedaba pausado durante toda la cola (2026-11-08)

Síntoma: con el control en modo **Pausar**, el video de YouTube se quedaba pausado
durante toda la cola. Antes se reanudaba entre una locución y otra.

### Causas (4)

1. **Entre fragmentos de la misma intervención no se restauraba nada.** El diseño
   anterior omitía el restore por completo entre fragmentos (para no encadenar
   reducciones de volumen) → el video quedaba pausado durante toda la respuesta.
   **Fix:** `restoreVolumes({ soloPausa: true })` → entre fragmentos se **reanuda el
   contenido pausado** pero el volumen **se mantiene reducido** (sin picos de audio).
2. **Si el video ya estaba pausado por nosotros**, la nueva pausa captura 0 sesiones
   (`onlyPlaying` + ya pausado) → la condición de reanudación no se cumplía → nunca
   se reanudaba. **Fix:** registro persistido `paused-media.json` + reanudar por
   título (`resumeByTitles`) con fallback.
3. **Si el proceso moría con el video pausado**, al reiniciar quedaba pausado para
   siempre (el estado de pausa no sobrevivía). **Fix:** `_savePausedMedia()` +
   `_recoverPausedMedia()` en el arranque → reanuda lo que quedó pendiente.
4. **Títulos con caracteres especiales no coincidían al reanudar**: el daemon leía
   stdin con cp1252 → el `—` de "título — artista" se corrompía. **Fix:** UTF-8
   forzado en `audio-session.py` (stdin/stdout/stderr).

Extra: `resumeYouTube()` miraba `config.multimedia.youtube.resumeAutomatically`
(clave que ya no existe tras la fusión) → si faltaba, la reanudación se desactivaba
en silencio. **Fix:** mira `navegador` y por defecto reanuda (`?? true`).

### Verificado

```
3 fragmentos de la MISMA intervención:
  chrome=5 (pausado) -> chrome=4 (SONANDO) -> chrome=5 (pausado) -> chrome=4 (SONANDO)
Crash real (servidor muerto con el video pausado) -> al reiniciar:
  chrome=SONANDO (4) | paused-media.json eliminado | todas las apps al 100%
```

## 19. El arranque NO puede tumbar el servicio (2026-11-09)

**Síntoma**: Claude Code (free-claude-code-windows) ejecutó
`scripts\start-coordinator.cmd` desde su propio turno y el servicio quedó
inestable: lo lanzó **dos veces a la vez** (dos shells de Claude en paralelo) →
dos procesos `node src\server\index.js` compitiendo por el puerto 3199.

**Causa**: `start-coordinator.cmd` arrancaba el servidor **sin comprobar** si ya
había uno vivo. El segundo proceso chocaba con `EADDRINUSE` (después de haber
aplicado la migración de configuración multimedia) y el servicio quedaba en mal
estado.

**Arreglo aplicado** — `scripts/start-coordinator.cmd` es ahora **idempotente y
seguro**:

1. Si `/api/v1/health` responde 200 → **no hace nada** (no reinicia, no mata).
2. Si el puerto 3199 está ocupado por otro proceso → **no se toca nada**.
3. Solo arranca cuando el puerto está libre.

Consecuencia: cualquier cliente (Claude Code, DSH, scripts de arranque) puede
invocar el script sin riesgo de derribar el servicio.
Verificado: 3 invocaciones consecutivas → mismo PID y `uptime` sin reinicio.

**Relación con Claude**: `src/integrations/claude-code.js` es **solo cliente**
del contrato HTTP (`POST /api/v1/speech`): no sintetiza, no reproduce, no
reinicia y no mata procesos del coordinador. El hook está registrado en
`C:\Users\elyiz\.claude\settings.json` (evento `Stop`), entrega en ~2,5 s
(worker desacoplado en segundo plano, para no bloquear a Claude) y envía
`source: 'claude-orch'`, que el registro de fuentes resuelve **por alias** a la
fuente canónica `claude` (voz `es-AR-TomasNeural`, silenciable desde el panel).

## 20. Checklist antes de dar por terminado

1. `node --check` de todos los `.js` modificados + `python -m py_compile` de los `.py`.
2. Copiar al runtime: `%TEMP%\ciudadan-tts-coordinator\`.
3. **Matar TODOS** los procesos `server[\\/]index\.js` y arrancar **uno solo** (un proceso viejo sirve código viejo en silencio).
4. Verificar `uptime` de `/api/v1/health` < 60 s (confirma que es el proceso nuevo).
5. Ráfaga de 3-10 locuciones → todas `done`, duraciones completas, **0 cortes**.
6. Revisar el log: 0 errores, 0 `Play timeout`, 0 `Lock timeout`.
7. Panel: `node --check` del script servido + `Ctrl+F5` en el navegador.

## 21. "La música no baja" y "la voz se oye bajita" (2026-11-09)

Cuatro fallos encadenados, todos verificados en vivo. **Léelos antes de tocar
`src/multimedia/*` o `src/synthesis/edge.js`.**

### 21.1 `reduce 0%` NO es "ignorar": se persistía como `reduce`

Un test interrumpido dejó `navegador: {mode:'reduce', percentage:0}` en la
config del usuario. Con ese valor la app quedaba **bloqueada por el modo
ignorar** (el proceso entero queda excluido) y el panel la mostraba como
"reducir 0%" aunque no reducía nada. Ahora:

- `PUT /api/v1/multimedia/apps/:appKey` normaliza `reduce` + `0%` → `ignore`.
- `getAppPolicies()` normaliza también las entradas heredadas (no solo las
  claves legacy `youtube`/`chrome`).
- **Los tests que tocan la multimedia deben restaurar la config en un
  `finally`** (`scripts/test-control-unico.py`): si el test se corta a mitad,
  la política del usuario queda a medias y el navegador deja de pausarse.

### 21.2 La pausa solo cubría YouTube: el fallback GSMTC no se disparaba

`pauseYouTube(matchUrl)` hace fallback a GSMTC **solo si CDP lanza una
excepción**. Si CDP funciona pero ninguna pestaña coincide con `youtube.com`
(el caso real: el usuario estaba viendo TikTok), devolvía `paused: 0` y **no
pausaba nada**: la música seguía al 100% y la voz se oía tapada.

Ahora `pauseBrowser(matchUrl)`:
1. intenta el matchUrl exacto por CDP (preciso para YouTube);
2. si no hubo coincidencia → pausa por GSMTC la sesión multimedia **activa**
   del navegador (sea TikTok o lo que sea).

### 21.3 El ciclo continuo (mismo TTS) se restauraba entre fragmentos

El requisito es: **entre fragmentos de la misma intervención no se restaura**
ni el volumen ni la pausa. Se cumplía a medias:

- `_process` hacía un `restoreVolumes()` **completo** al inicio de cada
  locución → el video se reanudaba y la música volvía a 100% entre fragmentos.
- `restoreVolumes({soloPausa:true})` **reanudaba el video pausado** (el
  `soloPausa` solo excluía los volúmenes).

Ahora:
- el `_process` detecta `interventionId`连续 (`_lastInterventionId`) y, si es
  otro fragmento del mismo TTS, **no restaura y no re-aplica** el ducking;
- `restoreVolumes({soloPausa:true})` es un **no-op real**: no toca volúmenes,
  no reanuda el video y mantiene `active`/`appStates` (el panel sigue
  reflejando el ducking activo).

Verificado: durante toda la locución el navegador queda en estado `5`
(pausado) y la música al 70%; al terminar ambos vuelven a `4` y `100`.

### 21.4 `edge-tts.exe` es un wrapper: se colgaba y bloqueaba la cola

`edge-tts.exe` (pip) lanza `python.exe` como hijo. Si el hijo se queda
colgado, **el wrapper nunca cierra** → el `close` no llega → la locución se
queda en `synthesizing` y, con `maxAttempts: 3`, la cola se quedaba **más de
3 minutos** sin avanzar (el usuario lo oía como "la voz baja" o directamente
como silencio).

Síntomas: item en `synthesizing` con `ageMs > 180000`, `lock` viejo, procesos
`edge-tts.exe` + `python.exe -` vivos.

Solución aplicada:
- se usa el **módulo directamente**: `python -m edge_tts` (config
  `synthesis.edgePython`) → el proceso controlado es el real y su command
  line (`-m edge_tts`) permite identificar y limpiar huérfanos;
- timeout de síntesis a 30 s y `maxAttempts: 2` (peor caso ~62 s, no 3 min);
- al vencer el timeout, **si el MP3 ya está escrito y es utilizable se USA**
  (antes se borraba la carpeta temporal y se perdía la locución entera);
- `_killTree()` usa `taskkill /PID /T /F` para matar el árbol, no solo el
  padre;
- `cleanupOrphans()` al arrancar limpia sintesis colgadas (en Windows 11
  **ya no existe `wmic`**: se usa PowerShell + `Get-CimInstance`, filtrando
  por `-m edge_tts` o `ciudadan-edge-`).

### 21.5 El registro de contenido pausado se borraba sin reanudar

`_recoverPausedMedia()` borraba `paused-media.json` aunque `resumeByTitles()`
no hubiera reanudado nada. Resultado: el video quedaba **pausado para
siempre** y, sin registro, tampoco se podía recuperar en los reinicios
siguientes. Ahora el registro **solo se borra si se reanudó de verdad**.

### 21.6 Nivel de audio: el loudnorm sí funciona (medido)

Medido con `ffmpeg` sobre un MP3 real de la cola:

| etapa | LUFS integrated | True peak |
|---|---|---|
| MP3 de edge-tts (origen) | **-19.8** | -5.7 dBFS |
| con `loudnorm=I=-14:TP=-1.5:LRA=11` | **-14.3** | -1.5 dBFS |
| primeros 2 s con loudnorm | **-13.8** | -1.5 dBFS |

Conclusión: el filtro normaliza correctamente desde el inicio; **el volumen
"bajito" era la música a 100% por encima** (no se pausaba por 21.2). Aun así
se añadió `linear=true` al filtro de mpv para que el gain se aplique sin
esperar la medición, y el volumen interno de mpv (135) **no se toca**: es del
usuario.

### 21.7 CDP no está disponible en este Chrome

El log muestra `CDP no disponible ... fetch failed`: este Chrome no expone el
puerto de depuración remoto, así que la pausa **siempre** va por GSMTC. No es
un fallo: GSMTC pausa y reanuda correctamente. No abrir un puerto de
depuración en el Chrome del usuario solo para esto.

