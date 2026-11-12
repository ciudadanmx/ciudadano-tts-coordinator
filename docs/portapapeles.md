# Lectura automática del portapapeles (Sprint 1)

El coordinador TTS lee en voz alta lo que copias en Windows, usando el servicio
existente en `http://127.0.0.1:3199`. **No hay otro motor, cola ni servicio**:
el portapapeles es una **fuente más** (`clipboard`) dentro de la cola central.

## Arquitectura (núcleo independiente de Windows)

```
Sesión interactiva de Windows
  └─ scripts/clipboard-watcher.ps1   ← ÚNICO componente con Win32
       AddClipboardFormatListener + WM_CLIPBOARDUPDATE   (evento nativo, sin polling)
       RegisterHotKey(Ctrl+Alt+R)                        (atajo global)
                │  HTTP (127.0.0.1:3199, Bearer del token local)
                ▼
  Coordinador TTS (Node, multiplataforma, sin Win32)
       src/clipboard/service.js  (estado, validación, privacidad)
       POST /api/v1/speech  con source='clipboard'  → cola central → mpv
```

El watcher **no lee el portapapeles por sondeo**: reacciona al evento nativo
`WM_CLIPBOARDUPDATE`. El texto se lee con `OpenClipboard`+`GetClipboardData`
(solo lectura; **nunca** se modifica ni se limpia el portapapeles) y se envía
al coordinador por HTTP, igual que los DSH.

## Cómo se activa

1. En el panel (`http://127.0.0.1:3199/`, **Ctrl+F5** para ver los cambios) hay
   la tarjeta **📋 Portapapeles de Windows** con el interruptor
   **«Leer portapapeles»**. Al activarlo aparece la advertencia de privacidad.
   También se puede activar desde la tabla de fuentes marcando la fila
   **Portapapeles**.
2. Con el **atajo global `Ctrl+Alt+R`** (funciona aunque el navegador no tenga
   el foco). Si el atajo ya está reservado por otra app, el panel lo muestra en
   rojo y no interfiere con esa app.

La captura **nace desactivada** y no se activa sola al reiniciar, salvo que el
usuario la haya activado antes (el estado se guarda en `sources.json`).

El watcher arranca solo al iniciar sesión (clave `Run` de HKCU,
`CiudadanClipboardWatcher`; ver `scripts/instalar-clipboard-watcher.ps1`).
Para lanzarlo a mano: `scripts/start-clipboard-watcher.ps1`.

## Comportamiento

- Copiar texto → se encola con la voz elegida para la fuente `clipboard`
  (seleccionable en el panel como cualquier fuente).
- Copiar otro texto → **reemplaza solo** la lectura anterior del portapapeles
  (`reemplazadas: N` en el log). No toca alertas ni locuciones de otros agentes.
- **Copiar exactamente lo mismo que la copia anterior NO se vuelve a leer**
  (no se agrega a la cola). La comparación es por **hash SHA-256** del texto:
  el contenido no se guarda, solo su huella. La respuesta de la API lo dice:
  `{"ok":true,"skipped":true,"reason":"duplicate"}`, y el estado lleva
  `duplicateCount`.
- Se respetan las prioridades de la cola central (convive con DSH1/DSH2/Dany/Claude).
- Un mismo evento no se procesa dos veces (se deduplica por el número de
  secuencia del portapapeles). Nota: la deduplicación por *contenido* es
  distinta de la del evento — copiar el mismo texto en un evento nuevo ya
  **no** se vuelve a leer (comportamiento pedido explícitamente).
- Imágenes, archivos y formatos sin texto se ignoran.
- Textos muy largos se recortan a `clipboard.maxChars` (por defecto **2000**,
  configurable en `config.json`).
- El portapapeles **no se modifica ni se limpia**.

## Privacidad

- El texto del portapapeles **no se escribe en ningún log** (solo su longitud).
- Las locuciones del portapapeles son **efímeras**: no van al historial
  persistente (`history.jsonl`) ni a la API de historial.
- El texto solo viaja al sintetizador TTS local configurado.
- Al activar la función aparece una advertencia discreta y se puede desactivar
  al instante con `Ctrl+Alt+R`.

## Endpoints

| Método | Ruta | Uso |
|---|---|---|
| GET | `/api/v1/clipboard/status` | estado: enabled, hotkey, watcher, maxChars |
| POST | `/api/v1/clipboard/enabled` | `{enabled:true|false}` (interruptor del panel) |
| POST | `/api/v1/clipboard/toggle` | alterna (lo usa el atajo global) |
| POST | `/api/v1/clipboard/watcher-status` | el watcher reporta su estado |
| POST | `/api/v1/speech` | `{text, source:'clipboard', sessionId:'clipboard'}` (lo usa el watcher) |

## Pruebas realizadas (11/11/2026)

- Copia real desde PowerShell (evento `WM_CLIPBOARDUPDATE` real): encola y
  **suena** (`▶ REPRODUCIENDO {source:"clipboard"}`).
- Copia rápida sucesiva: solo queda 1 locución clipboard activa (reemplazo).
- Historial: 0 entradas de clipboard (efímeras).
- Imagen en el portapapeles: ignorada.
- Texto de 4200 caracteres: recortado a 2000.
- `Ctrl+Alt+R` (simulado con `keybd_event`): alterna enabled (True→False→...).
- Captura desactivada: copiar no produce lectura.
- Convivencia: DSH1/DSH2 siguen sonando con normalidad durante las pruebas.
- El atajo quedó registrado (`hotkeyRegistered:true`); si otra app lo tuviera,
  se reportaría en el panel sin interferir.

## Pruebas del 12/11/2026 (dedup por contenido)

- 1ª copia de un texto → encolado (`HTTP 202`, `queuePosition`).
- 2ª copia **idéntica** → `HTTP 202 {"ok":true,"skipped":true,"reason":"duplicate"}`
  y **no** aparece ningún item nuevo en la cola (1 item antes y 1 después).
- `/api/v1/clipboard/status` → `readCount:1`, `duplicateCount:1`.
- El texto nunca aparece en logs ni en el estado (solo longitud y hash interno).

## Trampas encontradas (ver también historia-de-errores.md #22)

1. **Ventana "message-only" (HWND_MESSAGE) no recibe WM_CLIPBOARDUPDATE** de
   forma fiable → se usa una ventana top-level oculta (`WS_EX_TOOLWINDOW`).
2. **El hilo de C# no puede llamar scriptblocks de PowerShell** (no es seguro
   entre hilos) → el watcher encola eventos en una `ConcurrentQueue` y el hilo
   principal de PowerShell los procesa.
3. **`GetClipboardData` sin `OpenClipboard` devolvía NULL** → se abre el
   portapapeles solo para leer y se cierra enseguida (nunca se altera).
4. `Add-Type` compila con **C# 5**: nada de `out var`, `const IntPtr`, etc.
5. El script vive en UNC y `powershell.exe -File` **rechaza rutas UNC** →
   se copia a `%TEMP%` con hash (igual que el daemon SAPI).
6. El filtro de procesos del starter se confundía consigo mismo
   (`start-clipboard-watcher.ps1`) → solo cuenta `clipboard-watcher-<hash>.ps1`.
