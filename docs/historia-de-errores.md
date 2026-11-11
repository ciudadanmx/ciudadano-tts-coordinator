# Historia de errores del coordinador de voz

Registro de los fallos reales que han aparecido en `ciudadan-tts-coordinator`,
**qué se veía**, **cuál fue la causa raíz** y **cómo se comprobó que quedó
arreglado**. Cada entrada tiene evidencia medible, no suposiciones.

Cuando algo vuelva a fallar, busca aquí primero: casi todos estos errores
volvieron por una vía distinta (por ejemplo, el watchdog reponía una condición
que el código ya había corregido).

---

## 1. La voz se escuchaba entrecortada (y a veces no se oía nada)

**Síntoma.** La locución empezaba y se cortaba a mitad; en otros casos había
silencio de varios minutos y la frase se perdía.

**Causa raíz (medida, no supuesta).** `edge-tts` depende del servicio de voz de
Microsoft por internet. El 10/11/2026 se midió en este equipo:

| Prueba | Resultado |
|---|---|
| edge-tts directo (texto de 154 car.) | **122.9 s → colgado, 0 bytes escritos** |
| edge-tts directo (segunda) | **121.0 s → colgado, 0 bytes escritos** |
| edge-tts directo (tercera) | 87.7 s → correcto (antes tardaba 23-39 s) |

Con el timeout de 90 s y 3 intentos, una locución agotaba **270 s de silencio**
antes de rendirse: de ahí el "corte". Y como el fallo se daba en un fragmento
suelto, los fragmentos siguientes sonaban antes que el fallido → **texto
desordenado y entrecortado**.

**Causa raíz secundaria (grave).** El watchdog mataba el coordinator **a los
25 s de cada arranque**. Con el runtime movido a Kompa el arranque tarda 30-60 s
(lee el código por la red), así que el watchdog mataba al servicio *sano* y lo
relanzaba: un bucle de ~2 min que además tumbaba el daemon de pycaw en cada
vuelta y dejaba el ducking en modo *stub*.

**Arreglo.**

1. **CARRERA de sintetizadores** (`src/synthesis/edge.js`): si `edge-tts` no
   contesta en `fallbackAfterMs` (35 s), entra la **voz local de Windows**
   (`System.Speech`, sin internet) y **gana la que termine primero**. Si
   `edge-tts` falla outright, el local tiene su oportunidad igualmente.
2. **Respaldo local con daemon persistente** (`src/synthesis/windows-sapi.js` +
   `scripts/sapi-voice.ps1`): la voz de Windows se carga una vez (~15 s en frío,
   **<1 s en caliente**) y después responde al instante. Se arranca en
   *warmup* al iniciar el servidor (`synthesizer.warmup()`), así que la primera
   locución ya lo tiene listo.
3. **Watchdog sin matanzas** (`scripts/coordinator-watchdog.ps1`): si hay una
   instancia viva, se **espera** a que termine de arrancar (hasta 3 min); solo
   arranca una nueva si no hay ninguna.

**Cómo se comprobó.**

- Medición directa de `edge-tts`: 2 de 3 pruebas colgadas (ver tabla).
- Carrera en producción: `Locucion servida con la voz local de respaldo
  {"bytes":546550}` y `mpv CMD enviado {"command":"loadfile","value":"...wav"}`
  → la voz local se reproduce de verdad.
- Watchdog: 3 min de vigilancia, **0 líneas nuevas** en su log, mismo PID,
  health 200 en los 6 muestreos.

---

## 2. La configuración del navegador se volvía a "pausar" sola

**Síntoma.** El usuario elegía "bajar volumen" para el navegador, el cambio se
aplicaba... y a los pocos minutos volvía a "pausar".

**Causa raíz.** `config/default.json` todavía traía las claves **viejas**
`multimedia.applications.youtube` (modo `pause`) y `.chrome` (modo `reduce`).
Al arrancar, `deepMerge(defaults, usuario)` las reintroducía en memoria y la
migración al control único `navegador` las fusionaba. Como `youtube` era modo
`pause`, **ganaba la fusión y pisaba la elección del usuario**. Cada reinicio
(que, por el error nº1, era cada ~2 min) devolvía el valor.

