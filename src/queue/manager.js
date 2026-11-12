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
import { STATE_DIR } from '../paths.js'
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
    this.frontId = null // item marcado como "reproducir ya" (botón ▶ del panel)
    this._lastServedSource = null // última fuente servida (fairness round-robin)
    // Pre-síntesis en paralelo: Edge TTS tarda 30-40 s por fragmento (a veces
    // se cuelga), así que sintetizar de uno en uno deja la cola con una hora
    // de retraso. Se lanzan varias síntesis a la vez y se consumen en orden.
    this._preSynth = new Map() // requestId -> Promise<audioResult>
    this._prefetching = false
    this.lock = null // { requestId, acquiredAt, expiresAt }
    this.lockTimer = null
    this.processing = false
    this.started = false // la cola espera a start() (mpv + bridge listos)
    this._restoreChain = Promise.resolve() // restores multimedia encadenados (sin bloquear la cola)
    this.seq = 0
    this.history = [] // historial en memoria de locuciones procesadas
    this.playLog = [] // requestIds en orden de reproducción (para botón ⏮ anterior)
    // Historial PERSISTENTE en disco (texto nomás, sin audio) — sobrevive reinicios, TTL 48h
    this.historyFile = join(STATE_DIR, 'history.jsonl')
    this._loadHistory()
    // Cola persistente: lo pendiente NO se pierde si el proceso se reinicia
    this.queueFile = join(STATE_DIR, 'queue.jsonl')
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
      mkdirSync(STATE_DIR, { recursive: true })
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
    // Descartar lo que ya es demasiado viejo: si la voz lleva una hora de
    // retraso, la locución dejó de servir de algo (y ocupaba la cola, que
    // llegaba a llenarse y devolvía 429). El texto queda en el historial.
    const maxAge = this.config.queue?.maxAgeMs ?? 10 * 60 * 1000
    const limite = Date.now() - maxAge
    let descartadas = 0
    for (const ev of last.values()) {
      if (ev.state !== 'queued' || !ev.text || this.items.has(ev.requestId)) continue
      if ((ev.createdAt || 0) < limite) { descartadas++; continue }
      pending.push(ev)
    }
    if (descartadas) {
      logger.info('Locuciones descartadas por antiguedad', { count: descartadas, maxAgeMs: maxAge })
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
      mkdirSync(STATE_DIR, { recursive: true })
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

  // --- Dividir un texto largo en trozos por párrafo/frase (sin perder palabras) ---
  _chunkText(text, maxChars) {
    const out = []
    let resto = String(text || '').trim()
    while (resto.length > maxChars) {
      let corte = resto.lastIndexOf(' ', maxChars)
      if (corte < maxChars * 0.4) corte = resto.lastIndexOf('\n', maxChars)
      if (corte < maxChars * 0.4) corte = maxChars
      out.push(resto.slice(0, corte).trim())
      resto = resto.slice(corte).trim()
    }
    if (resto) out.push(resto)
    return out.filter(Boolean)
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

    // TROCEO DE SEGURIDAD: algunos emisores (Dany) mandan el mensaje entero
    // en un solo fragmento de miles de caracteres. Edge TTS tarda entonces
    // varios minutos y la locución se pierde por timeout (por eso no se
    // oía a Dany). Aquí se divide en trozos manejables conservando el
    // interventionId, de modo que los fragmentos suenan seguidos y el
    // "ciclo continuo" (ducking y pausa sin restore) se mantiene.
    const maxChunk = this.config.queue?.maxChunkChars ?? 420
    const partes = (request.totalFragments ?? 1) <= 1 && text.length > maxChunk
      ? this._chunkText(text, maxChunk)
      : [text]
    if (partes.length > 1) {
      const interventionId = request.interventionId || id
      const encolados = []
      for (let i = 0; i < partes.length; i++) {
        const r = this.enqueue({
          ...request,
          requestId: `${id}#${i}`,
          text: partes[i],
          interventionId,
          fragmentIndex: i,
          totalFragments: partes.length,
        })
        encolados.push(r)
      }
      logger.info('Texto troceado para síntesis', {
        requestId: id, source: request.source, chars: text.length, fragmentos: partes.length,
      })
      return { ok: true, requestId: id, chunked: true, fragments: partes.length, items: encolados }
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
      // 3 intentos: el servicio Edge TTS se cuelga de forma intermitente y
      // con textos largos puede tardar 40 s o más. Con 2 intentos y timeout de
      // 30 s la locución se perdía. Los textos se trocean a 420 caracteres,
      // así que 90 s por intento es holgado (peor caso ~4,5 min, y si aun así
      // falla la locución vuelve a la cola: no se pierde).
      maxAttempts: 3,
      retryCount: 0, // reintentos globales (la locución vuelve a la cola)
      notBefore: 0,   // no servir antes de este instante (backoff)
      // efímera: NO se guarda en el historial (ni en memoria ni en disco).
      // Se usa para el portapapeles, cuyo texto puede contener datos privados.
      ephemeral: request.ephemeral === true,
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
    this._startPrefetch()
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
    // Item marcado como "reproducir ya" (botón ▶ del panel): gana al resto,
    // incluido el round-robin entre fuentes. Se limpia cuando ya no está pendiente.
    if (this.frontId) {
      const f = this.items.get(this.frontId)
      if (f && f.status === 'queued' && (!f.notBefore || f.notBefore <= Date.now())) return f
      if (!f || ['done', 'error', 'cancelled'].includes(f.status)) this.frontId = null
    }
    // FAIRNESS entre fuentes (round-robin): sin esto, una fuente que genera
    // locuciones sin parar (p.ej. dsh2) MONOPOLIZA la cola y las demás
    // (dsh1, dany, claude) quedan enterradas: el usuario sólo oía una voz
    // ("no se escuchan los demás agentes"). Si la última locución servida fue
    // de la fuente X y hay items de OTRA fuente, se sirve la más antigua de
    // esa otra fuente. Sólo si no hay alternativa se sigue con X.
    const queued = []
    const ahora = Date.now()
    for (const id of this.order) {
      const u = this.items.get(id)
      // notBefore: la locución vuelve a la cola tras un fallo de síntesis y
      // espera su turno de reintento (backoff). No se sirve antes de tiempo.
      if (u && u.status === 'queued' && (!u.notBefore || u.notBefore <= ahora)) queued.push(u)
    }
    if (!queued.length) return null
    if (queued.length === 1) return queued[0]

    const masAntigua = (lista) => lista.reduce((a, b) => {
      const pa = PRIORITY_ORDER[a.priority] ?? 1
      const pb = PRIORITY_ORDER[b.priority] ?? 1
      if (pa !== pb) return pa < pb ? a : b
      if (a.seq !== b.seq) return a.seq < b.seq ? a : b
      return a.fragmentIndex <= b.fragmentIndex ? a : b
    })

    const ultima = this._lastServedSource
    if (ultima) {
      const alternativas = queued.filter(u => (u.source || '?') !== ultima)
      if (alternativas.length) return masAntigua(alternativas)
    }
    return masAntigua(queued)
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

  // Texto completo a sintetizar (incluye el anuncio de sesión/tarea).
  _fullText(utterance) {
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
    return fullText
  }

  // Lanza varias síntesis en paralelo para que la cola no se acumule:
  // Edge TTS tarda 30-40 s por fragmento y, de uno en uno, una cola de 100
  // locuciones tardaría más de una hora en vaciarse.
  _startPrefetch() {
    const conc = this.config.synthesis?.concurrency ?? 3
    if (conc <= 1 || this._prefetching) return
    this._prefetching = true
    setImmediate(() => {
      try {
        const ahora = Date.now()
        const slots = Math.max(0, conc - this._preSynth.size)
        if (slots > 0) {
          const candidatos = []
          for (const id of this.order) {
            const u = this.items.get(id)
            if (!u || u.status !== 'queued') continue
            if (u.notBefore && u.notBefore > ahora) continue
            if (this._preSynth.has(id)) continue
            candidatos.push(u)
            if (candidatos.length >= slots) break
          }
          for (const u of candidatos) {
            const fullText = this._fullText(u)
            const entry = { done: false, result: null }
            entry.promise = Promise.resolve()
              .then(() => this.deps.synthesize(fullText, { voice: u.voice, requestId: u.requestId }))
              .then(r => { entry.done = true; entry.result = r; return r })
              .catch(e => { entry.done = true; entry.result = { error: e.message }; return entry.result })
            this._preSynth.set(u.requestId, entry)
          }
        }
      } catch { /* noop */ } finally {
        this._prefetching = false
      }
    })
  }

  async _process(utterance) {
    const { synthesize, player, multimedia } = this.deps
    try {
      // 1. Anuncio de sesión/tarea (si está habilitado y hay nombre).
      //    Prioridad de nombre: sessionName (real, desde disco) > sessionTitle > taskTitle.
      const fullText = this._fullText(utterance)

      // 2. Síntesis
      utterance.status = 'synthesizing'
      utterance.synthStatus = 'synthesizing'
      this.emit('synthesizing', utterance)
      logger.info('Synthesizing', { requestId: utterance.requestId, voice: utterance.voice, textLen: fullText.length })

      let audioResult
      let attempt = 0
      // Si esta locución ya se estaba pre-sintetizando en paralelo, se usa
      // ese audio (sintetizado segundos antes) en vez de esperar otro turno.
      const pre = this._preSynth.get(utterance.requestId)
      if (pre) {
        this._preSynth.delete(utterance.requestId)
        try {
          audioResult = await pre.promise
        } catch (e) {
          audioResult = null
        }
        if (audioResult && audioResult.audio) {
          attempt = 1
          utterance.attempts = 1
          logger.info('Usando audio pre-sintetizado', { requestId: utterance.requestId })
        } else {
          audioResult = null
        }
      }
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
          // Backoff: la causa real de los fallos es que el servicio Edge TTS
          // se cuelga de forma intermitente; un reintento con espera suele
          // funcionar (medido: ~50% de éxito al segundo intento).
          await new Promise(r => setTimeout(r, 1500 * attempt))
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
        // Ciclo continuo: si esta locución es otro fragmento de la MISMA
        // intervención (mismo TTS), el ducking y la pausa YA están aplicados.
        // NO se restaura nada (ni volúmenes ni reanudación del video): antes se
        // restauraba aquí y la música volvía a 100% y el video se reanudaba
        // ENTRE fragmentos del mismo TTS ("la música no baja").
        const continua = !!(utterance.interventionId && utterance.interventionId === this._lastInterventionId)
        if (continua) {
          logger.info('Ciclo continuo: se mantiene ducking y pausa', { interventionId: utterance.interventionId })
        } else {
          try { await multimedia.restoreVolumes() } catch (e) {
            logger.warn('Multimedia restore previo failed (non-fatal)', { error: e.message })
          }
          try { await multimedia.applyDucking(utterance) } catch (e) {
            logger.warn('Multimedia ducking failed (non-fatal)', { error: e.message })
          }
        }
      }

      // 4. Reproducción con lock (volumen: mpv ya arranca con --volume=config.player.volume; no pisar por utterance)
      this.playing = utterance.requestId
      // Si este item estaba marcado como "reproducir ya", ya se sirvió: limpiar.
      if (this.frontId === utterance.requestId) this.frontId = null
      // Fairness: se recuerda la fuente servida para que la siguiente elija
      // otra fuente si hay alguna esperando (round-robin entre agentes).
      this._lastServedSource = utterance.source || '?'
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
        } else if (utterance.stoppedBySource) {
          // La fuente fue desactivada desde el panel: se detiene SOLO su audio.
          utterance.status = 'cancelled'
          utterance.playStatus = 'cancelled'
          utterance.finishedAt = Date.now()
          this._pushHistory(utterance)
          this._queueEvent({ requestId: utterance.requestId, state: 'cancelled', finishedAt: utterance.finishedAt })
          logger.info('Reproducción cancelada: fuente desactivada', { requestId: utterance.requestId, source: utterance.source })
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
        // Marca la intervención en curso: el siguiente fragmento del mismo TTS
        // mantiene el ducking y la pausa (ciclo continuo, sin restore).
        this._lastInterventionId = utterance.interventionId || null
      }
    } catch (e) {
      // Si falló la SÍNTESIS (no la reproducción), la locución NO se pierde:
      // vuelve a la cola para reintentarse más tarde. Antes un fallo de
      // edge-tts (su Timeout) descartaba el mensaje para siempre y el usuario
      // sencillamente no oía lo que el agente acababa de decir. Es lo que
      // pasaba con Dany, cuyos mensajes llegan a 3.900 caracteres.
      const falloSintesis = utterance.synthStatus === 'error'
      const maxReintentos = this.config.queue?.maxRetries ?? 6
      const reintento = utterance.retryCount || 0
      if (falloSintesis && reintento < maxReintentos) {
        utterance.retryCount = reintento + 1
        utterance.status = 'queued'
        utterance.synthStatus = 'queued'
        utterance.error = e.message
        utterance.attempts = 0
        utterance.finishedAt = null
        const espera = Math.min(45000, 5000 * utterance.retryCount)
        utterance.notBefore = Date.now() + espera
        this._queueEvent({ requestId: utterance.requestId, state: 'queued', createdAt: utterance.createdAt })
        logger.warn('Síntesis fallida: la locución vuelve a la cola para reintento', {
          requestId: utterance.requestId, source: utterance.source, sessionId: utterance.sessionId,
          reintento: utterance.retryCount, esperaMs: espera, error: e.message,
        })
        this.playing = null
        this._releaseLock()
        if (multimedia) {
          try { await multimedia.restoreVolumes() } catch { /* ignore */ }
        }
        // Programa el reintento cuando venza la espera.
        const t = setTimeout(() => { try { this._pump() } catch { /* noop */ } }, espera + 250)
        if (t.unref) t.unref()
        this._pump()
        return
      }
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
    this._startPrefetch()
    this._pump()
  }

  // --- Historial de locuciones (en memoria, últimas N) ---
  _pushHistory(u) {
    // Locución efímera (portapapeles): el texto puede contener contraseñas o
    // datos privados, así que NO se guarda ni en memoria ni en el historial
    // persistente. Solo se deja constancia de que ocurrió, sin su contenido.
    if (u.ephemeral) {
      logger.info('Locución efímera servida (no se guarda en el historial)', {
        requestId: u.requestId, source: u.source, chars: (u.text || '').length,
      })
      return
    }
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

  /**
   * Detiene la reproducción ACTUAL solo si pertenece a la fuente indicada.
   * Se usa al desactivar una fuente desde el panel: se detiene únicamente su
   * audio; no se toca el agente, ni las demás fuentes, ni la cola pendiente.
   */
  stopCurrentIfSource(sourceRaw) {
    if (!this.playing) return { ok: false, stopped: false, reason: 'no-current' }
    const cur = this.items.get(this.playing)
    if (!cur) return { ok: false, stopped: false, reason: 'no-current' }
    if (String(cur.source || '').toLowerCase() !== String(sourceRaw || '').toLowerCase()) {
      return { ok: false, stopped: false, reason: 'different-source', current: cur.source }
    }
    // El _process marca el item como cancelado al resolverse el play.
    cur.stoppedBySource = true
    try { this.deps.player?.stop() } catch { /* el play resolverá solo */ }
    logger.info('Detenida reproducción de fuente desactivada', { requestId: cur.requestId, source: cur.source })
    return { ok: true, stopped: true, requestId: cur.requestId }
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

  // IDs de los items que el panel MUESTRA (pendientes o sonando), en orden.
  _visibleIds() {
    return this.order.filter(id => {
      const u = this.items.get(id)
      return u && ['queued', 'synthesizing', 'ready', 'playing'].includes(u.status)
    })
  }

  // Posición VISIBLE del item (solo los que el panel muestra: pendientes/sonando).
  _visiblePosition(id) {
    let pos = 0
    for (const rid of this._visibleIds()) {
      pos++
      if (rid === id) return pos
    }
    return 0
  }

  // --- Reordenar la cola a mano (flechitas ↑/↓ del panel) ---
  // Mueve un item una posición dentro del orden visible y reasigna los `seq`
  // para que el orden manual también se respete al servir (la cola ordena por
  // prioridad, luego seq). Los fragmentos de una intervención conservan su
  // orden relativo porque el array `order` ya los tenía en orden.
  moveInQueue(requestId, direction) {
    const u = this.items.get(requestId)
    if (!u) return { ok: false, error: 'no encontrado' }
    if (u.status !== 'queued') return { ok: false, error: 'ya no está pendiente' }
    // El movimiento es dentro de la lista VISIBLE (lo que el panel muestra):
    // el array interno `order` también guarda lo ya reproducido, y moverse ahí
    // no se notaría en pantalla.
    const visibles = this._visibleIds()
    const vi = visibles.indexOf(requestId)
    if (vi === -1) return { ok: false, error: 'no está en la cola' }
    const vj = direction === 'up' ? vi - 1 : direction === 'down' ? vi + 1 : -1
    if (vj < 0) return { ok: false, error: 'ya está al principio' }
    if (vj >= visibles.length) return { ok: false, error: 'ya está al final' }
    // Intercambiar las posiciones reales dentro de `order`.
    const ia = this.order.indexOf(requestId)
    const ib = this.order.indexOf(visibles[vj])
    this.order[ia] = visibles[vj]
    this.order[ib] = requestId
    this._resequence()
    const pos = this._visiblePosition(requestId)
    logger.info('Locución movida en la cola', { requestId, direction, position: pos })
    return { ok: true, requestId, direction, position: pos }
  }

  // Reasigna seq según el orden visible de la cola.
  _resequence() {
    let seq = 0
    for (const id of this.order) {
      const u = this.items.get(id)
      if (!u) continue
      if (u.status === 'queued') { u.seq = seq; seq++ }
    }
  }

  // --- Reproducir YA: al frente de la cola, deteniendo la locución en curso ---
  playNow(requestId) {
    const u = this.items.get(requestId)
    if (!u) return { ok: false, error: 'no encontrado' }
    if (this.playing === requestId) return { ok: true, alreadyPlaying: true, requestId }
    if (u.status !== 'queued') return { ok: false, error: 'no está pendiente' }
    // 1) al frente de la lista VISIBLE (lo primero que se ve en el panel)
    const visibles = this._visibleIds()
    const primero = visibles.find(vid => vid !== requestId)
    if (primero) {
      const ia = this.order.indexOf(requestId)
      if (ia !== -1) this.order.splice(ia, 1)
      const ib = this.order.indexOf(primero)
      this.order.splice(ib === -1 ? 0 : ib, 0, requestId)
    }
    this._resequence()
    // 2) marcarlo para que _next() lo sirva primero (gana al round-robin)
    this.frontId = requestId
    // 2b) Si aún no está sintetizado, lanzar SU síntesis ahora mismo (no esperar
    //     al turno normal del pre-synth): así el botón ▶ suena lo antes posible.
    if (u.synthStatus !== 'ready' && !this._preSynth.has(requestId)) {
      try {
        const fullText = this._fullText(u)
        const entry = { done: false, result: null }
        entry.promise = Promise.resolve()
          .then(() => this.deps.synthesize(fullText, { voice: u.voice, requestId }))
          .then(r => { entry.done = true; entry.result = r; return r })
          .catch(e => { entry.done = true; entry.result = { error: e.message }; return entry.result })
        this._preSynth.set(requestId, entry)
        logger.info('Síntesis inmediata para la locución prioritaria', { requestId })
      } catch (e) { /* si falla, se sintetiza en el turno normal */ }
    }
    // 3) detener lo que esté sonando ahora mismo
    let stopped = null
    if (this.playing) {
      stopped = this.stopCurrent()
    }
    logger.info('Locución enviada al frente de la cola', { requestId, stopped: !!stopped?.ok })
    // 4) arrancar
    this._pump()
    return { ok: true, requestId, stopped: !!stopped?.ok, position: this._visiblePosition(requestId) }
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
        text: String(u.text || ''),
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
