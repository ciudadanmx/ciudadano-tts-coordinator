// Cola global de locuciones con turnos atómicos, ordenamiento por prioridad,
// conservación de orden intra-intervención, deduplicación, y recuperación segura.
//
// Estados de una solicitud (utterance):
//   queued      → en cola, esperando turno
//   synthesizing→ generando audio
//   ready       → audio listo, esperando reproducción
//   playing     → reproduciéndose ahora
//   done        → reproducida correctamente
//   error       → falló (síntesis o reproducción)
//   cancelled   → cancelada por el solicitante

import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { appendFileSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { logger } from '../monitoring/logger.js'

const PRIORITY_ORDER = { high: 0, normal: 1, low: 2 }
const HISTORY_TTL_MS = 48 * 3600 * 1000 // 48 horas

/**
 * Construye el prefijo de anuncio para una locución.
 * Soporta los tokens {sessionName} y {taskTitle} en announcements.prefixTemplate.
 * Robustez: si la plantilla sólo tiene {taskTitle} y la tarea está vacía, se anuncia
 * el nombre de la sesión (fallback) — el nombre de la sesión NUNCA debe perderse.
 * Si ambos títulos son iguales, no se duplica.
 */
export function buildAnnouncement(annCfg, sessionName, taskTitle) {
  if (!annCfg || annCfg.enabled === false) return ''
  const max = annCfg.maxTitleLength || 80
  const min = annCfg.minTitleLength ?? 3
  const sn = String(sessionName || '').trim().slice(0, max)
  let tt = String(taskTitle || '').trim().slice(0, max)
  if (sn && tt && sn.toLowerCase() === tt.toLowerCase()) tt = ''
  const tmpl = String(annCfg.prefixTemplate || '{taskTitle}.')
  let text = tmpl
  if (tmpl.includes('{sessionName}') || tmpl.includes('{taskTitle}')) {
    // centinela para tokens vacíos: permite limpiar "X. <vacío>." sin tocar los
    // puntos que vienen DENTRO de los títulos (ej. "PRUEBA v1.2")
    const EMPTY = '\u0000'
    text = tmpl.replaceAll('{sessionName}', sn || EMPTY).replaceAll('{taskTitle}', tt || EMPTY)
    text = text
      .replace(/\.\s*\u0000/g, '') // "X. <vacío>" → "X"
      .replace(/\u0000\s*\./g, '') // "<vacío>. Y" → "Y"
      .replace(/\u0000/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
  }
  // Fallback: la plantilla quedó vacía pero hay algún nombre → anunciarlo
  if (!text || text === '.') {
    const n = sn || tt
    if (n) text = n + '.'
  }
  const body = text.replace(/\./g, '').trim()
  if (body.length < min) return ''
  return text
}

export class UtteranceQueue extends EventEmitter {
  constructor(config, deps) {
    super()
    this.config = config
    this.deps = deps // { synthesize, player, multimedia }
    // Evitar que un evento 'error' sin listener rompa el proceso
    this.on('error', () => {})
    this.items = new Map() // requestId -> utterance
    this.order = [] // requestIds en orden de llegada
    this.playing = null // requestId actualmente reproduciéndose
    this.lock = null // { requestId, acquiredAt, expiresAt }
    this.lockTimer = null
    this.processing = false
    this.started = false // la cola espera a start() (mpv + bridge listos)
    this._restoreChain = Promise.resolve() // restores multimedia encadenados (sin bloquear la cola)
    this.seq = 0
    this.history = [] // historial en memoria de locuciones procesadas
    this.playLog = [] // requestIds en orden de reproducción (para botón ⏮ anterior)
    // Historial PERSISTENTE en disco (texto nomás, sin audio) — sobrevive reinicios, TTL 48h
    this.historyFile = join(homedir(), '.ciudadan-tts-coordinator', 'history.jsonl')
    this._loadHistory()
    // Cola persistente: lo pendiente NO se pierde si el proceso se reinicia
    this.queueFile = join(homedir(), '.ciudadan-tts-coordinator', 'queue.jsonl')
    this._loadQueue()
  }

  _queueEvent(ev) {
    try {
      appendFileSync(this.queueFile, JSON.stringify(ev) + '\n', 'utf8')
    } catch (e) {
      logger.warn('No se pudo persistir la cola en disco', { error: e.message })
    }
  }

  _loadQueue() {
    let raw
    try {
      mkdirSync(join(homedir(), '.ciudadan-tts-coordinator'), { recursive: true })
      raw = readFileSync(this.queueFile, 'utf8')
    } catch (e) {
      if (e.code !== 'ENOENT') logger.warn('No se pudo leer la cola persistente', { error: e.message })
      return
    }
    const last = new Map()
    for (const l of raw.split('\n').filter(Boolean)) {
      try {
        const ev = JSON.parse(l)
        if (ev && ev.requestId) last.set(ev.requestId, ev)
      } catch { /* línea corrupta */ }
    }
    const pending = []
    for (const ev of last.values()) {
      if (ev.state === 'queued' && ev.text && !this.items.has(ev.requestId)) pending.push(ev)
    }
    pending.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    if (!pending.length) return
    for (const ev of pending) {
      const r = this.enqueue({
        requestId: ev.requestId,
        source: ev.source,
        sessionId: ev.sessionId,
        sessionName: ev.sessionName,
        sessionTitle: ev.sessionTitle,
        taskTitle: ev.taskTitle,
        voice: ev.voice,
        text: ev.text,
        priority: ev.priority,
        interventionId: ev.interventionId,
        fragmentIndex: ev.fragmentIndex,
        totalFragments: ev.totalFragments,
      })
      if (r.ok) {
        // marcar como re-encolado (evita re-encolar en el próximo arranque)
        this._queueEvent({ requestId: ev.requestId, state: 'queued', createdAt: ev.createdAt, requeued: true })
      }
    }
    logger.info('Cola pendiente restaurada de disco', { entries: pending.length })
  }

  _loadHistory() {
    try {
      mkdirSync(join(homedir(), '.ciudadan-tts-coordinator'), { recursive: true })
      const raw = readFileSync(this.historyFile, 'utf8')
      const cutoff = Date.now() - HISTORY_TTL_MS
      const max = this.config.queue?.historySize ?? 200
      const lines = raw.split('\n').filter(Boolean)
      const kept = []
      let discarded = 0
      for (const l of lines) {
        try {
          const h = JSON.parse(l)
          const ts = h.finishedAt || h.createdAt || 0
          if (ts >= cutoff) kept.push(h)
          else discarded++
        } catch { discarded++ }
      }
      this.history = kept.slice(-max)
      // Compactar el archivo: descartar lo vencido (48 h) y lo corrupto
      if (discarded > 0) {
        try {
          const compact = kept.slice(-max)
          writeFileSync(this.historyFile, compact.map(h => JSON.stringify(h)).join('\n') + (compact.length ? '\n' : ''), 'utf8')
          logger.info('Historial compactado', { antes: lines.length, despues: compact.length, descartados: discarded })
        } catch (e) {
          logger.warn('No se pudo compactar el historial', { error: e.message })
        }
      }
      logger.info('Historial cargado de disco', { entries: this.history.length, file: this.historyFile })
    } catch (e) {
      if (e.code !== 'ENOENT') logger.warn('No se pudo leer el historial persistente', { error: e.message })
      this.history = []
    }
  }

  // --- Encolar solicitud ---
  enqueue(request) {
    const id = request.requestId || randomUUID()
    // Deduplicación: si ya existe el mismo requestId activo, rechazar
    if (this.items.has(id) && !['done', 'error', 'cancelled'].includes(this.items.get(id).status)) {
      return { ok: false, error: 'duplicate requestId', requestId: id }
    }
    const maxLen = this.config.queue?.maxLength ?? 100
    const activeCount = [...this.items.values()].filter(u => !['done', 'error', 'cancelled'].includes(u.status)).length
    if (activeCount >= maxLen) {
      return { ok: false, error: 'queue full', requestId: id, activeCount, maxLen }
    }
    const maxText = this.config.queue?.maxTextLength ?? 50000
    const text = String(request.text || '')
    if (text.length > maxText) {
      return { ok: false, error: `text too long (${text.length} > ${maxText})`, requestId: id }
    }

    const utterance = {
      requestId: id,
      source: request.source || 'unknown',
      sessionId: request.sessionId || '',
      sessionName: request.sessionName || '', // nombre REAL resuelto por el servidor (disco DSH)
      sessionTitle: request.sessionTitle || '',
      taskTitle: request.taskTitle || '',
      voice: request.voice || this.config.voices?.default || 'es-CO-SalomeNeural',
      text,
      priority: PRIORITY_ORDER[request.priority] !== undefined ? request.priority : 'normal',
      status: 'queued',
      createdAt: Date.now(),
      seq: ++this.seq,
      interventionId: request.interventionId || id, // agrupa fragmentos de una misma intervención
      fragmentIndex: request.fragmentIndex ?? 0,
      totalFragments: request.totalFragments ?? 1,
      synthStatus: 'pending', // pending | synthesizing | ready | error
      audioPath: null,
      playStatus: 'pending', // pending | playing | done | error | skipped
      error: null,
      attempts: 0,
      maxAttempts: 3,
    }
    this.items.set(id, utterance)
    this._insertOrdered(id)
    this._queueEvent({
      requestId: id, state: 'queued', source: utterance.source, sessionId: utterance.sessionId,
      sessionName: utterance.sessionName, sessionTitle: utterance.sessionTitle, taskTitle: utterance.taskTitle,
      voice: utterance.voice, text: utterance.text, priority: utterance.priority,
      interventionId: utterance.interventionId, fragmentIndex: utterance.fragmentIndex,
      totalFragments: utterance.totalFragments, createdAt: utterance.createdAt,
    })
    logger.info('Utterance enqueued', { requestId: id, source: utterance.source, sessionId: utterance.sessionId, status: utterance.status, priority: utterance.priority, fragments: `${utterance.fragmentIndex+1}/${utterance.totalFragments}` })
    this.emit('enqueued', utterance)
    this._pump()
    return { ok: true, requestId: id, status: utterance.status, queuePosition: this._positionOf(id) }
  }

  _insertOrdered(id) {
    const u = this.items.get(id)
    // Ordenar por: prioridad (menor valor = más urgente primero), luego seq, luego fragmentIndex
    const idx = this.order.findIndex(rid => {
      const other = this.items.get(rid)
      if (!other) return false
      const pDiff = PRIORITY_ORDER[u.priority] - PRIORITY_ORDER[other.priority]
      if (pDiff !== 0) return pDiff < 0 // nuevo tiene mejor prioridad → insertar antes
      if (u.seq !== other.seq) return u.seq < other.seq // menor seq (llegó antes) va primero
      return u.fragmentIndex < other.fragmentIndex
    })
    if (idx === -1) this.order.push(id)
    else this.order.splice(idx, 0, id)
  }

  _positionOf(id) {
    return this.order.indexOf(id) + 1
  }

  // --- Obtener siguiente pendiente ---
  _next() {
    for (const id of this.order) {
      const u = this.items.get(id)
      if (u && u.status === 'queued') return u
    }
    return null
  }

  // --- Adquirir lock atómico para reproducción ---
  _acquireLock(requestId) {
    if (this.lock && this.lock.requestId !== requestId) {
      // Lock activo de otro: verificar expiración
      if (Date.now() < this.lock.expiresAt) return false
      logger.warn('Lock expirado, liberando', { oldRequestId: this.lock.requestId, ageMs: Date.now() - this.lock.acquiredAt })
      this._releaseLock()
    }
    const timeoutMs = this.config.queue?.lockTimeoutMs ?? 120000
    this.lock = {
      requestId,
      acquiredAt: Date.now(),
      expiresAt: Date.now() + timeoutMs,
    }
    if (this.lockTimer) clearTimeout(this.lockTimer)
    this.lockTimer = setTimeout(() => {
      if (this.lock) {
        logger.error('Lock timeout — liberando turno forzosamente', { requestId: this.lock.requestId })
        this._forceReleaseLock(this.lock.requestId, 'lock timeout')
      }
    }, timeoutMs)
    if (this.lockTimer.unref) this.lockTimer.unref()
    return true
  }

  _releaseLock() {
    if (this.lockTimer) { clearTimeout(this.lockTimer); this.lockTimer = null }
    this.lock = null
  }

  _forceReleaseLock(requestId, reason) {
    const u = this.items.get(requestId)
    if (u && (u.status === 'playing' || u.status === 'synthesizing')) {
      u.status = 'error'
      u.error = reason
      u.playStatus = 'error'
      logger.error('Utterance forzada a error por lock', { requestId, reason })
      this.emit('error', u, reason)
    }
    // Desbloquear cualquier reproducción colgada: stop() resuelve la promesa del player
    try { this.deps.player?.stop?.() } catch { /* best effort */ }
    this._releaseLock()
    this.playing = null
    this._pump()
  }

  // --- Bomba principal: procesar cola ---
  /** Arrancar el procesamiento (llamar cuando mpv y el bridge ya estén listos). */
  start() {
    if (this.started) return
    this.started = true
    logger.info('Cola iniciada', { pendientes: this._next() ? 1 : 0 })
    this._pump()
  }

  async _pump() {
    // La cola NO arranca hasta que el servidor esté listo (mpv conectado y bridge
    // de audio disponible). Antes arrancaba en el constructor y la locución
    // pendiente fallaba con "mpv no está conectado" y el restore de volúmenes
    // se ejecutaba sin bridge (el volumen se quedaba bajo tras un reinicio).
    if (!this.started) return
    if (this.processing) return
    this.processing = true
    try {
      while (true) {
        const next = this._next()
        if (!next) break
        if (this.playing) break // ya hay algo reproduciéndose
        // Si el lock está tomado por otra utterance, esperar a que expire (no atascar para siempre)
        if (!this._acquireLock(next.requestId)) {
          logger.warn('Lock ocupado por otro, esperando expiración', { lockOwner: this.lock?.requestId, next: next.requestId })
          break
        }
        await this._process(next)
      }
    } finally {
      this.processing = false
    }
    // Si quedó algo pendiente y no hay nada sonando, reintentar
    if (!this.playing && this._next()) {
      setImmediate(() => this._pump())
    }
  }

  async _process(utterance) {
    const { synthesize, player, multimedia } = this.deps
    try {
      // 1. Anuncio de sesión/tarea (si está habilitado y hay nombre).
      //    Prioridad de nombre: sessionName (real, desde disco) > sessionTitle > taskTitle.
      let fullText = utterance.text
      const annCfg = this.config.announcements
      if (annCfg?.enabled && utterance.fragmentIndex === 0) {
        const prefix = buildAnnouncement(
          annCfg,
          utterance.sessionName || utterance.sessionTitle,
          utterance.taskTitle
        )
        if (prefix) fullText = prefix + '\n\n' + utterance.text
      }

      // 2. Síntesis
      utterance.status = 'synthesizing'
      utterance.synthStatus = 'synthesizing'
      this.emit('synthesizing', utterance)
      logger.info('Synthesizing', { requestId: utterance.requestId, voice: utterance.voice, textLen: fullText.length })

      let audioResult
      let attempt = 0
      while (attempt < utterance.maxAttempts) {
        attempt++
        utterance.attempts = attempt
        try {
          audioResult = await synthesize(fullText, { voice: utterance.voice, requestId: utterance.requestId })
          if (audioResult && audioResult.audio) break
          throw new Error(audioResult?.error || 'empty audio')
        } catch (e) {
          logger.warn(`Synthesis attempt ${attempt} failed`, { requestId: utterance.requestId, error: e.message })
          if (attempt >= utterance.maxAttempts) throw e
          await new Promise(r => setTimeout(r, 1000 * attempt))
        }
      }

      utterance.audioPath = audioResult.path
      utterance.synthStatus = 'ready'
      utterance.status = 'ready'
      this.emit('ready', utterance)

      // 3. Control multimedia: esperar el restore de la locución anterior, restaurar
      //    pendientes y aplicar ducking ANTES de reproducir
      if (multimedia) {
        try { await this._restoreChain } catch { /* ya manejado */ }
        try { await multimedia.restoreVolumes() } catch (e) {
          logger.warn('Multimedia restore previo failed (non-fatal)', { error: e.message })
        }
        try { await multimedia.applyDucking(utterance) } catch (e) {
          logger.warn('Multimedia ducking failed (non-fatal)', { error: e.message })
        }
      }

      // 4. Reproducción con lock (volumen: mpv ya arranca con --volume=config.player.volume; no pisar por utterance)
      this.playing = utterance.requestId
      utterance.status = 'playing'
      utterance.playStatus = 'playing'
      utterance.startedAt = Date.now()
      if (!this.playLog) this.playLog = []
      if (this.playLog[this.playLog.length - 1] !== utterance.requestId) {
        this.playLog.push(utterance.requestId)
        if (this.playLog.length > 200) this.playLog.shift()
      }
      this.emit('playing', utterance)
      logger.info('Playing', { requestId: utterance.requestId, source: utterance.source, sessionTitle: utterance.sessionTitle, voice: utterance.voice })

      let playGuard = null
      let forcedStop = false
      let lockBeat = null
      try {
        // Watchdog: si la reproducción no resuelve, se fuerza el stop para que la cola
        // NUNCA se congule (processing quedaría en true y nada más sonaría).
        const playTimeoutMs = this.config.queue?.lockTimeoutMs ?? 600000
        // Heartbeat del lock: una locución larga no debe perder el turno por expiración.
        if (this.lock) {
          lockBeat = setInterval(() => {
            if (this.lock && this.lock.requestId === utterance.requestId) {
              this.lock.expiresAt = Date.now() + playTimeoutMs
            }
          }, Math.max(5000, Math.floor(playTimeoutMs / 3)))
          if (lockBeat.unref) lockBeat.unref()
        }
        const playPromise = player.play(utterance.audioPath)
        const guarded = new Promise((resolve, reject) => {
          playGuard = setTimeout(() => {
            forcedStop = true
            logger.error('Play colgado — forzando stop para no congelar la cola', {
              requestId: utterance.requestId, timeoutMs: playTimeoutMs,
            })
            try { player.stop() } catch { /* best effort */ }
          }, playTimeoutMs)
          if (playGuard.unref) playGuard.unref()
          playPromise.then(resolve, reject)
        })
        await guarded
        if (forcedStop) {
          utterance.status = 'error'
          utterance.playStatus = 'error'
          utterance.error = 'playback timeout'
          utterance.finishedAt = Date.now()
          this._pushHistory(utterance)
          this._queueEvent({ requestId: utterance.requestId, state: 'error', finishedAt: utterance.finishedAt })
          this.emit('playbackError', utterance, new Error('playback timeout'))
          logger.error('Playback failed', { requestId: utterance.requestId, error: 'playback timeout' })
        } else if (utterance.status === 'playing') {
          // terminó sola (eof)
          utterance.status = 'done'
          utterance.playStatus = 'done'
          utterance.finishedAt = Date.now()
          this._pushHistory(utterance)
          this._queueEvent({ requestId: utterance.requestId, state: 'done', finishedAt: utterance.finishedAt })
          this.emit('done', utterance)
          logger.info('Playback done', { requestId: utterance.requestId })
        } else {
          // fue interrumpida por un replay 'now' (ya está re-encolada como 'queued')
          this._queueEvent({ requestId: utterance.requestId, state: 'queued', createdAt: utterance.createdAt })
          logger.info('Play interrumpido por replay — utterance re-encolada', { requestId: utterance.requestId })
        }
      } catch (e) {
        utterance.status = 'error'
        utterance.playStatus = 'error'
        utterance.error = e.message
        utterance.finishedAt = Date.now()
        this._pushHistory(utterance)
        this._queueEvent({ requestId: utterance.requestId, state: 'error', finishedAt: utterance.finishedAt })
        this.emit('playbackError', utterance, e)
        logger.error('Playback failed', { requestId: utterance.requestId, error: e.message })
      } finally {
        if (playGuard) { clearTimeout(playGuard); playGuard = null }
        if (lockBeat) { clearInterval(lockBeat); lockBeat = null }
        this.playing = null
        this._releaseLock()
        // 5. Restaurar multimedia ENTRE locuciones. El contenido pausado (video de
        //    YouTube) SE REANUDA SIEMPRE entre una locución y la siguiente, para que
        //    no quede pausado durante toda la cola.
        //    - Entre locuciones de intervenciones distintas: se restaura todo
        //      (volúmenes + reanudación).
        //    - Entre fragmentos de la MISMA intervención: solo se reanuda el pause;
        //      el volumen se mantiene reducido (evita picos de audio entre
        //      fragmentos). La siguiente locución vuelve a pausar el video.
        //    Va EN CADENA y sin bloquear: el siguiente _process espera a que termine
        //    (await this._restoreChain) antes de aplicar su propio ducking.
        if (multimedia) {
          const next = this._next()
          const mismoFragmento = !!(next && next.interventionId && next.interventionId === utterance.interventionId)
          const opts = mismoFragmento ? { soloPausa: true } : {}
          this._restoreChain = Promise.resolve(this._restoreChain)
            .then(() => multimedia.restoreVolumes(opts))
            .catch(e => logger.warn('Multimedia restore failed (non-fatal)', { error: e.message }))
        }
      }
    } catch (e) {
      utterance.status = 'error'
      utterance.synthStatus = 'error'
      utterance.error = e.message
      utterance.finishedAt = Date.now()
      this._pushHistory(utterance)
      this._queueEvent({ requestId: utterance.requestId, state: 'error', finishedAt: utterance.finishedAt })
      this.playing = null
      this._releaseLock()
      this.emit('error', utterance, e)
      logger.error('Processing failed', { requestId: utterance.requestId, error: e.message })
      if (multimedia) {
        try { await multimedia.restoreVolumes() } catch { /* ignore */ }
      }
    }
    // Continuar con la siguiente
    this._pump()
  }

  // --- Historial de locuciones (en memoria, últimas N) ---
  _pushHistory(u) {
    if (!this.history) this.history = []
    const entry = {
      requestId: u.requestId,
      source: u.source,
      sessionId: u.sessionId,
      sessionTitle: u.sessionTitle,
      taskTitle: u.taskTitle,
      voice: u.voice,
      text: u.text, // texto completo (NO se guarda audio en disco) — permite replay
      textPreview: String(u.text || '').slice(0, 120),
      textLength: (u.text || '').length,
      status: u.status,
      playStatus: u.playStatus,
      createdAt: u.createdAt,
      startedAt: u.startedAt || null,
      finishedAt: u.finishedAt || null,
      durationMs: u.startedAt && u.finishedAt ? u.finishedAt - u.startedAt : null,
      error: u.error || null,
    }
    this.history.push(entry)
    const max = this.config.queue?.historySize ?? 200
    if (this.history.length > max) this.history.splice(0, this.history.length - max)
    // Persistir en disco (append JSONL, solo texto/metadata — nunca audio)
    try {
      appendFileSync(this.historyFile, JSON.stringify(entry) + '\n', 'utf8')
    } catch (e) {
      logger.warn('No se pudo persistir historial en disco', { error: e.message })
    }
  }

  getHistory(limit = 50) {
    const h = this.history || []
    return h.slice(-Math.max(1, Math.min(500, limit))).reverse()
  }

  /**
   * Replay de un elemento del historial.
   * mode 'queue' → encola al final (prioridad normal).
   * mode 'now'   → prioridad alta, interrumpe lo que suene AHORA; la locución
   *                 interrumpida se re-encola justo después (se reanuda sola).
   * Devuelve el resultado de enqueue + info de interrupción.
   */
  enqueueReplay(request) {
    const mode = request.mode === 'now' ? 'now' : 'queue'
    const r = this.enqueue({
      text: request.text,
      source: request.source || 'replay',
      sessionId: request.sessionId || '',
      sessionTitle: request.sessionTitle || '',
      taskTitle: request.taskTitle || '',
      voice: request.voice,
      priority: mode === 'now' ? 'high' : 'normal',
      replayOf: request.replayOf || null,
    })
    if (!r.ok) return r
    let interrupted = null
    if (mode === 'now' && this.playing) {
      const cur = this.items.get(this.playing)
      if (cur && cur.status === 'playing') {
        // re-encolar la actual justo detrás del replay (mismo priority, seq menor)
        const replaySeq = this.items.get(r.requestId)?.seq ?? this.seq
        cur.status = 'queued'
        cur.playStatus = 'pending'
        cur.priority = 'high'
        cur.seq = replaySeq - 0.5
        this.order = this.order.filter(id => id !== cur.requestId)
        this._insertOrdered(cur.requestId)
        interrupted = cur.requestId
        logger.info('Replay NOW: interrumpiendo utterance actual (se re-encola)', { interrupted, replay: r.requestId })
        try { this.deps.player.stop() } catch { /* el play resolverá solo */ }
      }
    }
    return { ...r, mode, interrupted }
  }

  // --- Cancelar solicitud ---
  cancel(requestId) {
    const u = this.items.get(requestId)
    if (!u) return { ok: false, error: 'not found' }
    if (['done', 'error', 'cancelled'].includes(u.status)) {
      return { ok: false, error: 'already finished', status: u.status }
    }
    u.status = 'cancelled'
    u.playStatus = 'cancelled'
    this._queueEvent({ requestId, state: 'cancelled', finishedAt: Date.now() })
    // Si era la que se estaba reproduciendo, detener el reproductor
    if (this.playing === requestId) {
      this.deps.player?.stop()
      this.playing = null
      this._releaseLock()
    }
    this.order = this.order.filter(id => id !== requestId)
    logger.info('Utterance cancelled', { requestId })
    this.emit('cancelled', u)
    this._pump()
    return { ok: true, requestId }
  }

  // --- Cancelar todas las de una sesión ---
  cancelSession(sessionId) {
    let count = 0
    for (const [id, u] of this.items) {
      if (u.sessionId === sessionId && !['done', 'error', 'cancelled'].includes(u.status)) {
        this.cancel(id)
        count++
      }
    }
    return { ok: true, cancelled: count }
  }

  // --- Detener reproducción actual ---
  stopCurrent() {
    if (this.playing) {
      const u = this.items.get(this.playing)
      this.deps.player?.stop()
      if (u) {
        u.status = 'cancelled'
        u.playStatus = 'skipped'
        this._queueEvent({ requestId: this.playing, state: 'cancelled', finishedAt: Date.now() })
      }
      this.playing = null
      this._releaseLock()
      this._pump()
      return { ok: true, stopped: this.playing }
    }
    return { ok: false, error: 'nothing playing' }
  }

  // --- Saltar locución actual ---
  skipCurrent() {
    if (this.playing) {
      const u = this.items.get(this.playing)
      this.deps.player?.skip()
      if (u) {
        u.status = 'done'
        u.playStatus = 'skipped'
      }
      return { ok: true, skipped: this.playing }
    }
    return { ok: false, error: 'nothing playing' }
  }

  // --- Estado ---
  getStatus() {
    const active = [...this.items.values()].filter(u => !['done', 'error', 'cancelled'].includes(u.status))
    const current = this.playing ? this.items.get(this.playing) : null
    return {
      speaking: !!this.playing,
      current: current ? {
        requestId: current.requestId,
        source: current.source,
        sessionId: current.sessionId,
        sessionTitle: current.sessionTitle,
        task: current.taskTitle,
        voice: current.voice,
        status: current.status,
      } : null,
      queueLength: active.length - (this.playing ? 1 : 0),
      lock: this.lock ? { requestId: this.lock.requestId, ageMs: Date.now() - this.lock.acquiredAt } : null,
      player: this.deps.player?.name || 'unknown',
    }
  }

  getQueue() {
    return this.order
      .map(id => this.items.get(id))
      .filter(Boolean)
      .map(u => ({
        requestId: u.requestId,
        interventionId: u.interventionId,
        fragmentIndex: u.fragmentIndex,
        totalFragments: u.totalFragments,
        source: u.source,
        sessionId: u.sessionId,
        sessionTitle: u.sessionTitle,
        taskTitle: u.taskTitle,
        voice: u.voice,
        priority: u.priority,
        status: u.status,
        synthStatus: u.synthStatus,
        playStatus: u.playStatus,
        fragmentIndex: u.fragmentIndex,
        totalFragments: u.totalFragments,
        createdAt: u.createdAt,
        error: u.error,
        textPreview: String(u.text || '').slice(0, 120),
        textLength: (u.text || '').length,
      }))
  }

  getSessions() {
    const sessions = new Map()
    for (const u of this.items.values()) {
      if (!u.sessionId) continue
      if (!sessions.has(u.sessionId)) {
        sessions.set(u.sessionId, {
          sessionId: u.sessionId,
          source: u.source,
          sessionTitle: u.sessionTitle,
          voice: u.voice,
          pendingCount: 0,
          lastActivity: u.createdAt,
        })
      }
      const s = sessions.get(u.sessionId)
      if (!['done', 'error', 'cancelled'].includes(u.status)) s.pendingCount++
      if (u.createdAt > s.lastActivity) s.lastActivity = u.createdAt
    }
    return [...sessions.values()]
  }
}