**Arreglo.**

1. `config/default.json` sin claves legacy: solo `navegador`, `spotify`, `vlc`.
2. `_fusionarNavegador()`: **si `navegador` ya existe, su valor manda**; las
   legacy solo se usan si el usuario nunca eligió nada. La migración sigue
   limpiando las legacy, pero ya no destruye la decisión vigente.

**Cómo se comprobó.** La prueba del reverso: `PUT reduce 40%` → el archivo pasa
a `reduce 40` → **reinicio forzado** → el archivo **sigue** en `reduce 40`
(antes volvía a `pause 0`). Y en producción se vio el ducking real:
`[navegador] duck chrome(23120): 22%→13%` → 40 % de reducción efectiva.

---

## 3. Dany no se escuchaba (se oía entrecortado y se perdía)

**Síntoma.** Las respuestas de Dany se oían a trozos; en textos largos
(~3.900 caracteres) no se oían.

**Causa raíz.** Un fallo de `edge-tts` (su timeout) **descartaba el mensaje
para siempre**: la locución se perdía sin más.

**Arreglo.** El fallo de síntesis devuelve la locución a la cola con espera
progresiva (`notBefore`, hasta 6 reintentos globales), y el mensaje se
re-sintetiza. Además, el troceado (`maxChunkChars: 420`) garantiza que cada
fragmento quepa en una síntesis razonable.

**Cómo se comprobó.** Flujo completo de Dany: HTTP 202 → `es-CL-LorenzoNeural`
→ `REPRODUCIENDO` → `Playback done`.

---

## 4. El disco C: se llenó (quedaban 0.2 GB)

**Síntoma.** "Casi 20 GB libres" y luego nada: el sistema casi se queda sin
espacio.

**Causa raíz.** Varios tramos, todos medidos:

| Causa | Tamaño |
|---|---|
| Fuga de temporales de `edge-tts` (`ciudadan-edge-*` en `%TEMP%`) | 291 MB y creciendo |
| Parches de DSH (`v-*.b64`) escritos en C: | 121 MB por tanda |
| Cachés de Chrome / OneDrive | crecimiento continuo (~695 MB / 15 min) |
| `hiberfil.sys` | **12.8 GB** |

**Arreglo.**

1. Todo lo que crece se movió a **Kompa**: runtime, estado, cache de audio,
   logs, patches del limpiador.
2. `src/paths.js` separa **CONFIG_DIR** (local: token + `config.json`, los
   secretos no salen de la máquina) de **STATE_DIR** (Kompa: cache, logs, cola,
   historial, snapshots).
3. El temporal de `edge-tts` se borra **siempre** (éxito y error).
4. `powercfg /hibernate off` (12.8 GB liberados; reversible con
   `powercfg /hibernate on`).
5. Tareas programadas: `Ciudadan-TTS-Limpieza` (cada 30 min, mueve residuos a
   `\\192.168.1.7\Kompa\_residuos-temp\…` en vez de borrar) y
   `Ciudadan-TTS-Coordinator` (watchdog).

**Cómo se comprobó.** C: pasó de **0.2 GB** libres a **16.6-17.4 GB**. Kompa
queda con 29.2 GB libres. Nada se borró de forma irreversible: los residuos se
mueven a `_residuos-temp`.

---

## 5. El watchdog reiniciaba el coordinator cada 2 minutos

**Síntoma.** El ducking se quedaba en *stub* la mitad del tiempo; las
locuciones se cortaban; config y logs se reiniciaban solos.

**Causa raíz.** El watchdog mataba cualquier PID vivo tras 25 s del arranque,
sin comprobar si el servicio estaba arrancando o ya sano.

**Arreglo.** Si hay una instancia viva → **esperar** (hasta 3 min) y no matarla.
Si no hay ninguna → arrancar una y esperar hasta 150 s antes de avisar.

