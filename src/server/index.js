// ciudadano-tts-coordinator — Servidor principal
// Servicio independiente en 127.0.0.1 con API versionada, cola global,
// reproductor mpv, síntesis edge-tts, y control multimedia.

import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { loadConfig, saveConfig, getConfig } from '../configuration/store.js'
import { logger } from '../monitoring/logger.js'
import { getOrCreateToken, requireAuth, validateToken } from '../security/token.js'
import { UtteranceQueue } from '../queue/manager.js'
import { MpvPlayer } from '../player/mpv.js'
import { EdgeSynthesizer } from '../synthesis/edge.js'
import { SessionRegistry, cleanTitle } from '../sessions/registry.js'
import { SourceRegistry } from '../sources/registry.js'
import { DshTitleResolver } from '../sessions/dsh-titles.js'
import { MultimediaController } from '../multimedia/controller.js'
import { ClipboardService } from '../clipboard/service.js'

// --- Inicialización ---
const config = loadConfig()
logger.init(config)

logger.info('=== ciudadano-tts-coordinator iniciando ===', {
  host: config.server.host,
  port: config.server.port,
  player: config.player.type,
  synthesisProvider: config.synthesis.provider,
})

// Token de autenticación
const token = getOrCreateToken()
logger.info(`Token generado/disponible en ${process.env.CIUDADAN_TTS_TOKEN ? 'env CIUDADAN_TTS_TOKEN' : '~/.ciudadan-tts-coordinator/token'}`)

// Componentes
const synthesizer = new EdgeSynthesizer(config)
// RESPALDO DE VOZ LOCAL (10/11/2026): edge-tts depende de internet y se cuelga
// de forma intermitente (medido: 2 de 3 pruebas de 120 s sin escribir un byte).
// El daemon de voz de Windows se arranca aqui, en segundo plano, para que su
// motor este cargado ANTES de la primera locucion: cargarlo en frio cuesta
// ~15 s y con el motor caliente responde en menos de 1 s.
synthesizer.warmup?.()
const player = new MpvPlayer(config)
const sessions = new SessionRegistry(config)
// Fuentes de voz (agentes/servicios). Registro extensible y persistente.
const sources = new SourceRegistry(config)
const dshTitles = new DshTitleResolver()
const multimedia = new MultimediaController(config)

// Estado de pausa DEL TTS (no del mpv). El mpv arranca en idle y en idle
// isPaused() devuelve true: el status mentia y el boton del panel ponia
// "REANUDAR" sin que hubiera nada pausado (el panel "parecia trabado").
let ttsPaused = false

// Un título con U+FFFD ("�") está corrupto por codificación: no se usa para hablar.
function tituloLimpio(t) {
  if (!t) return ''
  const s = String(t).trim()
  if (!s) return ''
  if (s.includes('\uFFFD')) return ''
  return s
}

// Un título que realmente es un IDENTIFICADOR de sesión no debe anunciarse:
// el cliente a veces manda su propio sessionId como fallback ("ed00cf7a",
// "53be07a5-d84"). Se detecta comparándolo con el sessionId real y por forma.
function pareceSessionId(t, sessionId) {
  if (!t) return true
  const s = String(t).trim()
  if (!s) return true
  if (/^session-[\w-]+$/i.test(s)) return true
  if (/^[0-9a-f]{8}$/i.test(s)) return true
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return true
  // Formas abreviadas de UUID: "ed00cf7a-b7c1", "53be07a5-d84"
  if (/^[0-9a-f]{6,8}(-[0-9a-f]{2,4}){1,3}$/i.test(s)) return true
  // El título es un prefijo/fragmento del sessionId real -> es un id
  if (sessionId) {
    const sid = String(sessionId).trim().replace(/^session-/i, '').toLowerCase()
    const norm = s.toLowerCase().replace(/^session-/i, '')
    if (norm && sid && (sid === norm || sid.startsWith(norm) || norm.startsWith(sid))) return true
  }
  return false
}

// Nombre mostrado de una sesión: título real del DSH (disco) > título recibido > registro
// NUNCA un identificador: si no hay título real se usa un nombre legible ("Sesión de DSH1").
function displayName(sessionId, receivedTitle, source) {
  const fromDsh = tituloLimpio(dshTitles.resolve(sessionId))
  if (fromDsh && !pareceSessionId(fromDsh, sessionId)) return fromDsh
  const reg = tituloLimpio(sessions.resolveDisplayName(sessionId))
  if (reg && !pareceSessionId(reg, sessionId)) return reg
  const recv = tituloLimpio(receivedTitle)
  if (recv && !pareceSessionId(recv, sessionId)) return recv
  const src = String(source || '').toLowerCase()
  const legible = src === 'dsh1' ? 'Sesión de DSH1'
    : src === 'dsh2' ? 'Sesión de DSH2'
    : src === 'dany' ? 'Sesión de Dany'
    : src === 'claude-code' ? 'Sesión de Claude Code'
    : 'Sesión'
  return legible
}

const queue = new UtteranceQueue(config, {
  synthesize: async (text, opts) => synthesizer.synthesize(text, opts),
  player,
  multimedia,
})

// Servicio de lectura del portapapeles. Esta parte NO usa Win32: el monitor
// nativo (AddClipboardFormatListener + WM_CLIPBOARDUPDATE + Ctrl+Alt+R) vive
// en scripts/clipboard-watcher.ps1, como proceso separado en la sesión
// interactiva, y se comunica por HTTP. El núcleo del coordinator sigue siendo
// independiente de Windows.
const clipboard = new ClipboardService(config, sources, queue)

// Eventos de la cola → log
queue.on('playing', (u) => logger.info('▶ REPRODUCIENDO', { source: u.source, session: u.sessionTitle || u.sessionId, voice: u.voice }))
queue.on('done', (u) => logger.info('✓ Terminado', { requestId: u.requestId }))
queue.on('error', (u, err) => logger.error('✗ Error en utterance', { requestId: u.requestId, error: err?.message || u.error }))

// --- Utilidades HTTP ---
function sendJson(res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': 'null',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Ciudadan-Token',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  })
  res.end(body)
}

function readBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > maxBytes) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function parseJsonBody(req) {
  const raw = await readBody(req)
  try { return JSON.parse(raw.toString('utf8') || '{}') } catch { return {} }
}

// --- Rutas API ---
const routes = []

function route(method, pattern, handler, opts = {}) {
  routes.push({ method, pattern, handler, auth: opts.auth !== false })
}

// Health (sin auth para monitoreo: solo escucha en 127.0.0.1 y no expone datos)
route('GET', '/api/v1/health', (req, res) => {
  sendJson(res, 200, {
    ok: true,
    service: 'ciudadan-tts-coordinator',
    status: 'healthy',
    player: player._connected ? 'ready' : 'disconnected',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    activeConnections: 0, // se podría trackear
    pendingUtterances: queue.getQueue().filter(u => !['done','error','cancelled'].includes(u.status)).length,
  })
}, { auth: false })

// Status general
route('GET', '/api/v1/status', async (req, res) => {
  // `paused` es el estado de pausa del TTS. Antes se leia player.isPaused(),
  // que en idle (mpv sin archivo) devuelve true: el panel moria al mostrar
  // "REANUDAR" y el TTS parecia trabado.
  const paused = ttsPaused
  const st = queue.getStatus()
  if (st.current && st.current.sessionId) {
    st.current = { ...st.current, sessionName: displayName(st.current.sessionId, st.current.sessionTitle, st.current.source) }
  }
  sendJson(res, 200, {
    ok: true,
    ...st,
    paused,
    multimedia: multimedia.getStatus(),
    sessions: sessions.getAllSessions().length,
    config: {
      audioMode: config.multimedia?.audioMode,
      announcementsEnabled: config.announcements?.enabled,
      voiceDefault: config.voices?.default,
    },
  })
})

