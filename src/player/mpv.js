// Reproductor de audio independiente usando mpv vía IPC (JSON IPC sobre socket Unix/named pipe).
// En Windows usa named pipe; en Linux/macOS usa Unix socket.
// Detecta cierre/bloqueo del reproductor y permite recuperación automática.

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { connect } from 'node:net'
import { randomUUID } from 'node:crypto'
import { platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, unlinkSync } from 'node:fs'
import { logger } from '../monitoring/logger.js'

export class MpvPlayer extends EventEmitter {
  constructor(config) {
    super()
    this.name = 'mpv'
    this.config = config
    this.proc = null
    this.socket = null
    this.socketPath = null
    this.requestId = 0
    this.pendingCommands = new Map()
    this.playingFile = null
    this._playResolve = null
    this._playReject = null
    this._connected = false
    this._restartCount = 0
    this._lastRestart = 0
    this._intentionalStop = false
    this._watchdog = null
  }

  async start() {
    const isWindows = platform() === 'win32'
    this.socketPath = isWindows
      ? `\\\\.\\pipe\\ciudadan-mpv-${randomUUID().slice(0, 8)}`
      : join(tmpdir(), `ciudadan-mpv-${randomUUID().slice(0, 8)}.sock`)

    const args = [
      '--no-video',
      '--no-terminal',
      '--idle=yes',
      '--force-window=no',
      '--no-input-default-bindings',
      `--input-ipc-server=${this.socketPath}`,
      '--volume=' + (this.config.player?.volume ?? 300),
      '--volume-max=600',   // sin límite: permite amplificación real >100%
      '--audio-pitch-correction=yes',
      // loudnorm en modo LINEAR: aplica el gain al instante, sin esperar la
      // medición (3 s). Sin esto, en locuciones cortas el audio salía a
      // ~-20 LUFS en vez de -14 y se oía "muy bajito".
      '--af=loudnorm=I=-14:TP=-1.5:LRA=11:linear=true',
    ]
    // No usar audio device del navegador
    args.push('--ao=wasapi' ) // en Windows; en otros sistemas usar el default

    logger.info('Starting mpv', { socketPath: this.socketPath, args: args.join(' ') })
    this._intentionalStop = false
    this.proc = spawn(this.config.player?.mpvPath || 'mpv', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    this.proc.stderr.on('data', (d) => logger.debug('mpv stderr', { data: d.toString().slice(0, 200) }))
    this.proc.on('error', (e) => {
      logger.error('mpv spawn error', { error: e.message })
      this._handleCrash(e)
    })
    this.proc.on('close', (code) => {
      logger.warn('mpv process closed', { code, intentional: this._intentionalStop })
      if (!this._intentionalStop) this._handleCrash(new Error(`mpv exited with code ${code}`))
    })

    // Esperar a que el socket IPC esté disponible
    await this._waitForSocket(5000)
    this._connectSocket()
  }

  async _waitForSocket(timeoutMs) {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (platform() === 'win32') {
        // En Windows, el named pipe se crea casi inmediatamente; probar conexión
        try {
          await new Promise((resolve, reject) => {
            const s = connect(this.socketPath)
            s.on('connect', () => { s.destroy(); resolve() })
            s.on('error', reject)
            setTimeout(() => { s.destroy(); reject(new Error('timeout')) }, 500)
          })
          return
        } catch { /* reintentar */ }
      } else {
        if (existsSync(this.socketPath)) return
      }
      await new Promise(r => setTimeout(r, 100))
    }
    throw new Error('mpv IPC socket no disponible tras timeout')
  }