**Cómo se comprobó.** 3 min de vigilancia: 0 líneas nuevas en el log, PID
constante, health 200.

---

## 6. El ducking no hacía nada (`audioBridgeAvailable: false`)

**Síntoma.** El navegador no bajaba de volumen aunque el modo fuera "reducir".

**Causa raíz.** Dos cosas:

1. El watchdog mataba el coordinator y con él el daemon de pycaw (error nº5).
2. Al mover el runtime a Kompa (ruta UNC), el script del puente se localizaba
   con `new URL('./audio-session.py', import.meta.url).pathname`, que en un
   UNC **produce una ruta inválida** (`/\\server\...`).

**Arreglo.** `fileURLToPath(new URL(...))` (convierte correctamente a ruta
Windows) y el watchdog que ya no mata al servicio.

**Cómo se comprobó.** `GET /api/v1/multimedia/status` →
`audioBridgeAvailable: true`, `navegador` con `ducking.stub: false`, y el log
muestra el ajuste real de volumen por proceso.

---

## 7. `pathsStateDir is not a function`

**Síntoma.** El coordinador arrancaba y se caía al resolver títulos de DSH.

**Causa raíz.** En `src/sessions/dsh-titles.js` se importó la **constante**
`STATE_DIR` con alias de función y luego se llamó: `pathsStateDir()`.

**Arreglo.** `import { STATE_DIR } from '../paths.js'` y usarla como valor.

---

## 8. Rutas con barras escapadas en la configuración

**Síntoma.** El config apuntaba a `\\\\192.168.1.7\\Kompa\\…` (dobles
barras literales) y el estado no se encontraba.

**Causa raíz.** Comillas de PowerShell en línea al escribir JSON a mano.

**Arreglo.** No escribir JSON con PowerShell en línea: usar un script Python
en un archivo que hace `json.dump` (esto se aplicó a `fix-rutas.py`).

---

## 9. `powershell.exe` no abre scripts por ruta UNC

**Síntoma.** El daemon de voz local no arrancaba:
`El argumento '\\192.168.1.7\...sapi-voice.ps1' para el parámetro -File no existe`.

**Causa raíz.** `powershell.exe` (Windows PowerShell 5.1) no resuelve `-File`
con rutas UNC, y el runtime vive en Kompa.

**Arreglo.** El cliente copia el script a una ruta **local** (con hash del
contenido en el nombre) y lo ejecuta desde ahí.

---

## 10. El daemon de voz local arrancaba pero no decía nada

**Síntoma.** El proceso PowerShell vivía, pero el cliente no recibía la línea
`ready` y acababa en "el daemon SAPI no arrancó".

**Causa raíz.** `Write-Output` **se bufferiza** en el pipeline de PowerShell; al
redirigir la salida no llegaba nada.

**Arreglo.** Escribir directo a la consola con
`[Console]::Out.WriteLine(...)` + `[Console]::Out.Flush()`.

---

## 11. El wrapper `edge-tts.exe` dejaba procesos huérfanos

**Síntoma.** La cola se atascaba: el `close` del proceso nunca llegaba.

**Causa raíz.** `edge-tts.exe` es un *wrapper* que lanza `python.exe` como
hijo. Matar el wrapper **no** mata al hijo.

**Arreglo.** Se usa el módulo directamente (`python -m edge_tts`) y, al vencer
el timeout, se mata el **árbol** de procesos (`taskkill /T /F`). Si el MP3 ya
está escrito y es utilizable, **se usa** en vez de perder la locución.

---

## 12. La voz local "ganaba" pero el reproductor no encontraba el audio

**Síntoma.** `ENOENT: no such file or directory, open '...\out.mp3'` justo
después de que el respaldo local ganara la carrera.

**Causa raíz.** El resultado del respaldo local se resolvía **sin la etiqueta
`source: 'local'`**, así que el código caía en la rama de `edge-tts` e iba a
leer `out.mp3`, que por definición no existe en ese camino.