// Enviar locución a la cola
route('POST', '/api/v1/speech', async (req, res) => {
  const body = await parseJsonBody(req)
  const src = sources.resolve(body.source)
  const esPreview = body.preview === true
  // Fuente desactivada en el panel: la locución se DESCARTA (no se acumula una
  // cola silenciosa que después se reproduzca toda junta). No se toca el agente.
  if (!esPreview && src && src.enabled === false) {
    logger.info('Locución descartada: fuente desactivada', { source: body.source, id: src.id })
    return sendJson(res, 202, { ok: true, skipped: true, reason: 'source-disabled', source: src.id })
  }
  // --- PORTAPAPELES (Sprint 1) -------------------------------------------
  // Copiar un texto nuevo REEMPLAZA únicamente la lectura anterior del
  // portapapeles: no se tocan las locuciones de otros agentes ni las alertas.
  // El texto se marca efímero para no guardarlo en el historial persistente.
  if (!esPreview && src?.id === 'clipboard') {
    const sub = clipboard.submitText(body.text)
    if (!sub.ok) {
      logger.info('Texto del portapapeles descartado', { reason: sub.error })
      return sendJson(res, 202, { ok: true, skipped: true, reason: sub.error })
    }
    // Copiar EXACTAMENTE lo mismo que la copia anterior no vuelve a encolar:
    // no se repite la lectura. (Solo se compara por hash; el texto no se guarda.)
    if (sub.duplicate) {
      logger.info('Lectura del portapapeles omitida: texto idéntico al anterior', {
        chars: sub.chars,
      })
      return sendJson(res, 202, { ok: true, skipped: true, reason: 'duplicate', chars: sub.chars })
    }
    const replaced = queue.cancelSession('clipboard')
    const request = {
      requestId: body.requestId || randomUUID(),
      source: 'clipboard',
      sourceId: 'clipboard',
      sessionId: 'clipboard',
      sessionName: '',
      sessionTitle: '',
      taskTitle: '',
      voice: src.voice || body.voice || config.voices?.default || 'es-MX-DaliaNeural',
      text: sub.text,
      priority: body.priority || 'normal',
      interventionId: body.interventionId,
      fragmentIndex: body.fragmentIndex ?? 0,
      totalFragments: body.totalFragments ?? 1,
      preview: false,
      ephemeral: true, // no se guarda en el historial (privacidad)
    }
    sources.markSeen('clipboard')
    const result = queue.enqueue(request)
    if (!result.ok) return sendJson(res, 429, { ok: false, error: result.error, requestId: result.requestId })
    logger.info('Lectura del portapapeles encolada', {
      requestId: result.requestId, chars: sub.chars, reemplazadas: replaced.cancelled,
    })
    return sendJson(res, 202, { ok: true, ...result, replaced: replaced.cancelled })
  }
  // Registrar sesión PRIMERO para que getVoice conozca el source y asigne la voz correcta
  if (body.sessionId) {
    sessions.registerSession(body.sessionId, {
      source: body.source || 'unknown',
      title: body.sessionTitle || '',
      taskTitle: body.taskTitle || '',
    })
  }
  // Resolver NOMBRE REAL de la sesión (desde el DSH en disco) para anunciarlo y mostrarlo,
  // en lugar del genérico "session-" que manda el cliente
  const realName = body.sessionId ? displayName(body.sessionId, body.sessionTitle, body.source) : ''
  const cleanTask = pareceSessionId(body.taskTitle, body.sessionId) ? '' : tituloLimpio(cleanTitle(body.taskTitle))
  const cleanSess = pareceSessionId(body.sessionTitle, body.sessionId) ? '' : tituloLimpio(cleanTitle(body.sessionTitle))
  const resolvedTitle = cleanTask || cleanSess || realName || ''
  // La VOZ DE LA FUENTE prevalece: lo elegido en el panel gana sobre los
  // valores por defecto antiguos de esa fuente y sobre la asignación por sesión.
  const voice = (src?.voice || body.voice || sessions.getVoice(body.sessionId || ''))
  const request = {
    requestId: body.requestId || randomUUID(),
    source: body.source || 'unknown',
    sourceId: src?.id || body.source || 'unknown',
    sessionId: body.sessionId || '',
    sessionName: realName, // nombre REAL de la sesión (disco DSH) — se anuncia en el prefix
    sessionTitle: resolvedTitle || body.sessionTitle || '',
    taskTitle: resolvedTitle || body.taskTitle || '',
    voice,
    text: String(body.text || ''),
    priority: body.priority || 'normal',
    interventionId: body.interventionId,
    fragmentIndex: body.fragmentIndex ?? 0,
    totalFragments: body.totalFragments ?? 1,
    preview: esPreview,
  }
  if (!request.text.trim()) {
    return sendJson(res, 400, { ok: false, error: { code: 'no-text', message: 'text is required' } })
  }
  // Actividad real de la fuente (indicador de conexión del panel)
  if (!esPreview) sources.markSeen(body.source)
  const result = queue.enqueue(request)
  if (!result.ok) return sendJson(res, 429, { ok: false, error: result.error, requestId: result.requestId })
  sendJson(res, 202, { ok: true, ...result })
})

// ===================== PORTAPAPELES (Sprint 1) =====================
// Estado del modulo: activado/desactivado, atajo global y salud del watcher.
route('GET', '/api/v1/clipboard/status', (req, res) => {
  sendJson(res, 200, clipboard.getStatus())
})
// Activar/desactivar la captura (interruptor del panel).
route('POST', '/api/v1/clipboard/enabled', async (req, res) => {
  const body = await parseJsonBody(req)
  const r = clipboard.setEnabled(body.enabled === true || body.enabled === 'true')
  sendJson(res, r.ok ? 200 : 400, r)
})
// Alternar. Lo usa el atajo global Ctrl+Alt+R del watcher de Windows.
route('POST', '/api/v1/clipboard/toggle', async (req, res) => {
  const r = clipboard.toggle()
  sendJson(res, r.ok ? 200 : 400, r)
})
// El watcher de Windows reporta su estado (si el atajo pudo registrarse).
route('POST', '/api/v1/clipboard/watcher-status', async (req, res) => {
  const body = await parseJsonBody(req)
  const r = clipboard.setWatcherStatus(body)
  sendJson(res, 200, r)
})

// Cola
route('GET', '/api/v1/queue', (req, res) => {
  const items = queue.getQueue().map(u => ({ ...u, sessionName: u.sessionId ? displayName(u.sessionId, u.sessionTitle, u.source) : '' }))
  sendJson(res, 200, { ok: true, items, status: queue.getStatus() })
})

// Historial de locuciones procesadas (últimas N, más reciente primero) con nombre real de sesión
route('GET', '/api/v1/history', (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const limit = Math.max(1, Math.min(500, parseInt(url.searchParams.get('limit') || '50', 10) || 50))
  const items = queue.getHistory(limit).map(h => ({ ...h, sessionName: h.sessionId ? displayName(h.sessionId, h.sessionTitle, h.source) : '' }))
  sendJson(res, 200, { ok: true, items, total: (queue.history || []).length })
})

// Mapa sessionId → nombre real resuelto desde el DSH (para depurar el panel)
route('GET', '/api/v1/sessions/names', (req, res) => {
  sendJson(res, 200, { ok: true, count: dshTitles.size, names: Object.fromEntries(dshTitles.titles) })
})

// Replay de un elemento del historial: mode 'now' (interrumpe y reanuda después) o 'queue' (al final)
route('POST', '/api/v1/history/:requestId/replay', async (req, res, params) => {
  const item = (queue.history || []).find(h => h.requestId === params.requestId)
  if (!item) {
    return sendJson(res, 404, { ok: false, error: { code: 'not-found', message: 'Ese elemento ya no está en el historial (solo últimas 200 en memoria; el audio nunca se guarda)' } })
  }
  const body = await parseJsonBody(req)
  const mode = body.mode === 'now' ? 'now' : 'queue'
  const r = queue.enqueueReplay({
    text: item.text,
    source: item.source,
    sessionId: item.sessionId,
    sessionTitle: item.sessionTitle,
    taskTitle: item.taskTitle,
    voice: item.voice,
    mode,
    replayOf: item.requestId,
  })
  if (!r.ok) return sendJson(res, 400, { ok: false, error: { code: 'enqueue-failed', message: r.error } })
  sendJson(res, 200, { ok: true, mode, requestId: r.requestId, queuePosition: r.queuePosition, interrupted: r.interrupted || null, voice: item.voice })
})

// Botón ⏮ ANTERIOR: trae la locución previa ya reproducida (navega atrás en playLog; cada click = una más atrás)
let prevCursor = null
queue.on('playing', (u) => { if (!u.replayOf) prevCursor = null }) // locución nueva → resetear cursor
route('POST', '/api/v1/history/prev', async (req, res) => {
  const body = await parseJsonBody(req)
  const mode = body.mode === 'now' ? 'now' : 'queue'
  const log = queue.playLog || []
  if (prevCursor === null) prevCursor = log.length
  const idx = prevCursor - 1
  if (idx < 0 || !log[idx]) {
    return sendJson(res, 404, { ok: false, error: { code: 'no-previous', message: 'No hay locución anterior en el historial de reproducción' } })
  }
  prevCursor = idx
  const rid = log[idx]
  const item = (queue.history || []).find(h => h.requestId === rid) || [...queue.items.values()].find(u => u.requestId === rid)
  if (!item || !item.text) {
    return sendJson(res, 404, { ok: false, error: { code: 'not-found', message: 'La anterior ya no tiene texto en memoria' } })
  }
  const r = queue.enqueueReplay({
    text: item.text,
    source: item.source,
    sessionId: item.sessionId,
    sessionTitle: item.sessionTitle,
    taskTitle: item.taskTitle,
    voice: item.voice,
    mode,
    replayOf: rid,
  })
  if (!r.ok) return sendJson(res, 400, { ok: false, error: { code: 'enqueue-failed', message: r.error } })
  sendJson(res, 200, { ok: true, mode, requestId: r.requestId, queuePosition: r.queuePosition, interrupted: r.interrupted || null, voice: item.voice, replayOf: rid, remaining: idx })
})

// Playback controls
route('POST', '/api/v1/playback/pause', async (req, res) => {
  await player.pause()
  ttsPaused = true
  sendJson(res, 200, { ok: true, paused: true })
})
route('POST', '/api/v1/playback/resume', async (req, res) => {
  await player.resume()
  ttsPaused = false
  sendJson(res, 200, { ok: true, resumed: true })
})
route('POST', '/api/v1/playback/stop', async (req, res) => {
  const r = queue.stopCurrent()
  sendJson(res, 200, r)
})
route('POST', '/api/v1/playback/skip', async (req, res) => {
  const r = queue.skipCurrent()
  sendJson(res, 200, r)
})

// Volumen del reproductor (0-200, >100 = amplificación software)
route('GET', '/api/v1/playback/volume', async (req, res) => {
  const vol = await player.getVolume().catch(() => null)
  sendJson(res, 200, { ok: true, volume: vol, configured: config.player?.volume ?? 100 })
})
route('POST', '/api/v1/playback/volume', async (req, res) => {
  const body = await parseJsonBody(req)
  const v = Math.max(0, Math.min(600, parseInt(body.volume, 10)))
  if (isNaN(v)) return sendJson(res, 400, { ok: false, error: 'volume required (0-600)' })
  await player.setVolume(v)
  config.player.volume = v
  saveConfig({ player: { volume: v } })
  sendJson(res, 200, { ok: true, volume: v })
})

// Cancelar solicitud
route('DELETE', '/api/v1/queue/:requestId', (req, res, params) => {
  const r = queue.cancel(params.requestId)
  sendJson(res, r.ok ? 200 : 404, r)
})