  _connectSocket() {
    this.socket = connect(this.socketPath)
    let buffer = ''
    this.socket.on('connect', () => {
      this._connected = true
      logger.info('mpv IPC connected', { socketPath: this.socketPath })
      this._setupWatchdog()
      this.emit('ready')
    })
    this.socket.on('data', (data) => {
      buffer += data.toString('utf8')
      let idx
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (!line) continue
        try {
          const msg = JSON.parse(line)
          this._handleMessage(msg)
        } catch { logger.debug('mpv IPC unparseable', { line: line.slice(0, 200) }) }
      }
    })
    this.socket.on('error', (e) => {
      logger.error('mpv IPC socket error', { error: e.message })
      this._handleCrash(e)
    })
    this.socket.on('close', () => {
      this._connected = false
      logger.warn('mpv IPC socket closed')
      if (!this._intentionalStop) this._handleCrash(new Error('IPC socket closed unexpectedly'))
    })
  }

  _setupWatchdog() {
    if (this._watchdog) clearInterval(this._watchdog)
    const interval = this.config.recovery?.playerCrashDetectionMs ?? 3000
    this._watchdog = setInterval(() => {
      if (!this._connected || !this.proc || this.proc.killed) {
        logger.warn('Watchdog detectó mpv caído')
        this._handleCrash(new Error('watchdog: mpv no responde'))
      }
    }, interval)
    if (this._watchdog.unref) this._watchdog.unref()
  }

  _handleMessage(msg) {
    // Respuesta a comando
    if (msg.request_id !== undefined && this.pendingCommands.has(msg.request_id)) {
      const { resolve, reject } = this.pendingCommands.get(msg.request_id)
      this.pendingCommands.delete(msg.request_id)
      if (msg.error && msg.error !== 'success') reject(new Error(msg.error))
      else resolve(msg.data)
      return
    }
    // Evento de mpv
    if (msg.event) {
      if (msg.event === 'end-file') {
        // Solo un eof REAL (el archivo terminó por sí mismo) cierra el play actual.
        // Los end-file 'stop' (loadfile replace / comando stop) NO resuelven aquí: stop() resuelve directo.
        logger.info('mpv end-file event', { raw: JSON.stringify(msg), hasResolve: !!this._playResolve, stopReq: this._stopRequested })
        if (msg.reason === 'eof' && this._playResolve) {
          const r = this._playResolve
          r() // finish() limpia _playResolve y resuelve; NO ponerlo null antes
        }
        this.emit('ended', { reason: msg.reason, entryId: msg.playlist_entry_id })
      } else if (msg.event === 'idle') {
        this.emit('idle')
      } else if (msg.event === 'playback-restart') {
        this.emit('started', { file: this.playingFile })
      } else if (msg.event === 'crash' || msg.event === 'error') {
        this._handleCrash(new Error(msg.error || 'mpv event error'))
      }
    }
  }

  _sendCommand(command, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this._connected || !this.socket) {
        reject(new Error('mpv IPC no conectado'))
        return
      }
      const id = ++this.requestId
      const payload = JSON.stringify({ command: [command, ...Object.values(params)], request_id: id }) + '\n'
      if (command === 'loadfile' || command === 'stop' || command === 'quit') {
        logger.info('mpv CMD enviado', { command, value: String(Object.values(params)[0]).slice(-60), entry: this._currentEntryId })
      }
      this.pendingCommands.set(id, { resolve, reject })
      try {
        this.socket.write(payload)
      } catch (e) {
        this.pendingCommands.delete(id)
        reject(e)
      }
      // Timeout del comando
      setTimeout(() => {
        if (this.pendingCommands.has(id)) {
          this.pendingCommands.delete(id)
          reject(new Error(`mpv command timeout: ${command}`))
        }
      }, 10000)
    })
  }

  async play(filePath, opts = {}) {
    if (!this._connected) throw new Error('mpv no está conectado')
    // Si había un play pendiente (reemplazado por este loadfile), resolverlo ya:
    // su end-file llegará con reason 'stop' y ya no debe esperarse.
    if (this._playResolve) {
      const r = this._playResolve
      r() // finish() es idempotente: resuelve su propia promesa y limpia sus timers
    }
    this.playingFile = filePath
    this._currentEntryId = null // lo fija el evento start-file
    // Volumen: solo se fija si se pide explícitamente; por defecto mpv usa --volume del arranque
    if (opts.volume !== undefined) {
      await this._sendCommand('set_property', { name: 'volume', value: opts.volume }).catch(() => {})
    }
    // Cargar y reproducir
    await this._sendCommand('loadfile', { name: filePath, value: 'replace' })
    // Obtener duración del archivo para medir cortes (duration en segundos)
    let expectedSec = null
    try {
      const d = await this._sendCommand('get_property', { name: 'duration' })
      if (typeof d === 'number') expectedSec = d
    } catch { /* puede no estar listo aún */ }
    this._playStartedAt = Date.now()
    this._playExpectedSec = expectedSec
    if (expectedSec) logger.info('mpv duración esperada', { file: filePath, seconds: Math.round(expectedSec * 100) / 100 })
    // Devolver promesa que se resuelve cuando termina el archivo.
    // Cada reproducción tiene su propio estado `settled`: finish() SIEMPRE resuelve su
    // propia promesa, aunque otra reproducción haya tomado el slot global _playResolve.
    // (Si no, una locución puede quedar colgada para siempre y congelar la cola.)
    return new Promise((resolve, reject) => {
      const origResolve = resolve
      const origReject = reject
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        if (this._playSafetyTimer) { clearTimeout(this._playSafetyTimer); this._playSafetyTimer = null }
        if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null }
        if (this._playResolve === finish) { this._playResolve = null; this._playReject = null }
        const realSec = this._playStartedAt ? (Date.now() - this._playStartedAt) / 1000 : null
        if (this._playExpectedSec && realSec && this._playResolveOwner === finish) {
          const diff = realSec - this._playExpectedSec
          if (Math.abs(diff) > 1.5) {
            logger.warn('⚠ Duración real difiere de la esperada (posible corte)', {
              file: filePath,
              esperada: Math.round(this._playExpectedSec * 100) / 100,
              real: Math.round(realSec * 100) / 100,
              diff: Math.round(diff * 100) / 100,
            })
          } else {
            logger.info('mpv duración OK', { esperada: Math.round(this._playExpectedSec * 100) / 100, real: Math.round(realSec * 100) / 100 })
          }
        }
        this.playingFile = null
        origResolve()
      }
      this._playResolve = finish
      this._playReject = reject
      this._playResolveOwner = finish
      this._stopRequested = false
      this._pollStarted = false // true cuando vimos playback-pos numérico (ya empezó a sonar)
      this._pollTimer = setInterval(async () => {
        if (settled) return
        if (this._stopRequested) { finish(); return }
        try {
          // eof-reached no existe en mpv 0.41; usamos core-idle + playback-pos
          const idle = await this._sendCommand('get_property', { name: 'core-idle' }).catch(() => null)
          const pos = await this._sendCommand('get_property', { name: 'playback-pos' }).catch(() => null)
          if (typeof pos === 'number') this._pollStarted = true
          this._pollCount = (this._pollCount || 0) + 1
          if (this._pollCount % 150 === 0) logger.info('mpv poll', { pos, idle, file: String(filePath).slice(-40) })
          // Respaldo SOLO ante eof perdido: idle sin posición por más de 30s (loudnorm puede tardar unos segundos en arrancar)
          if (idle === true && (pos === null || pos === undefined) && (Date.now() - this._playStartedAt) > 30000) { finish(); return }
        } catch (e) { this._pollErr = (this._pollErr || 0) + 1; if (this._pollErr % 150 === 1) logger.warn('mpv poll error', { error: e.message }) }
      }, 400)
      if (this._pollTimer.unref) this._pollTimer.unref()
      // Timeout de seguridad: se limpia al terminar esta reproducción (nunca queda huérfano)
      const lockTimeout = this.config.queue?.lockTimeoutMs ?? 120000
      const override = this.config.player?.playSafetyTimeoutMs
      const safetyMs = override
        ? Math.max(2000, override)
        : Math.max(lockTimeout, (expectedSec || 0) * 1000 + 120000)
      this._playSafetyTimer = setTimeout(() => {
        // Solo aplica si ESTA reproducción sigue vigente
        if (this._playResolve !== finish) return
        logger.warn('Play timeout, forzando resolución', { file: filePath, timeoutMs: safetyMs })
        finish()
      }, safetyMs)
      if (this._playSafetyTimer.unref) this._playSafetyTimer.unref()
    })
  }

  async pause() {
    if (!this._connected) return
    await this._sendCommand('set_property', { name: 'pause', value: true }).catch(e => logger.warn('pause failed', { error: e.message }))
  }

  async resume() {
    if (!this._connected) return
    await this._sendCommand('set_property', { name: 'pause', value: false }).catch(e => logger.warn('resume failed', { error: e.message }))
  }

  async stop() {
    if (!this._connected) return
    this._intentionalStop = true
    this._stopRequested = true
    logger.warn('mpv STOP llamado', { stack: new Error('trace').stack?.split('\n').slice(1, 5).join(' | ') })
    // Resolver YA la promesa de play pendiente (no esperar al poller ni al end-file)
    if (this._playResolve) {
      const r = this._playResolve
      r() // finish() limpia y resuelve
    }
    try { await this._sendCommand('stop') } catch { /* ignorar */ }
    // Resolver la promesa de reproducción pendiente ANTES de limpiar el slot global:
    // finish() es idempotente por reproducción y limpia sus propios timers.
    if (this._playResolve) {
      const r = this._playResolve
      r()
      this._playResolve = null
      this._playReject = null
    }
    if (this._playSafetyTimer) { clearTimeout(this._playSafetyTimer); this._playSafetyTimer = null }
    this.playingFile = null
    this._intentionalStop = false
  }

  async skip() {
    // Saltar al siguiente: detener el actual
    await this.stop()
  }

  async setVolume(vol) {
    if (!this._connected) return
    await this._sendCommand('set_property', { name: 'volume', value: vol }).catch(() => {})
  }

  async getVolume() {
    if (!this._connected) return this.config.player?.volume ?? 100
    try {
      const r = await this._sendCommand('get_property', { name: 'volume' })
      return typeof r === 'number' ? Math.round(r) : (this.config.player?.volume ?? 100)
    } catch { return this.config.player?.volume ?? 100 }
  }

  async isPaused() {
    if (!this._connected) return false
    try {
      const r = await this._sendCommand('get_property', { name: 'pause' })
      return r === true
    } catch { return false }
  }

  async isPlaying() {
    if (!this._connected) return false
    try {
      const r = await this._sendCommand('get_property', { name: 'pause' })
      return r === false
    } catch { return false }
  }

  _handleCrash(err) {
    logger.error('mpv crash detectado', { error: err.message, restartCount: this._restartCount })
    this._connected = false
    // Rechazar comando pendiente de reproducción
    if (this._playReject) {
      const r = this._playReject
      this._playResolve = null
      this._playReject = null
      r(err)
    }
    this.emit('crash', err)
    // Recuperación automática
    const maxRestarts = this.config.player?.maxRestarts ?? 5
    const windowMs = this.config.player?.restartWindowMs ?? 60000
    const now = Date.now()
    if (now - this._lastRestart > windowMs) this._restartCount = 0
    this._lastRestart = now
    if (this._restartCount < maxRestarts && (this.config.player?.restartOnCrash !== false)) {
      this._restartCount++
      logger.info(`Reiniciando mpv (intento ${this._restartCount}/${maxRestarts})`)
      setTimeout(() => {
        this.start().catch(e => {
          logger.error('Fallo al reiniciar mpv', { error: e.message })
          this.emit('fatal', e)
        })
      }, 1000)
    } else {
      logger.error('Máximo de reintentos de mpv alcanzado')
      this.emit('fatal', err)
    }
  }

  async shutdown() {
    this._intentionalStop = true
    if (this._watchdog) clearInterval(this._watchdog)
    try { await this._sendCommand('quit') } catch { /* ignorar */ }
    if (this.proc) {
      try { this.proc.kill() } catch { /* ignorar */ }
    }
    if (this.socket) {
      try { this.socket.destroy() } catch { /* ignorar */ }
    }
    if (platform() !== 'win32' && this.socketPath && existsSync(this.socketPath)) {
      try { unlinkSync(this.socketPath) } catch { /* ignorar */ }
    }
  }
}