**Arreglo.** `resolveLocal({ ok: true, source: 'local', … })`.

---

## 13. El token acababa impreso en el log

**Síntoma.** El log del coordinator mostraba los primeros 8 caracteres del
token Bearer.

**Causa raíz.** Un `console.log` de depuración al arrancar.

**Arreglo.** Se quitó; el arranque solo indica **dónde está** el archivo del
token (`~/.ciudadan-tts-coordinator/token`), nunca su contenido.

---

## 14. `G:` no es un disco: es Google Drive

**Lo que se creyó.** Que en `G:` había 15 GB ocupados y ~7 GB libres que
había que liberar.

**La realidad.** `G:` es el **volumen virtual de Google Drive**: el "15 GB" es
la cuota de la nube y el "espacio libre" oscila (4.5-7.3 GB) según la
sincronización. Los archivos dentro son copias sincronizadas, no datos locales.
**No hay nada que liberar ahí para el disco C:**.

---

## 15. El VDI de VirtualBox no se puede compactar

**Lo que se creyó.** Que un `.vdi` de 53.9 GB estaba "desperdiciando" espacio.

**La realidad.** `ciudadanserver.vdi` es de tamaño **fijo** (no dinámico): no
se compacta. `Ciudadan.vdi` sí es dinámico, pero al compactarlo solo se
recuperaron 1.2 GB (45.4 → 44.2 GB) porque el espacio está realmente usado
dentro. **Ninguna VM se borró** (es irreversible y requiere OK explícito).

---

## 16. `cmd.exe` no puede cambiar al directorio UNC

**Síntoma.** `CMD.EXE se inició con esta ruta como el directorio actual. No se
permiten rutas UNC.`

**Causa raíz.** El *cwd* del proceso era `\\192.168.1.7\kompa\agente2ciudadanmex`.

**Arreglo.** No usar `cd` a UNC: se pasa la ruta UNC **como argumento** a node
(`node "\\192.168.1.7\...\runtime\src\server\index.js"`). El aviso es
benigno.

---

## 17. `UnicodeEncodeError: 'charmap' codec` al escanear

**Síntoma.** Los scripts Python de diagnóstico morían al imprimir `▶` o `✓`.

**Causa raíz.** La consola de Windows usa cp1252.

**Arreglo.** Escribir con `sys.stdout.buffer.write(...encode('utf-8','replace'))`
o forzar `sys.stdout.reconfigure(encoding='utf-8')`.

---

## 18. El grep del harness y algunos comandos largos fallaban

**Síntoma.** `grep` con muchos patrones agotaba el tiempo; algunos comandos
PowerShell devolvían `exit code 1` o `4294967295`.

**Causa raíz.** Límites del runner, no del código.

**Arreglo.** Usar `Select-String` sobre archivos concretos, dividir los
comandos largos en varios y escribir los scripts a archivo en vez de inline.

---

## Cómo evitar la recaída

- **Una sola fuente de verdad por configuración**: si el usuario elige un valor,
  el valor por defecto no puede pisarlo. (`_fusionarNavegador`).
- **Ningún proceso supervisor puede matar a un servicio sano**: primero esperar,
  después actuar.
- **Toda dependencia de red necesita respaldo local**: si puede colgarse, tiene
  un camino alterno (`edge-tts` → voz de Windows).
- **Los fallos de síntesis no borran el trabajo del usuario**: reintento con
  espera progresiva, nunca descarte.
- **Medir antes de culpar**: los cuatro fallos más caros de esta lista
  (entrecortado, config que se revierte, ducking en stub, disco lleno) se
  diagnosticaron con una medición, no con una suposición.


---

# Segunda tanda (11/11/2026): el audio se cortaba y el volumen quedaba bajo

## 19. La voz se escuchaba "cada vez más cortada"

**Síntoma.** Cuanto más se usaba el servicio, peor se oía. El usuario lo
describió como "cada vez se escucha más cortado".