// Mover una locución en la cola (flechitas ↑/↓ del panel)
route('POST', '/api/v1/queue/:requestId/move', async (req, res, params) => {
  const body = await parseJsonBody(req)
  const direction = String(body.direction || '').toLowerCase()
  if (direction !== 'up' && direction !== 'down') {
    return sendJson(res, 400, { ok: false, error: "direction debe ser 'up' o 'down'" })
  }
  const r = queue.moveInQueue(params.requestId, direction)
  sendJson(res, r.ok ? 200 : 404, r)
})

// Reproducir YA: la locución pasa al frente de la cola, se detiene la que esté
// sonando (si la hay) y empieza a sonar de inmediato.
route('POST', '/api/v1/queue/:requestId/play-now', async (req, res, params) => {
  const r = queue.playNow(params.requestId)
  sendJson(res, r.ok ? 200 : 404, r)
})

// Cancelar sesión completa
route('DELETE', '/api/v1/sessions/:sessionId/queue', (req, res, params) => {
  const r = queue.cancelSession(params.sessionId)
  sendJson(res, 200, r)
})

// Sesiones
route('GET', '/api/v1/sessions', (req, res) => {
  const list = sessions.getAllSessions().map(s => ({
    ...s,
    displayName: displayName(s.sessionId, s.displayTitle || s.title, s.source), // nombre REAL desde el DSH
  }))
  const qs = queue.getSessions().map(s => ({ ...s, displayName: s.sessionId ? displayName(s.sessionId, s.sessionTitle, s.source) : '' }))
  sendJson(res, 200, { ok: true, sessions: list, queueSessions: qs })
})

// Registrar/actualizar sesión
route('POST', '/api/v1/sessions', async (req, res) => {
  const body = await parseJsonBody(req)
  if (!body.sessionId) return sendJson(res, 400, { ok: false, error: 'sessionId required' })
  const s = sessions.registerSession(body.sessionId, body)
  sendJson(res, 200, { ok: true, session: s })
})

// Asignar voz a sesión
route('PUT', '/api/v1/sessions/:sessionId/voice', async (req, res, params) => {
  const body = await parseJsonBody(req)
  if (!body.voice) return sendJson(res, 400, { ok: false, error: 'voice required' })
  const r = sessions.setVoice(params.sessionId, body.voice)
  sendJson(res, 200, r)
})

// Config
route('GET', '/api/v1/config', (req, res) => {
  const cfg = getConfig()
  // No exponer datos sensibles
  const safe = JSON.parse(JSON.stringify(cfg))
  sendJson(res, 200, { ok: true, config: safe })
})
route('PUT', '/api/v1/config', async (req, res) => {
  const body = await parseJsonBody(req)
  try {
    const updated = saveConfig(body.config || body)
    sendJson(res, 200, { ok: true, config: updated })
  } catch (e) {
    sendJson(res, 400, { ok: false, error: e.message })
  }
})

// ===== Multimedia ducking configurable por app =====
route('GET', '/api/v1/multimedia/status', async (req, res) => {
  sendJson(res, 200, { ok: true, ...(await multimedia.getAppStatus()) })
})
route('GET', '/api/v1/multimedia/sessions', async (req, res) => {
  sendJson(res, 200, await multimedia.listAudioSessions())
})
// Actualizar política de una app (mode: pause|reduce|ignore, percentage 0-100) — persiste en config
route('PUT', '/api/v1/multimedia/apps/:appKey', async (req, res, params) => {
  const body = await parseJsonBody(req)
  // Compatibilidad: "youtube" y "chrome" son el mismo control → "navegador"
  const appKey = (params.appKey === 'youtube' || params.appKey === 'chrome') ? 'navegador' : params.appKey
  const mode = body.mode
  if (!['pause', 'reduce', 'ignore'].includes(mode)) {
    return sendJson(res, 400, { ok: false, error: "mode debe ser 'pause' | 'reduce' | 'ignore'" })
  }
  const pct = Math.max(0, Math.min(100, parseInt(body.percentage ?? 0, 10)))
  if (isNaN(pct)) return sendJson(res, 400, { ok: false, error: 'percentage 0-100 requerido' })
  // "reducir 0%" ES "ignorar": se persiste como tal para que la config nunca
  // quede con un modo ambiguo (reducir 0) que el panel muestra como si bajara.
  const modoFinal = (mode === 'reduce' && pct === 0) ? 'ignore' : mode
  const pctFinal = modoFinal === 'reduce' ? pct : 0
  const cfg = getConfig()
  if (!cfg.multimedia) cfg.multimedia = {}
  if (!cfg.multimedia.applications) cfg.multimedia.applications = {}
  const existing = cfg.multimedia.applications[appKey] || {}
  cfg.multimedia.applications[appKey] = { ...existing, mode: modoFinal, percentage: pctFinal }
  if (body.processNames) cfg.multimedia.applications[appKey].processNames = body.processNames
  if (body.matchUrl !== undefined) cfg.multimedia.applications[appKey].matchUrl = body.matchUrl
  if (body.pauseSupported !== undefined) cfg.multimedia.applications[appKey].pauseSupported = body.pauseSupported
  const updated = saveConfig(cfg)
  config.multimedia = updated.multimedia // aplicar en caliente
  sendJson(res, 200, { ok: true, app: updated.multimedia.applications[appKey] })
})
// Restaurar ahora (forzar fin de ducking)
route('POST', '/api/v1/multimedia/restore', async (req, res) => {
  await multimedia.restoreVolumes()
  sendJson(res, 200, { ok: true })
})
// "Subir al 100" de una app concreta. Deja el 100 como volumen original, para
// que la siguiente atenuación parta del 100 y no se encadene sobre un valor
// que ya estaba bajo (el caso de Chrome, que llegó a estar en 1%).
route('POST', '/api/v1/multimedia/volume-reset', async (req, res) => {
  const body = await parseJsonBody(req)
  const raw = String(body.appKey || body.app || '')
  const appKey = (raw === 'youtube' || raw === 'chrome') ? 'navegador' : raw
  if (!appKey) return sendJson(res, 400, { ok: false, error: 'falta appKey' })
  try {
    const r = await multimedia.resetAppVolume(appKey)
    sendJson(res, r.ok ? 200 : 400, r)
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e.message })
  }
})

// Voces disponibles
route('GET', '/api/v1/voices', async (req, res) => {
  try {
    // Catálogo COMPLETO (todos los idiomas) con género, país e identificador.
    const catalog = await synthesizer.listVoiceCatalog()
    const spanish = catalog.filter(v => v.spanish)
    sendJson(res, 200, {
      ok: true,
      catalog,
      spanishVoices: spanish.map(v => v.id), // compatibilidad con clientes previos
      female: catalog.filter(v => /^female$/i.test(v.gender)).map(v => v.id),
      male: catalog.filter(v => /^male$/i.test(v.gender)).map(v => v.id),
      // Voces destacadas: casting original de Ciudadan (comparadores CDR)
      featured: config.voices?.featured || { female: [], male: [] },
      count: catalog.length,
      assignments: sessions.getAllAssignments(),
    })
  } catch (e) {
    sendJson(res, 200, { ok: true, spanishVoices: [], catalog: [], error: e.message, assignments: sessions.getAllAssignments() })
  }
})

// Muestra de una voz: usa el MISMO motor y reproductor (no hay TTS paralelo).
// Se encola con prioridad normal: NO interrumpe las locuciones de otros agentes.
route('POST', '/api/v1/voices/preview', async (req, res) => {
  const body = await parseJsonBody(req)
  const voice = String(body.voice || '')
  if (!voice) return sendJson(res, 400, { ok: false, error: { code: 'no-voice', message: 'voice requerida' } })
  // La muestra dice QUÉ voz es: el nombre legible de la voz (no solo el id).
  // Si el cliente no manda texto, se arma aquí: "Esta es una muestra de la voz X".
  let texto = String(body.text || '').trim()
  let nombreVoz = String(body.voiceName || '').trim()
  if (!nombreVoz) {
    // Buscar el nombre en el catálogo (id -> nombre legible).
    try {
      const cat = await synthesizer.listVoiceCatalog()
      const hit = (cat || []).find(v => v.id === voice)
      if (hit && hit.name) nombreVoz = hit.name
    } catch { /* si no hay catálogo, se usa el id */ }
  }
  if (!texto) {
    texto = nombreVoz
      ? ('Esta es una muestra de la voz ' + nombreVoz + '.')
      : ('Esta es una muestra de la voz seleccionada.')
  }
  const result = queue.enqueue({
    requestId: randomUUID(),
    source: 'preview',
    sourceId: 'preview',
    sessionId: '',
    sessionName: '',           // sin anuncio de sesión
    sessionTitle: 'Muestra de voz',
    taskTitle: '',
    voice,
    text: texto,
    priority: 'normal',
    preview: true,
  })
  if (!result.ok) return sendJson(res, 429, { ok: false, error: result.error, requestId: result.requestId })
  sendJson(res, 202, { ok: true, ...result, voice, voiceName: nombreVoz || voice, text: texto })
})

// --- Fuentes de voz (agentes/servicios) ---
route('GET', '/api/v1/sources', (req, res) => {
  sendJson(res, 200, { ok: true, sources: sources.list() })
})
route('PUT', '/api/v1/sources/:id', async (req, res, params) => {
  const body = await parseJsonBody(req)
  const actual = sources.get(params.id)
  if (!actual) {
    return sendJson(res, 404, { ok: false, error: { code: 'not-found', message: 'Fuente de voz desconocida' } })
  }
  let stopped = null
  if (body.enabled !== undefined) {
    const antes = actual.enabled !== false
    const ahora = !!body.enabled
    const src = sources.setEnabled(params.id, ahora)
    // Si se desactiva una fuente que está hablando: detener SOLO esa reproducción.
    if (antes && !ahora) stopped = queue.stopCurrentIfSource(src.id)
  }
  if (body.voice) {
    const src = sources.setVoice(params.id, body.voice)
    // La voz de la fuente prevalece sobre las asignaciones antiguas por sesión.
    sessions.setVoiceForSource(src.id, src.voice, src.aliases)
  }
  const updated = sources.list().find(s => s.id === sources.get(params.id).id)
  sendJson(res, 200, { ok: true, source: updated, stopped })
})

