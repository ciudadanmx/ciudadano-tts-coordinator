// Integración de Claude Code con el ciudadano-tts-coordinator.
//
// Claude Code NO implementa síntesis ni reproducción de voz: es un cliente
// adicional del servicio TTS centralizado que ya usan DSH1 (:3080) y DSH2
// (:3081). Este script es un adaptador ligero sobre los hooks oficiales de
// Claude Code (evento "Stop") que entrega el texto final al coordinador.
//
// Contrato usado (mismo que el puente de DSH):
//   POST /api/v1/speech
//   { requestId, source, sessionId, sessionTitle, taskTitle, voice, text,
//     priority, interventionId, fragmentIndex, totalFragments }
//
// El hook se ejecuta con el payload JSON del evento por stdin y SIEMPRE
// termina con código 0: nunca bloquea ni interrumpe a Claude Code.
//
//   Modos:
//     node claude-code.js                 → modo hook (lee stdin)
//     node claude-code.js --worker <f>   → trabajador interno (spoooled)
//     node claude-code.js status|pause|resume|stop|skip|cancel|cancel-session|volume|say
//
// Referencia de payload (Claude Code 2.1.309, evento Stop):
//   { hook_event_name, session_id, transcript_path, stop_hook_active,
//     last_assistant_message, cwd, ... }

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CONFIG, api, dedupeKey, ensureVoice, isDuplicate, logLine, prepareUtterance,
  stateDir,
} from './claude-orch-common.js'

const SELF = fileURLToPath(import.meta.url)

/* ------------------------------------------------------------------ *
 * Modo hook
 * ------------------------------------------------------------------ */

/** Lee todo el stdin (el payload JSON del evento). */
async function readStdin() {
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  return input
}

/**
 * Extrae el texto de la respuesta final del asistente.
 * En 2.1.309 el campo es `last_assistant_message`; se mantienen los campos
 * anteriores como respaldo para versiones previas.
 */
function extractText(event) {
  const candidates = [
    event.last_assistant_message,
    event.final_message,
    event.message,
    event.text,
    event.summary,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c
  }
  return ''
}

/** Título legible de la sesión: carpeta del proyecto (cwd) o nombre por defecto. */
function sessionTitleFor(event) {
  const cwd = event.cwd || event.project || ''
  if (cwd) {
    const name = basename(String(cwd).replace(/[\\/]+$/, ''))
    if (name) return name
  }
  if (event.transcript_path) {
    const parts = String(event.transcript_path).split(/[\\/]/)
    const proj = parts[parts.length - 2] || ''
    if (proj && !/^projects$/i.test(proj)) return proj
  }
  return 'Claude Code'
}

function spoolDir() {
  const dir = join(stateDir(), 'spool')
  try { mkdirSync(dir, { recursive: true }) } catch { /* sin spool */ }
  return dir
}

/**
 * Encola la locución en el coordinador compartido.
 * Los fragmentos se POSTean SECUENCIALMENTE para que el orden intra-
 * intervención se respete en la cola (igual que hace el puente de DSH).
 */
async function speak(payload) {
  const { sessionId, sessionTitle, text, interventionId } = payload

  const { spoken, chunks } = await prepareUtterance(text)
  if (!spoken || !chunks.length) {
    logLine(`sin texto hablable session=${sessionId}`)
    return { ok: false, reason: 'empty' }
  }

  // Voz de Tomás asignada de forma persistente a esta sesión de Claude.
  const voice = await ensureVoice(sessionId)
  if (!voice.ok) logLine(`no se pudo asignar voz session=${sessionId} err=${JSON.stringify(voice.error)}`)

  let sent = 0
  for (const chunk of chunks) {
    const res = await api('/api/v1/speech', {
      method: 'POST',
      body: {
        requestId: `${interventionId}-${chunk.index}`,
        source: CONFIG.source,
        sessionId,
        sessionTitle,
        taskTitle: '',
        voice: CONFIG.voice,
        text: chunk.text,
        priority: 'normal',
        interventionId,
        fragmentIndex: chunk.index,
        totalFragments: chunks.length,
      },
    })
    if (!res.ok) {
      logLine(`error encolando frag=${chunk.index + 1}/${chunks.length} session=${sessionId} err=${JSON.stringify(res.error)}`)
      return { ok: false, reason: 'enqueue', error: res.error, sent }
    }
    sent++
  }
  logLine(`encolado session=${sessionId} fragmentos=${sent}/${chunks.length} voz=${CONFIG.voice}`)
  return { ok: true, sent, total: chunks.length }
}

/** Trabajador: lee el payload del spool y habla. */
async function workerMain(spoolFile) {
  let payload
  try {
    payload = JSON.parse(readFileSync(spoolFile, 'utf8'))
  } catch (e) {
    logLine(`spool ilegible: ${e.message}`)
    return
  }
  try {
    await speak(payload)
  } catch (e) {
    logLine(`worker error: ${e.message}`)
  } finally {
    try { rmSync(spoolFile, { force: true }) } catch { /* ignorar */ }
  }
}

/**
 * Lanza el trabajador DESACOPLADO para no bloquear a Claude Code.
 * Si el spawn falla, se hace el trabajo en línea (con timeout acotado).
 */