**Causa raíz (dos, y las dos importaban).**

1. **El audio se reproducía desde Kompa, por SMB.** El log lo delataba:
   `mpv CMD enviado {"value":"...audio-cache\\...wav"}` y, 45 segundos después,
   `mpv poll {"pos":null}` -> **mpv no avanzaba**. Medido en frío: abrir un WAV
   de 865 KB desde Kompa tardó **más de 400 s**; el mismo archivo en local se
   abre al instante. La voz local de Windows pesa unas 10 veces más que el
   MP3 de edge-tts, así que al entrar el respaldo el problema se agravó.
2. **El ducking se encadenaba.** `newv = prev x (1 - pct)` se calculaba sobre
   el volumen **actual**, no sobre el original: 22 -> 13 -> 8 -> 5 -> 3 -> 1.
   El volumen de Chrome llegó a estar en **1 %**. Cada locución nacía más baja
   que la anterior: eso es exactamente "cada vez más cortado".

**Arreglo.**

- `src/synthesis/edge.js`: el audio que se reproduce se copia a **disco local**
  (`%TEMP%\ciudadan-audio-local\`) y mpv lo reproduce desde ahí. El cache en
  Kompa se conserva (para no resintetizar), pero **nunca se reproduce desde la
  red**. Los archivos locales de más de 10 min se limpian solos.
- `src/multimedia/controller.js`: `resetAppVolume(appKey)` pone el volumen de
  esa app al **100** y deja ese 100 como **nuevo original**, de modo que la
  siguiente atenuación parta de 100 y no se encadene.

**Cómo se comprobó.** Antes: `loadfile` -> `Terminado` = **85 s** para 40 s de
audio (con `pos:null` en medio). Después: `loadfile` -> `end-file` = **17 s**
para 17 s de audio (coincidencia exacta) y sin ningún `pos:null`.

## 20. El volumen quedaba bajo y no se veía en la barra

**Síntoma.** "Le bajas el volumen pero en la barra no se baja" y "dejaste el
volumen bajado".

**Causa raíz.** El ducking baja la **sesión del mezclador** de la app
(`SimpleAudioVolume` de pycaw), que es la barra de la app, no la barra del
dispositivo. Y el "restaurar" devolvía el valor original (17-22 %), que en ese
equipo era bajo de partida. Con el encadenamiento (19) el valor se disparaba
hacia 0 y ya no se recuperaba solo.

**Arreglo.**

- Botón **"Subir al 100 ahora"** en el panel, **uno por cada fuente de
  audio** (navegador, spotify, vlc...). Llama a
  `POST /api/v1/multimedia/volume-reset` con `{appKey}`.
- El endpoint pone las sesiones de esa app al 100 **y** actualiza el original
  guardado, para que el ducking siguiente calcule 100 x (1 - %) y no se
  encadene.
- No se toca el volumen maestro ni el volumen interno de mpv.

**Cómo se comprobó.** `POST /api/v1/multimedia/volume-reset {"appKey":"navegador"}`
-> `ok:true, restored:[chrome]`; log: `[navegador] volumen restaurado
{sesiones:["chrome(17056)"]}`. Chrome estaba en **1 %** -> pasó a **100 %**.

## 21. Una locución se perdía cada vez que se reiniciaba el TTS

**Síntoma.** "Deja los DSHs de modo que ya vayan a consumir el servicio sin
tenerlos que estar tocando cuando hagas cambios en el servicio TTS".

**Causa raíz.** `dsh-bridge/lib/index.js` hacía **una sola** petición con
timeout de 10 s. Durante el reinicio del coordinator el puerto 3199 no acepta
conexiones -> la petición fallaba -> **la locución se perdía para siempre**,
sin reintento.

**Arreglo.** El bridge ahora reintenta hasta 5 veces con espera creciente
(1, 2, 4, 8, 15 s) y timeout de 15 s. Los errores 4xx (petición incorrecta) no
se reintentan; los de conexión o 5xx, sí. El agente **no se bloquea**: si tras
todos los intentos falla, se avisa y se sigue.

> **Nota de despliegue:** este cambio vive en el repositorio del bridge. Para
> que un DSH ya en ejecución lo use hay que reiniciar **ese** DSH **una vez**.
> A partir de ahí, los cambios del TTS **no** requieren tocar los DSH: el
> bridge lee el token del archivo en cada llamada y habla por HTTP.

---

# Procedimiento para cambiar el TTS sin tocar los DSH

1. Editar en el workspace (`K:\agente2ciudadanmex\ciudadan-tts-coordinator`).
2. `node --check` de cada archivo tocado.
3. Copiar **archivo por archivo** al runtime
   (`\\192.168.1.7\Kompa\_ciudadan-tts-coordinator\runtime`) y **verificar el
   hash**: `robocopy` puede saltarse un archivo si el destino parece más
   nuevo (ya pasó: el `controller.js` se quedó sin desplegar y el endpoint
   devolvió `resetAppVolume is not a function`).
4. Reiniciar **solo** el coordinator (el watchdog no toca nada más). El
   arranque tarda ~6 s.
5. Verificar: `GET /api/v1/health` = 200, **un** proceso node con el patrón
   `node "\\192.168.1.7\...\runtime\src\server\index.js"` y **un** listener en
   el 3199.
6. **No** reiniciar DSH1, DSH2 ni Dany. Si mandan una locución durante los 6 s
   del reinicio, el bridge la reintenta (tras activar el cambio con un único
   reinicio del DSH).

> **Trampa de conteo:** un filtro de PowerShell que busque `server*index.js`
> coincide con el propio texto del comando de diagnóstico y cuenta falsos
> coordinators. Contar por `Name -eq 'node.exe'` **y** comprobar el listener
> del 3199.


---

## 22. El monitor del portapapeles no detectaba copias (tres trampas de Win32)

**Síntoma.** El watcher arrancaba, registraba el atajo Ctrl+Alt+R, pero copiar
texto no producía ninguna lectura.

**Causas raíz (tres, todas medidas).**

1. **La ventana "message-only" (HWND_MESSAGE) no recibió WM_CLIPBOARDUPDATE.**
   El autotest (PostMessage propio) tampoco llegó: el bucle de mensajes no
   entregaba el mensaje a esa ventana. Cambiar a una ventana **top-level
   oculta** (`WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE`, sin WS_VISIBLE) lo arregló:
   de repente llegaron los `WM_CLIPBOARDUPDATE` reales.
2. **El hilo de C# llamaba scriptblocks de PowerShell** (los callbacks
   `onText`/`onHotkey`): en PowerShell 5.1 no es seguro invocar un scriptblock
   desde otro hilo y fallaba en silencio. Ahora el C# encola eventos en una
   `ConcurrentQueue<string>` y el hilo principal de PowerShell los procesa.
3. **`GetClipboardData` sin `OpenClipboard` devolvía NULL.** Hay que abrir el
   portapapeles para leerlo (solo lectura: jamás se modifica ni se limpia) y
   cerrarlo enseguida. Si otro proceso lo tiene abierto, `OpenClipboard` falla
   con ERROR_ACCESS_DENIED y el evento se descarta sin consumir la secuencia.

Además: `Add-Type` compila con **C# 5** (nada de `out var` inline ni
`const IntPtr`), y `powershell.exe -File` rechaza rutas UNC (el script se
copia a `%TEMP%` con hash, como el daemon SAPI).

**Arreglo y verificación.** Ver `docs/portapapeles.md`. Verificado en vivo:
copia real -> `▶ REPRODUCIENDO {source:"clipboard"}` -> `Locución efímera
servida (no se guarda en el historial)`; el atajo simulado con `keybd_event`
alternó `enabled` (True -> False); imagen ignorada; texto de 4200 caracteres
recortado a 2000; con la captura apagada no se lee; DSH1/DSH2 siguieron
sonando durante toda la prueba.