// OpenAI-compatible endpoint (genera audio pero NO coordina reproducción)
route('POST', '/v1/audio/speech', async (req, res) => {
  const body = await parseJsonBody(req)
  const text = String(body.input || body.text || '')
  if (!text) return sendJson(res, 400, { error: { message: 'input required', type: 'invalid_request' } })
  const voice = body.voice || config.voices?.default
  try {
    const result = await synthesizer.synthesize(text, { voice })
    res.writeHead(200, {
      'Content-Type': result.mime,
      'Content-Length': result.audio.length,
    })
    res.end(result.audio)
  } catch (e) {
    sendJson(res, 500, { error: { message: e.message, type: 'server_error' } })
  }
})

// Panel de control web (HTML simple)
route('GET', '/', (req, res) => {
  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>Ciudadan TTS Coordinator</title>
<style>
  body { font-family: system-ui, sans-serif; background: #1a1a2e; color: #eee; max-width: 900px; margin: 0 auto; padding: 20px; }
  h1 { color: #e94560; }
  .card { background: #16213e; border-radius: 8px; padding: 16px; margin: 12px 0; }
  .status-repro { color: #0f0; } .status-idle { color: #888; } .status-paused { color: #ffb300; }
  button { background: #e94560; color: #fff; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; margin: 4px; }
  button:hover { background: #ff6b6b; }
  button.secondary { background: #0f3460; }
  table { width: 100%; border-collapse: collapse; }
  td, th { padding: 6px 10px; text-align: left; border-bottom: 1px solid #333; }
  .bar { height: 20px; background: #0f3460; border-radius: 10px; position: relative; margin: 4px 0; }
  .bar > div { height: 100%; background: #e94560; border-radius: 10px; }
  label { display: inline-block; min-width: 120px; }
  input[type=range] { width: 200px; }
  .queue-item { padding: 6px 8px; margin: 3px 0; background: #0f3460; border-radius: 4px; font-size: 0.9em; }
  .qbtn { display:inline-block; cursor:pointer; user-select:none; padding:0 4px; border-radius:4px;
          background:#1b4b7a; color:#fff; font-size:13px; line-height:18px; }
  .qbtn:hover { background:#e94560; }
  .qbtn.qplay { background:#2e7d32; }
  .qbtn.qplay:hover { background:#43a047; }
  .qbtn.qoff { opacity:.3; cursor:default; }
  .qbtn.qoff:hover { background:#1b4b7a; }
  .qpos { color:#8fa3c8; font-size:11px; }
  .qtext { font-size:11px; color:#b8c6e0; margin-top:3px; max-width:100%; overflow:hidden;
           text-overflow:ellipsis; white-space:nowrap; }
  .cfg-tabs { display:flex; gap:6px; margin-bottom:10px; border-bottom:1px solid #333; padding-bottom:8px; }
  .cfg-tabs button { margin:0; padding:6px 12px; font-size:13px; }
  .cfg-tabs button.on { background:#e94560; }
  .cfg-pane { display:none; }
  .cfg-pane.on { display:block; }
  #cfgOverlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.65); z-index: 10; }
  #cfgPanel { background: #16213e; border-radius: 10px; max-width: 660px; margin: 50px auto; padding: 20px; max-height: 82vh; overflow: auto; box-shadow: 0 8px 30px rgba(0,0,0,.6); }
  .cfg-app { border-bottom: 1px solid #333; padding: 8px 0; }
  .cfg-app label { min-width: 0; margin-right: 10px; }
  #voiceOverlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.65); z-index: 12; }
  #voicePanel { background: #16213e; border-radius: 10px; max-width: 720px; margin: 40px auto; padding: 20px; max-height: 86vh; overflow: auto; box-shadow: 0 8px 30px rgba(0,0,0,.6); }
  #voiceList > div:hover { background: #0f3460; }
  .src-chip { font-size: 10px; color: #888; }
</style>
</head>
<body>
<h1>🎙️ CIUDADAN TTS COORDINATOR</h1>
<div class="card">
  <strong>ESTADO:</strong> <span id="status" class="status-idle">CARGANDO…</span><br>
  <span id="current"></span>
</div>
<div class="card">
  <button id="btnPause" onclick="togglePause()">⏸ PAUSAR</button>
  <button onclick="ctrl('stop')">⏹ DETENER</button>
  <button onclick="prevReplay()">⏮ ANTERIOR</button>
  <button onclick="ctrl('skip')">⏭ SIGUIENTE</button>
  <button class="secondary" onclick="openCfg()" title="Configurar volumen y acciones">⚙️</button>
</div>
<div class="card">
  <h3>📋 Portapapeles de Windows</h3>
  <p style="font-size:11px;color:#888;margin:0 0 6px">
    Lee en voz alta lo que copias. Usa el evento nativo de Windows (sin sondeo).
    Copiar un texto nuevo reemplaza solo la lectura anterior del portapapeles.
  </p>
  <label style="font-size:13px">
    <input type="checkbox" id="clipOn" onchange="toggleClipboard(this.checked)">
    <b>Leer portapapeles</b>
  </label>
  <span id="clipState" style="font-size:12px;margin-left:8px;color:#888">…</span>
  <div id="clipHotkey" style="font-size:11px;color:#888;margin-top:4px"></div>
  <div id="clipWarn" style="font-size:11px;color:#ffb300;margin-top:6px;display:none">
    ⚠️ El portapapeles puede contener contraseñas, tokens o datos privados. Lo que copies se
    enviará al sintetizador TTS local y <b>no</b> se guardará en el historial. Puedes desactivar
    esta función en cualquier momento con <b>Ctrl+Alt+R</b>.
  </div>
</div>
<div class="card">
  <h3>Cola: <span id="queueLen">0</span> solicitudes</h3>
  <div id="queue"></div>
</div>
<div class="card">
  <h3>📜 Historial de locuciones reproducidas <span id="flash" style="font-weight:normal;font-size:12px;color:#4caf50"></span></h3>
  <p style="font-size:11px;color:#888">El audio NO se guarda — solo el texto en memoria. ▶ = reproducir AHORA (pausa la cola y la reanuda al terminar). ➕ = agregar de nuevo al final de la cola.</p>
  <table id="history"><tr><th>Hora</th><th>Agente</th><th>Sesión</th><th>Voz</th><th>Estado</th><th>Dur.</th><th>Texto</th><th>Replay</th></tr></table>
</div>
<div class="card">
  <h3>Agentes registrados</h3>
  <table id="sessions"><tr><th>Fuente</th><th>Sesión</th><th>Voz</th></tr></table>
</div>
<div class="card">
  <h3>🎛️ Ducking por aplicación <small>(persistente)</small></h3>
  <div id="mmStatus" style="font-size:12px;color:#888;margin-bottom:6px"></div>
  <div id="mmWarn" style="display:none;margin-bottom:6px"></div>
  <table id="mmApps"><tr><th>Aplicación</th><th>Modo</th><th>% reducción</th><th>Volumen actual</th><th>Estado ducking</th><th></th></tr></table>
  <div style="font-size:11px;color:#888;margin-top:6px">
    Modos: <b>Pausar</b> (solo apps con pausa selectiva, ej. YouTube), <b>Reducir</b> (0-100% respecto al volumen original de la app), <b>Ignorar</b>.<br>
    No se toca el volumen maestro de Windows ni la voz del coordinador (mpv). Los cambios manuales tuyos se respetan al restaurar.
  </div>
  <div style="margin-top:8px">
    Volumen TTS (mpv): <b id="ttsVolNow">—</b>%
    <span style="font-size:11px;color:#888">(cambia con ⚙️ en la barra de controles)</span>
  </div>
</div>
<div id="cfgOverlay" onclick="if(event.target===this)closeCfg()">
  <div id="cfgPanel">
    <h3 style="margin-top:0">⚙️ Configuración</h3>
    <div class="cfg-tabs">
      <button id="cfgTabApps" onclick="cfgTab('apps')">🔊 Volumen y apps</button>
      <button id="cfgTabSources" onclick="cfgTab('sources')">🎙️ Fuentes de voz</button>
    </div>
    <div class="cfg-pane" id="cfgPaneApps">
      <div style="font-size:11px;color:#888;margin-bottom:8px">Ajusta todo y pulsa <b>💾 Guardar</b>: se aplica de inmediato y esta ventana se cierra sola. Este modal NO se refresca solo.</div>
      <div id="cfgBody"></div>
      <hr style="border-color:#333">
      <label>Volumen del coordinador (mpv, 0–600): <input type="range" id="ttsVol" min="0" max="600" value="100" oninput="document.getElementById('ttsVal').textContent=this.value"> <span id="ttsVal">100</span>%</label>
    </div>
    <div class="cfg-pane" id="cfgPaneSources">
      <div style="font-size:11px;color:#888;margin-bottom:8px">Desmarca una fuente para silenciar sus locuciones (no afecta al agente ni a las demás fuentes). La voz elegida aquí prevalece sobre los valores por defecto.</div>
      <table id="sources"><tr><th>Activa</th><th>Fuente</th><th>Estado</th><th>Voz</th><th></th></tr></table>
    </div>
    <div style="margin-top:8px">
      <button id="cfgSave" onclick="saveAll()">💾 Guardar</button>
      <button class="secondary" onclick="forceRestore()">↩ Restaurar audio ahora</button>
      <button class="secondary" style="float:right" onclick="closeCfg()">✖ Cerrar</button>
    </div>
  </div>
</div>
<div id="voiceOverlay" onclick="if(event.target===this)closeVoicePicker()">
  <div id="voicePanel">
    <h3 style="margin-top:0">🎙️ Seleccionar voz</h3>
    <div class="src-chip" id="voiceTarget" style="margin-bottom:8px"></div>
    <div style="margin-bottom:8px">
      <button class="secondary" id="tabFemale" onclick="setVoiceCategory('female')">👩 Femeninas</button>
      <button class="secondary" id="tabMale" onclick="setVoiceCategory('male')">👨 Masculinas</button>
      <span class="src-chip" id="voiceCount" style="margin-left:8px"></span>
    </div>
    <input id="voiceSearch" placeholder="Buscar por nombre, país o identificador (ej. Dalia, es-MX, Salome)" oninput="renderVoiceList()" style="width:100%;box-sizing:border-box;padding:6px;margin-bottom:8px;background:#0f3460;color:#eee;border:1px solid #333;border-radius:4px">
    <div id="voiceList"></div>
    <div style="margin-top:10px;text-align:right"><button class="secondary" onclick="closeVoicePicker()">✖ Cerrar</button></div>
  </div>
</div>
<script>
const TOKEN = '${token}';
async function api(path, opts = {}) {
  opts.headers = { ...(opts.headers||{}), 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };
  const r = await fetch(path, opts);
  return r.json();
}
async function refresh() {
  try {
    const s = await api('/api/v1/status');
    const el = document.getElementById('status');
    if (s.speaking && s.paused) { el.textContent = '⏸ PAUSADO'; el.className = 'status-paused'; }
    else if (s.speaking) { el.textContent = '🔊 REPRODUCIENDO'; el.className = 'status-repro'; }
    else { el.textContent = '💤 EN ESPERA'; el.className = 'status-idle'; }
    // Botón alternado pausar/reanudar
    const bp = document.getElementById('btnPause');
    if (bp) {
      if (s.paused) { bp.textContent = '▶ REANUDAR'; bp.style.background = '#2e7d32'; }
      else { bp.textContent = '⏸ PAUSAR'; bp.style.background = '#e65100'; }
    }
    if (s.current) {
      document.getElementById('current').innerHTML =
        'Agente: <b>' + esc(s.current.source) + '</b> | Sesión: <b>' + esc(s.current.sessionName || s.current.sessionTitle || s.current.sessionId) + '</b> | Voz: <b>' + esc(s.current.voice) + '</b>';
    } else document.getElementById('current').textContent = '';
    document.getElementById('queueLen').textContent = s.queueLength || 0;
  } catch (e) { console.warn('status falló', e); }
  try {
    const q = await api('/api/v1/queue');
    document.getElementById('queue').innerHTML = (q.items||[]).filter(i=>['queued','synthesizing','ready','playing'].includes(i.status))
      .map((i, idx, arr) => {
        const texto = i.text || i.textPreview || '';
        const corto = texto.length > 90 ? texto.slice(0,90) + '…' : texto;
        const up = idx > 0 ? '' : ' qoff';
        const down = idx < arr.length - 1 ? '' : ' qoff';
        const play = (i.status === 'playing') ? '' :
          '<span class="qbtn qplay" title="Reproducir AHORA: pasa al frente de la cola, detiene la locución actual y suena de inmediato" data-q="' + esc(i.requestId) + '" onclick="playNow(this)">▶</span> ';
        return '<div class="queue-item">' +
          '<span class="qbtn' + up + '" title="Subir en la cola" data-q="' + esc(i.requestId) + '" data-dir="up" onclick="moveQueue(this)">▲</span> ' +
          '<span class="qbtn' + down + '" title="Bajar en la cola" data-q="' + esc(i.requestId) + '" data-dir="down" onclick="moveQueue(this)">▼</span> ' +
          play +
          '<span class="qpos">' + (idx + 1) + '.</span> ' +
          '[' + esc(i.status) + '] ' + esc(i.source) + ' — ' + esc(i.sessionName || i.sessionTitle || i.sessionId) + ' (' + esc(i.voice) + ')' +
          '<div class="qtext" title="' + esc(texto) + '">' + esc(corto) + '</div>' +
          '</div>';
      }).join('') || '<i>vacía</i>';
  } catch (e) { console.warn('queue falló', e); }
  try {
    const sess = await api('/api/v1/sessions');
    document.getElementById('sessions').innerHTML = '<tr><th>Fuente</th><th>Sesión</th><th>Voz</th></tr>' +
      (sess.sessions||[]).map(s => '<tr><td>'+esc(s.source)+'</td><td>'+esc(s.displayName || s.title || s.displayTitle || s.sessionId)+'</td><td>'+esc(s.voice)+'</td></tr>').join('');
  } catch (e) { console.warn('sessions falló', e); }
  try {
    const h = await api('/api/v1/history?limit=30');
    window.__hist = h.items || [];
    document.getElementById('history').innerHTML = '<tr><th>Hora</th><th>Agente</th><th>Sesión</th><th>Voz</th><th>Estado</th><th>Dur.</th><th>Texto</th><th>Replay</th></tr>' +
      (h.items||[]).map((i, idx) => {
        const hora = i.finishedAt ? new Date(i.finishedAt).toLocaleTimeString('es-MX') : (i.createdAt ? new Date(i.createdAt).toLocaleTimeString('es-MX') : '');
        const dur = i.durationMs != null ? (i.durationMs/1000).toFixed(1)+'s' : '—';
        const estado = i.status === 'done' ? '✅' : (i.status === 'error' ? '❌' : '⏹');
        return '<tr><td>'+hora+'</td><td>'+esc(i.source)+'</td><td>'+esc(i.sessionName || i.sessionTitle || i.sessionId||'')+'</td><td>'+esc(i.voice)+'</td><td>'+estado+'</td><td>'+dur+'</td><td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(i.textPreview||'')+'">'+esc(i.textPreview||'')+'</td><td style="white-space:nowrap"><button data-hidx="'+idx+'" data-mode="now" onclick="replayHist(this.dataset.hidx, this.dataset.mode)" title="Reproducir AHORA (pausa la cola y la reanuda)">▶</button> <button data-hidx="'+idx+'" data-mode="queue" onclick="replayHist(this.dataset.hidx, this.dataset.mode)" title="Agregar de nuevo al final de la cola">➕</button></td></tr>';
      }).join('');
  } catch (e) { console.warn('history falló', e); }
  try { await refreshClipboard(); } catch (e) { console.warn('clipboard falló', e); }
  await refreshMultimedia();
}
async function replayHist(i, mode) {
  const it = (window.__hist || [])[Number(i)];
  if (!it || !it.text) { flash('⚠️ ese elemento no tiene texto'); return }
  try {
    const r = await api('/api/v1/history/' + encodeURIComponent(it.requestId) + '/replay', { method: 'POST', body: JSON.stringify({ mode }) });
    if (r.ok) flash((mode === 'now' ? '▶ reproduciendo AHORA' : '➕ encolado') + ' (posición ' + (r.queuePosition ?? '?') + ', voz ' + r.voice + ')' + (r.interrupted ? ' — se reanudará lo interrumpido' : ''));
    else flash('❌ ' + (r.error?.message || r.error || 'falló'));
  } catch (e) { flash('❌ ' + e.message) }
}
let __flashTimer = null;
function flash(msg) {
  const f = document.getElementById('flash');
  if (f) f.textContent = msg;
  if (__flashTimer) clearTimeout(__flashTimer);
  __flashTimer = setTimeout(() => { const f2 = document.getElementById('flash'); if (f2) f2.textContent = ''; }, 4000);
}
function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
// NOTA: esta tabla es SOLO LECTURA y se refresca cada 2s. Los controles editables
// (modo/% por app, volumen TTS, restaurar) viven en el modal #cfgOverlay (openCfg),
// que el refresh NUNCA toca — así se puede arrastrar/cambiar sin que se re-renderice.
async function refreshMultimedia() {
  const m = await api('/api/v1/multimedia/status');
  document.getElementById('mmStatus').textContent =
    'Puente de audio: ' + (m.audioBridgeAvailable ? '✅ activo' : '⚠️ no disponible (stub)') +
    ' | Ducking activo: ' + (m.active ? '🔊 SÍ' : 'no') +
    ' | Excluidos: ' + (m.excludedProcesses||[]).join(', ');
  // Avisos de conflicto (p.ej. dos apps sobre el mismo proceso de audio)
  const warnBox = document.getElementById('mmWarn');
  if (warnBox) {
    const cs = m.conflicts || [];
    warnBox.innerHTML = cs.length
      ? cs.map(c => '<div style="background:#3a2a12;border:1px solid #8a5a12;padding:6px 8px;border-radius:6px;margin-bottom:4px">⚠️ ' + esc(c.message) + '</div>').join('')
      : '';
    warnBox.style.display = cs.length ? 'block' : 'none';
  }
  const rows = ['<tr><th>Aplicación</th><th>Modo</th><th>% reducción</th><th>Volumen actual</th><th>Estado ducking</th><th></th></tr>'];
  for (const a of (m.apps||[])) {
    const vols = a.detectedSessions.map(s => s.process + '(' + s.pid + '): ' + s.volume + '%').join(', ') || '—';
    const modeLabel = a.mode === 'pause' ? '⏸ Pausar' : (a.mode === 'reduce' ? '🔻 Reducir' : '🚫 Ignorar');
    let duck = '—';
    if (a.ducking.active) {
      if (a.mode === 'reduce') duck = '🔻 ducking ' + a.ducking.duckedCount + ' sesión(es)';
      else {
        const t = a.ducking.pausedTabs || 0, sm = a.ducking.pausedMedia || 0;
        duck = '⏸ pausado ' + (t + sm) + (a.ducking.pauseMethod === 'gsmtc' ? ' (GSMTC)' : ' (CDP)');
      }
    }
    const pauseNote = (a.mode==='pause' && !a.pauseSupported) ? ' ⚠️ no admite pausa selectiva' : '';
    rows.push('<tr>' +
      '<td><b>' + esc(a.label || a.appKey) + '</b>' + pauseNote + '</td>' +
      '<td>' + modeLabel + '</td>' +
      '<td>' + a.percentage + '%</td>' +
      '<td style="font-size:11px">' + esc(vols) + '</td>' +
      '<td>' + esc(duck) + (a.ducking.stub ? ' (stub)' : '') + '</td>' +
      '<td><button class="secondary" data-app="' + esc(a.appKey) + '" onclick="openCfg(this.dataset.app)">⚙️</button></td>' +
      '</tr>');
  }
  document.getElementById('mmApps').innerHTML = rows.join('');
  // Volumen TTS como texto read-only (el slider editable está en el modal)
  if (!__cfgOpen) {
    try {
      const v = await api('/api/v1/playback/volume');
      if (v && v.volume !== undefined) document.getElementById('ttsVolNow').textContent = v.volume;
    } catch {}
  }
}
var __cfgOpen = false;
var __cfgApps = [];
var __cfgTab = 'apps';
// Cambiar de pestaña NO reconstruye el DOM: solo cambia qué panel se ve.
// Así el modal no se "traba" ni se pierde lo que el usuario esté adjusting.
function cfgTab(which) {
  __cfgTab = (which === 'sources') ? 'sources' : 'apps';
  const apps = document.getElementById('cfgPaneApps');
  const srcs = document.getElementById('cfgPaneSources');
  if (apps) apps.classList.toggle('on', __cfgTab === 'apps');
  if (srcs) srcs.classList.toggle('on', __cfgTab === 'sources');
  const b1 = document.getElementById('cfgTabApps');
  const b2 = document.getElementById('cfgTabSources');
  if (b1) b1.classList.toggle('on', __cfgTab === 'apps');
  if (b2) b2.classList.toggle('on', __cfgTab === 'sources');
  // En "Fuentes de voz" los cambios se aplican al instante: no hay nada que guardar.
  const save = document.getElementById('cfgSave');
  if (save) save.style.display = (__cfgTab === 'apps') ? '' : 'none';
  // Las fuentes se piden al abrir la pestaña (no antes): menos trabajo al abrir.
  if (__cfgTab === 'sources') refreshSources();
}
async function openCfg(focusApp, tab) {
  __cfgOpen = true;
  document.getElementById('cfgOverlay').style.display = 'block';
  cfgTab(tab || __cfgTab || 'apps');
  try {
    const m = await api('/api/v1/multimedia/status');
    const rows = [];
    __cfgApps = [];
    for (const a of (m.apps||[])) {
      __cfgApps.push(a.appKey);
      rows.push('<div class="cfg-app">' +
        '<b>' + esc(a.label || a.appKey) + '</b>' +
        (a.appKey === 'navegador' ? ' <span style="color:#888;font-size:11px">(YouTube y Chrome son el mismo proceso de audio: un solo control)</span>' : '') +
        (a.mode==='pause' && !a.pauseSupported ? ' <span style="color:#ffb300">⚠️ no admite pausa selectiva</span>' : '') + '<br>' +
        '<label>Modo: <select id="cfgmode-' + esc(a.appKey) + '">' +
          '<option value="pause"' + (a.mode==='pause'?' selected':'') + '>Pausar (reanuda al terminar)</option>' +
          '<option value="reduce"' + (a.mode==='reduce'?' selected':'') + '>Reducir</option>' +
          '<option value="ignore"' + (a.mode==='ignore'?' selected':'') + '>Ignorar</option></select></label>' +
        '<label>% reducción: <input type="range" id="cfgpct-' + esc(a.appKey) + '" data-pct="cfgpctv-' + esc(a.appKey) + '" min="0" max="100" value="' + a.percentage + '" style="width:120px" oninput="document.getElementById(this.dataset.pct).textContent=this.value"> <span id="cfgpctv-' + esc(a.appKey) + '">' + a.percentage + '</span>%</label>' +
        '<br><button type="button" class="cfg-vol100" data-app="' + esc(a.appKey) + '" onclick="vol100(this.dataset.app)">🔊 Subir al 100 ahora</button>' +
        '<span style="color:#888;font-size:11px"> (deja el 100 como volumen original)</span>' +
        '</div>');
    }
    document.getElementById('cfgBody').innerHTML = rows.join('');
    const v = await api('/api/v1/playback/volume');
    if (v && v.volume !== undefined) {
      const tv = document.getElementById('ttsVol');
      tv.value = v.volume; document.getElementById('ttsVal').textContent = v.volume;
    }
    if (focusApp) { const el = document.getElementById('cfgmode-' + focusApp); if (el) el.focus(); }
  } catch (e) { console.warn('openCfg falló', e); }
  // Las fuentes se actualizan al abrir el modal (tab de fuentes): la tabla queda al día.
  try { __sourcesSig = ''; await refreshSources(); } catch (e) { /* noop */ }
}
function closeCfg() { __cfgOpen = false; document.getElementById('cfgOverlay').style.display = 'none'; }
// "Subir al 100": pone al 100 el volumen de esa app y deja ese 100 como
// original, para que la próxima atenuación no se encadene sobre un valor bajo.
async function vol100(appKey) {
  try {
    const r = await api('/api/v1/multimedia/volume-reset', { method: 'POST', body: JSON.stringify({ appKey: appKey }) });
    if (r && r.ok) {
      const n = (r.restored || []).length;
      flash('🔊 ' + (appKey === 'navegador' ? 'Navegador' : appKey) + ': volumen al 100' + (n ? ' (' + n + ' sesión/es)' : ' (sin sesiones activas)'));
      await refresh();
    } else {
      flash('❌ ' + (r?.error || 'no se pudo restaurar'));
    }
  } catch (e) { flash('❌ ' + e.message) }
}
async function forceRestore() { await api('/api/v1/multimedia/restore', { method: 'POST' }); refresh(); }
async function ctrl(action) { await api('/api/v1/playback/' + action, { method: 'POST' }); refresh(); }
// --- Cola: mover con flechitas y "reproducir ya" ---
async function moveQueue(el) {
  const id = el && el.dataset ? el.dataset.q : '';
  const dir = el && el.dataset ? el.dataset.dir : '';
  if (!id || !dir) return;
  try {
    const r = await api('/api/v1/queue/' + encodeURIComponent(id) + '/move', {
      method: 'POST', body: JSON.stringify({ direction: dir })
    });
    if (r && r.ok === false) flash('⚠️ ' + (r.error || 'no se pudo mover'));
    else flash((dir === 'up' ? '▲ movida arriba' : '▼ movida abajo') + ' (posición ' + (r.position ?? '?') + ')');
  } catch (e) { flash('❌ ' + e.message) }
  await refresh();
}
async function playNow(el) {
  const id = el && el.dataset ? el.dataset.q : '';
  if (!id) return;
  try {
    const r = await api('/api/v1/queue/' + encodeURIComponent(id) + '/play-now', { method: 'POST' });
    if (r && r.ok === false) flash('⚠️ ' + (r.error || 'no se pudo reproducir'));
    else flash('▶ reproduciendo AHORA' + (r.stopped ? ' (se detuvo la locución anterior)' : ''));
  } catch (e) { flash('❌ ' + e.message) }
  await refresh();
}
// Pausa/reanudacion: un toggle por pulsacion. Sin este candado, un doble clic
// (50 ms) hacia DOS toggles concurrentes: ambos leian paused=false y ambos
// pausaban -> el TTS quedaba mudo para siempre con el boton en "REANUDAR".
var __pauseBusy = false;
async function togglePause() {
  if (__pauseBusy) return;
  __pauseBusy = true;
  const bp = document.getElementById('btnPause');
  if (bp) bp.disabled = true;
  try {
    const s = await api('/api/v1/status');
    if (s.paused) await api('/api/v1/playback/resume', { method: 'POST' });
    else await api('/api/v1/playback/pause', { method: 'POST' });
    await refresh();
  } catch (e) {
    flash('❌ ' + e.message);
  } finally {
    __pauseBusy = false;
    const b2 = document.getElementById('btnPause');
    if (b2) b2.disabled = false;
  }
}
async function prevReplay() {
  try {
    const r = await api('/api/v1/history/prev', { method: 'POST', body: JSON.stringify({ mode: 'now' }) });
    if (r.ok) flash('⏮ anterior AHORA — voz ' + r.voice + (r.remaining > 0 ? ' (quedan ' + r.remaining + ' más atrás)' : ' (llegaste al inicio)'));
    else flash('❌ ' + (r.error?.message || 'no hay anterior'));
  } catch (e) { flash('❌ ' + e.message) }
  await refresh();
}
async function saveAll() {
  const btn = document.getElementById('cfgSave');
  if (btn) { btn.disabled = true; btn.textContent = '💾 Guardando…'; }
  try {
    // 1) Volumen del coordinador (mpv)
    const v = +document.getElementById('ttsVol').value;
    const vr = await api('/api/v1/playback/volume', { method: 'POST', body: JSON.stringify({ volume: v }) });
    if (vr && vr.ok === false) throw new Error(vr.error || 'volumen no guardado');
    // 2) Modo y % de cada aplicación del modal
    const errores = [];
    for (const key of (__cfgApps || [])) {
      const sel = document.getElementById('cfgmode-' + key);
      const pctEl = document.getElementById('cfgpct-' + key);
      if (!sel) continue;
      const mode = sel.value;
      const pct = pctEl ? +pctEl.value : 0;
      const r = await api('/api/v1/multimedia/apps/' + key, { method: 'PUT', body: JSON.stringify({ mode, percentage: pct }) });
      if (!r || r.ok === false) errores.push(key + ': ' + ((r && r.error) || 'error'));
    }
    document.getElementById('ttsVal').textContent = v;
    document.getElementById('ttsVolNow').textContent = v;
    if (errores.length) {
      flash('⚠️ Guardado parcial: ' + errores.join(' | '));
    } else {
      flash('💾 Configuración guardada');
    }
    closeCfg();            // el modal se cierra solo tras guardar
    refresh();
  } catch (e) {
    flash('❌ Error al guardar: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '💾 Guardar'; }
  }
}
async function saveVol() {
  const v = +document.getElementById('ttsVol').value;
  await api('/api/v1/playback/volume', { method: 'POST', body: JSON.stringify({ volume: v }) });
  document.getElementById('ttsVal').textContent = v;
  document.getElementById('ttsVolNow').textContent = v;
  flash('💾 Volumen TTS guardado: ' + v + '%');
}
// ===================== PORTAPAPELES (Sprint 1) =====================
var __clipState = null;
async function refreshClipboard() {
  try {
    const st = await api('/api/v1/clipboard/status');
    if (!st || st.ok === false) return;
    __clipState = st;
    const on = !!st.enabled;
    const cb = document.getElementById('clipOn');
    if (cb && cb.checked !== on) cb.checked = on;
    const s = document.getElementById('clipState');
    if (s) {
      s.textContent = on ? '🟢 ACTIVADO — se leerá lo que copies' : '⚪ desactivado';
      s.style.color = on ? '#4caf50' : '#888';
    }
    const w = st.watcher || {};
    const h = document.getElementById('clipHotkey');
    if (h) {
      if (w.hotkeyError) {
        h.innerHTML = '⌨️ Atajo <b>' + esc(st.hotkey || 'Ctrl+Alt+R') + '</b>: <span style="color:#ff5252">no disponible — ' + esc(w.hotkeyError) + '</span>';
      } else if (w.running) {
        h.innerHTML = '⌨️ Atajo global: <b>' + esc(st.hotkey || 'Ctrl+Alt+R') + '</b>' +
          (w.hotkeyRegistered ? ' (funciona aunque el navegador no tenga el foco)' : ' (⚠️ no quedó registrado)') +
          ' · monitor: activo';
      } else {
        h.innerHTML = '⌨️ Atajo global: <b>' + esc(st.hotkey || 'Ctrl+Alt+R') + '</b> · monitor: <span style="color:#ffb300">no está corriendo</span>';
      }
    }
    const warn = document.getElementById('clipWarn');
    if (warn) warn.style.display = on ? 'block' : 'none';
  } catch (e) { /* el modulo puede no estar desplegado todavia */ }
}
async function toggleClipboard(want) {
  if (want) {
    // Aviso discreto de privacidad antes de activar la captura.
    if (!confirm('Se leerá en voz alta TODO lo que copies, incluso contraseñas o tokens. El texto no se guarda en el historial y solo va al sintetizador TTS local. ¿Activar "Leer portapapeles"?')) {
      const cb = document.getElementById('clipOn');
      if (cb) cb.checked = false;
      return;
    }
  }
  try {
    const r = await api('/api/v1/clipboard/enabled', {
      method: 'POST', body: JSON.stringify({ enabled: !!want })
    });
    if (!r || r.ok === false) {
      flash('❌ ' + ((r && r.error) || 'no se pudo cambiar el portapapeles'));
      const cb = document.getElementById('clipOn');
      if (cb) cb.checked = !want;
      return;
    }
    flash(want ? '📋 Lectura del portapapeles activada (Ctrl+Alt+R para desactivarla)' : '📋 Lectura del portapapeles desactivada');
    await refreshClipboard();
  } catch (e) { flash('❌ ' + e.message) }
}

// ===================== FUENTES DE VOZ =====================
// Las filas se GENERAN desde /api/v1/sources (registro extensible): agregar una
// fuente nueva en config no requiere tocar el HTML.
var __sources = [];
var __sourcesSig = '';
async function refreshSources() {
  try {
    const r = await api('/api/v1/sources');
    const list = r.sources || [];
    // Solo se re-dibuja si algo cambió: así no se pierde el clic del usuario
    // ni el foco mientras interactúa con los checkboxes.
    const sig = JSON.stringify(list.map(s => [s.id, s.enabled, s.voice, s.connected, s.lastSeen, s.utterances]));
    if (sig === __sourcesSig) return;
    __sourcesSig = sig;
    __sources = list;
    document.getElementById('sources').innerHTML =
      '<tr><th>Activa</th><th>Fuente</th><th>Estado</th><th>Voz</th><th></th></tr>' +
      list.map(s =>
        '<tr>' +
        '<td><input type="checkbox" data-src="' + esc(s.id) + '" ' + (s.enabled ? 'checked' : '') +
          ' onchange="toggleSource(this)" title="Silenciar / activar esta fuente"></td>' +
        '<td><b>' + esc(s.name) + '</b><br><span class="src-chip">' + esc(s.id) +
          (s.aliases && s.aliases.length ? ' · alias: ' + esc(s.aliases.join(', ')) : '') + '</span></td>' +
        '<td>' + (s.connected
            ? '<span style="color:#4caf50">● conectado</span>'
            : '<span style="color:#888">○ sin conexión</span>') +
          (s.lastSeen ? '<br><span class="src-chip">último: ' + new Date(s.lastSeen).toLocaleTimeString('es-MX') + '</span>' : '') +
          '<br><span class="src-chip">' + (s.utterances || 0) + ' locución(es)</span></td>' +
        '<td>' + esc(s.voice || '—') + '</td>' +
        '<td><button class="secondary" data-src="' + esc(s.id) + '" onclick="openVoicePicker(this)">Seleccionar voz</button></td>' +
        '</tr>').join('');
  } catch (e) { console.warn('sources falló', e); }
}
async function toggleSource(el, enabled) {
  const id = (el && el.dataset ? el.dataset.src : el) || '';
  const want = (typeof enabled === 'boolean') ? enabled : !!(el && el.checked);
  // La fuente "Portapapeles" tiene aviso de privacidad: activar la captura es
  // una decisión consciente, asi que se pide confirmacion (tambien con el
  // interruptor "Leer portapapeles").
  if (id === 'clipboard' && want) {
    if (!confirm('Se leerá en voz alta TODO lo que copies, incluso contraseñas o tokens. El texto no se guarda en el historial y solo va al sintetizador TTS local. ¿Activar "Leer portapapeles"?')) {
      if (el && el.checked !== undefined) el.checked = false;
      return;
    }
  }
  const r = await api('/api/v1/sources/' + encodeURIComponent(id), {
    method: 'PUT', body: JSON.stringify({ enabled: want })
  });
  if (r && r.ok === false) {
    flash('❌ ' + ((r.error && r.error.message) || 'no se pudo cambiar la fuente'));
    __sourcesSig = '';
    refreshSources();
    return;
  }
  const s = (__sources || []).find(x => x.id === id);
  if (!want) {
    flash((r.stopped && r.stopped.stopped) ? '🔇 ' + (s ? s.name : id) + ' silenciada (se detuvo su reproducción)' : '🔇 ' + (s ? s.name : id) + ' silenciada');
  } else {
    flash('✅ ' + (s ? s.name : id) + ' activada');
  }
  __sourcesSig = '';
  refreshSources();
  if (id === 'clipboard') refreshClipboard();
}

// ===================== SELECTOR DE VOCES =====================
// Catálogo COMPLETO (edge-tts --list-voices), separado en femeninas / masculinas.
var __voiceCatalog = null;
var __voiceCategory = 'female';
var __voiceTarget = null;

async function openVoicePicker(el) {
  const sourceId = (el && el.dataset ? el.dataset.src : el) || '';
  __voiceTarget = sourceId;
  document.getElementById('voiceOverlay').style.display = 'block';
  const t = (__sources || []).find(s => s.id === sourceId);
  document.getElementById('voiceTarget').textContent = t
    ? ('Fuente: ' + t.name + ' (' + t.id + ') — voz actual: ' + (t.voice || '—'))
    : ('Fuente: ' + sourceId);
  if (!__voiceCatalog) {
    document.getElementById('voiceList').innerHTML = '<i>cargando catálogo de voces…</i>';
    try {
      const r = await api('/api/v1/voices');
      __voiceCatalog = r.catalog || [];
      window.__voiceFeatured = r.featured || { female: [], male: [] };
    } catch (e) {
      __voiceCatalog = [];
      flash('❌ No se pudo cargar el catálogo de voces');
    }
  }
  setVoiceCategory(__voiceCategory);
}
function setVoiceCategory(cat) {
  __voiceCategory = cat;
  const f = document.getElementById('tabFemale'), m = document.getElementById('tabMale');
  if (f) f.style.background = cat === 'female' ? '#e94560' : '#0f3460';
  if (m) m.style.background = cat === 'male' ? '#e94560' : '#0f3460';
  renderVoiceList();
}
function renderVoiceList() {
  const el = document.getElementById('voiceSearch');
  const q = el ? String(el.value || '').toLowerCase().trim() : '';
  const want = __voiceCategory === 'female' ? /^female$/i : /^male$/i;
  let list = (__voiceCatalog || []).filter(v => want.test(v.gender || ''));
  if (q) {
    list = list.filter(v => (v.id + ' ' + v.name + ' ' + v.country + ' ' + v.language + ' ' + (v.personalities || '') + ' ' + (v.categories || '')).toLowerCase().includes(q));
  }
  // Español y sus variantes regionales primero (sin limitar el catálogo).
  // Las voces del casting original de Ciudadan se muestran arriba, marcadas ★.
  const featured = ((window.__voiceFeatured || {})[__voiceCategory]) || [];
  list.sort((a, b) => {
    const fa = featured.indexOf(a.id), fb = featured.indexOf(b.id);
    if (fa >= 0 || fb >= 0) {
      if (fa >= 0 && fb >= 0) return fa - fb;
      return fa >= 0 ? -1 : 1;
    }
    return (b.spanish - a.spanish) || a.locale.localeCompare(b.locale) || a.id.localeCompare(b.id);
  });
  const cnt = document.getElementById('voiceCount');
  if (cnt) cnt.textContent = list.length + ' voces';
  const actual = (__sources || []).find(s => s.id === __voiceTarget);
  const listEl = document.getElementById('voiceList');
  if (!listEl) return;
  listEl.innerHTML = list.map(v =>
    '<div style="display:flex;align-items:center;gap:8px;padding:5px 6px;border-bottom:1px solid #2a2a4a">' +
      '<button class="secondary" style="padding:4px 8px" data-v="' + esc(v.id) + '" onclick="previewVoice(this)" title="Escuchar una muestra">▶</button>' +
      '<span style="flex:1">' +
        '<b>' + esc(v.name) + '</b> ' +
        '<span class="src-chip">' + esc(v.locale) + ' · ' + esc(String(v.language || '').toUpperCase()) +
          (v.personalities ? ' · ' + esc(v.personalities) : '') + '</span>' +
        (featured.indexOf(v.id) >= 0 ? ' <span style="color:#ffb300;font-size:11px">★ Ciudadan</span>' : '') +
        (v.spanish ? ' <span style="color:#4caf50;font-size:11px">ES</span>' : '') +
        (actual && actual.voice === v.id ? ' <span style="color:#e94560;font-size:11px">● actual</span>' : '') +
        '<br><code style="font-size:10px;color:#777">' + esc(v.id) + '</code>' +
      '</span>' +
      '<button data-v="' + esc(v.id) + '" onclick="pickVoice(this)">Usar</button>' +
    '</div>').join('') || '<i style="color:#888">Sin resultados para este filtro.</i>';
}
async function pickVoice(el) {
  const voice = (el && el.dataset ? el.dataset.v : el) || '';
  if (!voice || !__voiceTarget) return;
  const r = await api('/api/v1/sources/' + encodeURIComponent(__voiceTarget), {
    method: 'PUT', body: JSON.stringify({ voice: voice })
  });
  if (r && r.ok === false) {
    flash('❌ ' + ((r.error && r.error.message) || 'no se pudo cambiar la voz'));
    return;
  }
  flash('✅ Voz de la fuente actualizada: ' + voice);
  closeVoicePicker();
  __sourcesSig = '';
  refreshSources();
}
async function previewVoice(el) {
  const voice = (el && el.dataset ? el.dataset.v : el) || '';
  // Nombre legible de la voz (no el id): la muestra lo dice en voz alta.
  let nombre = '';
  try {
    const hit = (__voiceCatalog || []).find(v => v.id === voice);
    if (hit && hit.name) nombre = hit.name;
  } catch (e) { /* sin catálogo: el backend busca el nombre */ }
  const texto = nombre ? ('Esta es una muestra de la voz ' + nombre + '.') : '';
  const r = await api('/api/v1/voices/preview', {
    method: 'POST', body: JSON.stringify({ voice: voice, voiceName: nombre, text: texto })
  });
  if (r && r.ok === false) flash('❌ ' + ((r.error && r.error.message) || r.error || 'no se pudo encolar la muestra'));
  else flash('🔊 Muestra en cola: ' + (r.voiceName || nombre || voice));
}
function closeVoicePicker() { document.getElementById('voiceOverlay').style.display = 'none'; }
setInterval(refresh, 2000);
refreshSources();
refresh();
</script>
</body>
</html>`
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(html)
  validarScriptPanel(html)
}, { auth: false })

/**
 * Valida la sintaxis del <script> del panel ANTES de servirlo.
 * El panel se arma con un template literal: un escape mal puesto (p.ej. \')
 * rompe TODO el JavaScript del panel (botones muertos) sin que el servidor
 * avise. Con esta comprobación el error queda registrado en el log.
 */
let _panelValidado = false
function validarScriptPanel(html) {
  if (_panelValidado) return
  try {
    const m = html.match(/<script>([\s\S]*?)<\/script>/)
    if (!m) return
    new Function(m[1]) // lanza si hay error de sintaxis
    _panelValidado = true
    logger.info('Script del panel validado (sintaxis correcta)')
  } catch (e) {
    logger.error('ERROR DE SINTAXIS en el script del panel — los botones NO funcionan', { error: e.message })
  }
}

// --- Servidor HTTP ---
const server = createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': 'null',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Ciudadan-Token',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    })
    res.end()
    return
  }

  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`)
  const path = url.pathname

  // Buscar ruta
  for (const r of routes) {
    if (r.method !== req.method) continue
    const params = matchRoute(r.pattern, path)
    if (params) {
      if (r.auth) {
        const auth = req.headers['authorization'] || ''
        const tok = auth.startsWith('Bearer ') ? auth.slice(7) : req.headers['x-ciudadan-token']
        if (!validateToken(tok)) {
          return sendJson(res, 401, { ok: false, error: { code: 'unauthorized', message: 'Valid Bearer token required. Get it from ~/.ciudadan-tts-coordinator/token' } })
        }
      }
      try {
        await r.handler(req, res, params)
      } catch (e) {
        logger.error('Route handler error', { path, error: e.message, stack: e.stack?.slice(0, 300) })
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: { code: 'internal', message: e.message } })
      }
      return
    }
  }
  sendJson(res, 404, { ok: false, error: { code: 'not-found', message: `No route: ${req.method} ${path}` } })
})

function matchRoute(pattern, path) {
  const pParts = pattern.split('/')
  const uParts = path.split('/')
  if (pParts.length !== uParts.length) return null
  const params = {}
  for (let i = 0; i < pParts.length; i++) {
    if (pParts[i].startsWith(':')) {
      params[pParts[i].slice(1)] = decodeURIComponent(uParts[i])
    } else if (pParts[i] !== uParts[i]) {
      return null
    }
  }
  return params
}

// --- Arranque ---
async function main() {
  await multimedia.init()
  // Limpiar síntesis edge-tts huérfanas de una ejecución anterior: si el
  // proceso murió con una síntesis a medias, el wrapper y su python hijo
  // quedan colgados y bloquean la cola (el 'close' nunca llega).
  try {
    const n = await synthesizer.cleanupOrphans()
    if (n) logger.warn('Síntesis huérfanas eliminadas al arrancar', { count: n })
  } catch (e) {
    logger.warn('No se pudo limpiar las síntesis huérfanas', { error: e.message })
  }
  // Migración de configuración: YouTube y Chrome son el mismo proceso de audio,
  // así que se funden en un solo control "navegador" (Chrome / YouTube).
  try {
    const mig = multimedia.persistMigration()
    if (mig) {
      const cfg = getConfig()
      if (!cfg.multimedia) cfg.multimedia = {}
      if (!cfg.multimedia.applications) cfg.multimedia.applications = {}
      for (const k of ['youtube', 'chrome']) delete cfg.multimedia.applications[k]
      cfg.multimedia.applications.navegador = mig.navegador
      const updated = saveConfig(cfg)
      config.multimedia = updated.multimedia
      logger.info('Config multimedia migrada al control único', {
        apps: Object.keys(cfg.multimedia.applications),
        navegador: mig.navegador.mode + ' ' + mig.navegador.percentage + '%',
      })
    }
  } catch (e) {
    logger.warn('Migración de configuración multimedia falló', { error: e.message })
  }
  dshTitles.start() // resuelve títulos reales de sesiones DSH desde disco (cada 20s)
  logger.info(`DshTitleResolver: ${dshTitles.size} títulos de sesiones cargados`)
  // Iniciar mpv (si falla, el coordinador sigue funcionando; la síntesis puede hacerse sin reproducir)
  try {
    await player.start()
    logger.info('mpv iniciado correctamente')
  } catch (e) {
    logger.error('mpv no pudo iniciarse — el coordinador funcionará en modo solo-síntesis', { error: e.message })
    logger.error('Instala mpv: https://mpv.io/ o ejecuta scripts/install-mpv.ps1')
  }

  player.on('crash', (err) => {
    logger.error('Player crash detectado, intentando recuperar...', { error: err.message })
  })
  player.on('fatal', (err) => {
    logger.error('Player en estado fatal — síntesis disponible pero sin reproducción', { error: err.message })
  })

  // La cola arranca SOLO cuando mpv y el bridge multimedia ya están listos:
  // si no, la locución pendiente falla ("mpv no está conectado") y el restore
  // de volúmenes se ejecuta sin bridge (el volumen se queda bajo tras reiniciar).
  queue.start()

  server.listen(config.server.port, config.server.host, () => {
    logger.info(`✓ Servidor escuchando en http://${config.server.host}:${config.server.port}`)
    logger.info(`  Panel: http://${config.server.host}:${config.server.port}/`)
    logger.info(`  Health: http://${config.server.host}:${config.server.port}/api/v1/health`)
    console.log(`\n🎙️  CIUDADAN TTS COORDINATOR corriendo en http://${config.server.host}:${config.server.port}`)
    // NUNCA imprimir fragmentos del token (regla del ledger: el token no se
    // escribe en logs). Solo la ruta del archivo.
    console.log(`   Token en: ~/.ciudadan-tts-coordinator/token\n`)
  })
}

// Manejo de señales
process.on('SIGINT', async () => {
  logger.info('Recibida SIGINT, cerrando...')
  await player.shutdown()
  await multimedia.restoreVolumes()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000)
})
process.on('SIGTERM', async () => {
  await player.shutdown()
  await multimedia.restoreVolumes()
  await multimedia._audioBridge?.shutdown?.()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000)
})
process.on('uncaughtException', (e) => {
  logger.error('Uncaught exception', { error: e.message, stack: e.stack?.slice(0, 500) })
})
process.on('unhandledRejection', (e) => {
  logger.error('Unhandled rejection', { error: e?.message || String(e) })
})

main().catch(e => {
  logger.error('Fallo al iniciar', { error: e.message, stack: e.stack })
  process.exit(1)
})
