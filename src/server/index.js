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
import { DshTitleResolver } from '../sessions/dsh-titles.js'
import { MultimediaController } from '../multimedia/controller.js'

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
const player = new MpvPlayer(config)
const sessions = new SessionRegistry(config)
const dshTitles = new DshTitleResolver()
const multimedia = new MultimediaController(config)

// Un título con U+FFFD ("�") está corrupto por codificación: no se usa para hablar.
function tituloLimpio(t) {
  if (!t) return ''
  const s = String(t)
  if (s.includes('\uFFFD')) return ''
  return s
}

// Nombre mostrado de una sesión: título real del DSH (disco) > título recibido > registro > id limpio
function displayName(sessionId, receivedTitle) {
  const fromDsh = tituloLimpio(dshTitles.resolve(sessionId))
  if (fromDsh) return fromDsh
  const reg = tituloLimpio(sessions.resolveDisplayName(sessionId))
  if (reg) return reg
  return tituloLimpio(receivedTitle) || ''
}

const queue = new UtteranceQueue(config, {
  synthesize: async (text, opts) => synthesizer.synthesize(text, opts),
  player,
  multimedia,
})

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

// Health (sin auth para monitoreo)
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
  const paused = await player.isPaused().catch(() => false)
  const st = queue.getStatus()
  if (st.current && st.current.sessionId) {
    st.current = { ...st.current, sessionName: displayName(st.current.sessionId, st.current.sessionTitle) }
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
  const realName = body.sessionId ? displayName(body.sessionId, body.sessionTitle) : ''
  const cleanTask = tituloLimpio(cleanTitle(body.taskTitle))
  const cleanSess = tituloLimpio(cleanTitle(body.sessionTitle))
  const resolvedTitle = cleanTask || cleanSess || realName || ''
  const request = {
    requestId: body.requestId || randomUUID(),
    source: body.source || 'unknown',
    sessionId: body.sessionId || '',
    sessionName: realName, // nombre REAL de la sesión (disco DSH) — se anuncia en el prefix
    sessionTitle: resolvedTitle || body.sessionTitle || '',
    taskTitle: resolvedTitle || body.taskTitle || '',
    voice: body.voice || sessions.getVoice(body.sessionId || ''),
    text: String(body.text || ''),
    priority: body.priority || 'normal',
    interventionId: body.interventionId,
    fragmentIndex: body.fragmentIndex ?? 0,
    totalFragments: body.totalFragments ?? 1,
  }
  if (!request.text.trim()) {
    return sendJson(res, 400, { ok: false, error: { code: 'no-text', message: 'text is required' } })
  }
  const result = queue.enqueue(request)
  if (!result.ok) return sendJson(res, 429, { ok: false, error: result.error, requestId: result.requestId })
  sendJson(res, 202, { ok: true, ...result })
})

// Cola
route('GET', '/api/v1/queue', (req, res) => {
  const items = queue.getQueue().map(u => ({ ...u, sessionName: u.sessionId ? displayName(u.sessionId, u.sessionTitle) : '' }))
  sendJson(res, 200, { ok: true, items, status: queue.getStatus() })
})