function dispatch(payload) {
  const file = join(spoolDir(), `${payload.interventionId}.json`)
  try {
    writeFileSync(file, JSON.stringify(payload), 'utf8')
  } catch (e) {
    logLine(`no se pudo escribir spool: ${e.message}`)
    speak(payload)
    return
  }
  try {
    const child = spawn(process.execPath, [SELF, '--worker', file], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
  } catch (e) {
    logLine(`spawn falló, ejecutando en línea: ${e.message}`)
    speak(payload)
  }
}

export async function claudeHookMain() {
  const input = await readStdin()
  let event = {}
  try {
    event = JSON.parse(input || '{}')
  } catch (e) {
    logLine(`payload no JSON: ${e.message}`)
    return
  }

  const text = extractText(event)
  if (!text.trim()) return

  const sessionId = event.session_id || 'claude-orch-session'

  // --- Evitar lecturas duplicadas ---
  // Clave estricta: identifica el evento concreto (mismo turno => mismo
  // tamaño de transcripción y mismo texto) → una locución por turno.
  let transcriptSize = 0
  if (event.transcript_path) {
    try { transcriptSize = statSync(event.transcript_path).size } catch { transcriptSize = 0 }
  }
  const strictKey = dedupeKey(sessionId, `${event.transcript_path || ''}|${transcriptSize}|${text}`)
  if (isDuplicate(strictKey, 5 * 60 * 1000)) {
    logLine(`duplicado descartado session=${sessionId}`)
    return
  }
  // Clave laxa: si Claude Code re-dispara el hook con stop_hook_active (ya
  // había hablado ese texto), no se vuelve a leer.
  if (event.stop_hook_active === true) {
    const looseKey = dedupeKey(sessionId, text)
    if (isDuplicate(looseKey, 5 * 60 * 1000)) {
      logLine(`stop_hook_active con texto ya leído session=${sessionId}`)
      return
    }
  }

  dispatch({
    interventionId: randomUUID(),
    sessionId,
    sessionTitle: sessionTitleFor(event),
    text,
  })
}

/* ------------------------------------------------------------------ *
 * CLI de control (usa sólo endpoints existentes del coordinador)
 * ------------------------------------------------------------------ */

async function cliMain(args) {
  const cmd = (args[0] || '').toLowerCase()
  const print = (o) => process.stdout.write(`${typeof o === 'string' ? o : JSON.stringify(o, null, 2)}\n`)

  switch (cmd) {
    case 'status': {
      const st = await api('/api/v1/status')
      const q = await api('/api/v1/queue')
      const items = (q?.data?.items || []).filter(i => i.source === CONFIG.source)
      print({ coordinator: st?.ok ? st.data : st, claudeItems: items })
      return
    }
    case 'pause': {
      print(await api('/api/v1/playback/pause', { method: 'POST' }))
      return
    }
    case 'resume': {
      print(await api('/api/v1/playback/resume', { method: 'POST' }))
      return
    }
    case 'stop': {
      print(await api('/api/v1/playback/stop', { method: 'POST' }))
      return
    }
    case 'skip': {
      print(await api('/api/v1/playback/skip', { method: 'POST' }))
      return
    }
    case 'cancel': {
      const requestId = args[1]
      if (!requestId) { print('uso: cancel <requestId>'); return }
      print(await api(`/api/v1/queue/${encodeURIComponent(requestId)}`, { method: 'DELETE' }))
      return
    }
    case 'cancel-session': {
      const sessionId = args[1]
      if (!sessionId) { print('uso: cancel-session <sessionId>'); return }
      print(await api(`/api/v1/sessions/${encodeURIComponent(sessionId)}/queue`, { method: 'DELETE' }))
      return
    }
    case 'volume': {
      if (args[1] === undefined) { print(await api('/api/v1/playback/volume')); return }
      print(await api('/api/v1/playback/volume', { method: 'POST', body: { volume: Number(args[1]) } }))
      return
    }
    case 'say': {
      const text = args.slice(1).join(' ')
      if (!text) { print('uso: say <texto>'); return }
      const interventionId = randomUUID()
      const { chunks } = await prepareUtterance(text)
      const out = []
      for (const chunk of chunks) {
        out.push(await api('/api/v1/speech', {
          method: 'POST',
          body: {
            requestId: `${interventionId}-${chunk.index}`,
            source: CONFIG.source,
            sessionId: 'claude-orch-cli',
            sessionTitle: 'Claude Code',
            taskTitle: '',
            voice: CONFIG.voice,
            text: chunk.text,
            priority: 'normal',
            interventionId,
            fragmentIndex: chunk.index,
            totalFragments: chunks.length,
          },
        }))
      }
      print({ ok: out.every(o => o.ok), fragments: out.length })
      return
    }
    default:
      print([
        'uso: claude-code.js <comando>',
        '  status             estado del coordinador + cola de Claude',
        '  pause | resume     pausa/continúa el reproductor compartido (afecta a todas las fuentes)',
        '  stop | skip        detiene/salta la locución actual (global)',
        '  cancel <requestId> cancela una locución de Claude',
        '  cancel-session <sessionId> cancela la cola de esa sesión de Claude',
        '  volume [n]         consulta o fija el volumen del reproductor compartido',
        '  say <texto>        encola un texto con la voz de Tomás (prueba)',
      ].join('\n'))
  }
}

/* ------------------------------------------------------------------ *
 * Arranque
 * ------------------------------------------------------------------ */

// Detección de "main" robusta en Windows: las rutas pueden diferir en
// mayúsculas/minúsculas o por el prefijo de dispositivo.
function isMainPath() {
  if (!process.argv[1]) return false
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\/([a-zA-Z]:)/, '$1').toLowerCase()
  return norm(fileURLToPath(import.meta.url)) === norm(process.argv[1])
}

const isMain = isMainPath()
if (isMain) {
  const args = process.argv.slice(2)
  if (args[0] === '--worker') {
    await workerMain(args[1])
  } else if (args.length) {
    await cliMain(args)
  } else {
    try {
      await claudeHookMain()
    } catch (e) {
      // Silencioso para Claude: nunca bloquear ni ensuciar stdout.
      logLine(`hook error: ${e.message}`)
    }
  }
  process.exit(0)
}

export { speak, extractText, sessionTitleFor }