// Historial de locuciones procesadas (últimas N, más reciente primero) con nombre real de sesión
route('GET', '/api/v1/history', (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const limit = Math.max(1, Math.min(500, parseInt(url.searchParams.get('limit') || '50', 10) || 50))
  const items = queue.getHistory(limit).map(h => ({ ...h, sessionName: h.sessionId ? displayName(h.sessionId, h.sessionTitle) : '' }))
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
  sendJson(res, 200, { ok: true, paused: true })
})
route('POST', '/api/v1/playback/resume', async (req, res) => {
  await player.resume()
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

// Cancelar sesión completa
route('DELETE', '/api/v1/sessions/:sessionId/queue', (req, res, params) => {
  const r = queue.cancelSession(params.sessionId)
  sendJson(res, 200, r)
})

// Sesiones
route('GET', '/api/v1/sessions', (req, res) => {
  const list = sessions.getAllSessions().map(s => ({
    ...s,
    displayName: displayName(s.sessionId, s.displayTitle || s.title), // nombre REAL desde el DSH
  }))
  const qs = queue.getSessions().map(s => ({ ...s, displayName: s.sessionId ? displayName(s.sessionId, s.sessionTitle) : '' }))
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
  const appKey = params.appKey
  const mode = body.mode
  if (!['pause', 'reduce', 'ignore'].includes(mode)) {
    return sendJson(res, 400, { ok: false, error: "mode debe ser 'pause' | 'reduce' | 'ignore'" })
  }
  const pct = Math.max(0, Math.min(100, parseInt(body.percentage ?? 0, 10)))
  if (isNaN(pct)) return sendJson(res, 400, { ok: false, error: 'percentage 0-100 requerido' })
  const cfg = getConfig()
  if (!cfg.multimedia) cfg.multimedia = {}
  if (!cfg.multimedia.applications) cfg.multimedia.applications = {}
  const existing = cfg.multimedia.applications[appKey] || {}
  cfg.multimedia.applications[appKey] = { ...existing, mode, percentage: pct }
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

// Voces disponibles
route('GET', '/api/v1/voices', async (req, res) => {
  try {
    const voices = await synthesizer.listVoices()
    sendJson(res, 200, { ok: true, spanishVoices: voices, assignments: sessions.getAllAssignments() })
  } catch (e) {
    sendJson(res, 200, { ok: true, spanishVoices: [], error: e.message, assignments: sessions.getAllAssignments() })
  }
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
  .queue-item { padding: 4px 8px; margin: 2px 0; background: #0f3460; border-radius: 4px; font-size: 0.9em; }
  #cfgOverlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.65); z-index: 10; }
  #cfgPanel { background: #16213e; border-radius: 10px; max-width: 660px; margin: 50px auto; padding: 20px; max-height: 82vh; overflow: auto; box-shadow: 0 8px 30px rgba(0,0,0,.6); }
  .cfg-app { border-bottom: 1px solid #333; padding: 8px 0; }
  .cfg-app label { min-width: 0; margin-right: 10px; }
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
    <h3 style="margin-top:0">⚙️ Volumen y acciones por aplicación</h3>
    <div style="font-size:11px;color:#888;margin-bottom:8px">Ajusta todo y pulsa <b>💾 Guardar</b>: se aplica de inmediato y esta ventana se cierra sola. Este modal NO se refresca solo.</div>
    <div id="cfgBody"></div>
    <hr style="border-color:#333">
    <label>Volumen del coordinador (mpv, 0–600): <input type="range" id="ttsVol" min="0" max="600" value="100" oninput="document.getElementById('ttsVal').textContent=this.value"> <span id="ttsVal">100</span>%</label>
    <div style="margin-top:8px">
      <button id="cfgSave" onclick="saveAll()">💾 Guardar</button>
      <button class="secondary" onclick="forceRestore()">↩ Restaurar audio ahora</button>
      <button class="secondary" style="float:right" onclick="closeCfg()">✖ Cerrar</button>
    </div>
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
      .map(i => '<div class="queue-item">[' + i.status + '] ' + esc(i.source) + ' — ' + esc(i.sessionName || i.sessionTitle || i.sessionId) + ' (' + esc(i.voice) + ')</div>').join('') || '<i>vacía</i>';
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
      '<td><b>' + esc(a.appKey) + '</b>' + pauseNote + '</td>' +
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
async function openCfg(focusApp) {
  __cfgOpen = true;
  document.getElementById('cfgOverlay').style.display = 'block';
  try {
    const m = await api('/api/v1/multimedia/status');
    const rows = [];
    __cfgApps = [];
    for (const a of (m.apps||[])) {
      __cfgApps.push(a.appKey);
      rows.push('<div class="cfg-app">' +
        '<b>' + esc(a.appKey) + '</b>' +
        (a.mode==='pause' && !a.pauseSupported ? ' <span style="color:#ffb300">⚠️ no admite pausa selectiva</span>' : '') + '<br>' +
        '<label>Modo: <select id="cfgmode-' + esc(a.appKey) + '">' +
          '<option value="pause"' + (a.mode==='pause'?' selected':'') + '>Pausar (reanuda al terminar)</option>' +
          '<option value="reduce"' + (a.mode==='reduce'?' selected':'') + '>Reducir</option>' +
          '<option value="ignore"' + (a.mode==='ignore'?' selected':'') + '>Ignorar</option></select></label>' +
        '<label>% reducción: <input type="range" id="cfgpct-' + esc(a.appKey) + '" data-pct="cfgpctv-' + esc(a.appKey) + '" min="0" max="100" value="' + a.percentage + '" style="width:120px" oninput="document.getElementById(this.dataset.pct).textContent=this.value"> <span id="cfgpctv-' + esc(a.appKey) + '">' + a.percentage + '</span>%</label>' +
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
}
function closeCfg() { __cfgOpen = false; document.getElementById('cfgOverlay').style.display = 'none'; }
async function forceRestore() { await api('/api/v1/multimedia/restore', { method: 'POST' }); refresh(); }
async function ctrl(action) { await api('/api/v1/playback/' + action, { method: 'POST' }); refresh(); }
async function togglePause() {
  const s = await api('/api/v1/status');
  if (s.paused) await api('/api/v1/playback/resume', { method: 'POST' });
  else await api('/api/v1/playback/pause', { method: 'POST' });
  await refresh();
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
setInterval(refresh, 2000);
refresh();
</script>
</body>
</html>`
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(html)
}, { auth: false })

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
    console.log(`   Token: ${token.slice(0, 8)}… (archivo: ~/.ciudadan-tts-coordinator/token)\n`)
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
