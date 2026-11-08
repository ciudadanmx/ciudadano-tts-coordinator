// Health checks técnicos reales (sin IA).

import { logger } from './logger.js'

export class HealthMonitor {
  constructor(deps) {
    this.deps = deps // { player, queue, synthesizer, multimedia }
    this.lastHeartbeat = Date.now()
    this.errors = []
    this.maxErrors = 50
  }

  heartbeat() {
    this.lastHeartbeat = Date.now()
  }

  check() {
    const checks = {
      player: this._checkPlayer(),
      synthesizer: this._checkSynthesizer(),
      queue: this._checkQueue(),
      multimedia: this._checkMultimedia(),
      memory: this._checkMemory(),
      uptime: process.uptime(),
    }
    const allHealthy = Object.values(checks).every(c => c.status === 'healthy' || c.status === 'degraded')
    return {
      service: 'ciudadan-tts-coordinator',
      status: allHealthy ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      lastHeartbeat: new Date(this.lastHeartbeat).toISOString(),
      checks,
      recentErrors: this.errors.slice(-10),
    }
  }

  recordError(component, error) {
    this.errors.push({
      ts: new Date().toISOString(),
      component,
      error: String(error?.message || error),
    })
    if (this.errors.length > this.maxErrors) this.errors.shift()
  }

  _checkPlayer() {
    const p = this.deps.player
    if (!p) return { status: 'unhealthy', detail: 'no player' }
    if (p._connected && p.proc && !p.proc.killed) return { status: 'healthy', detail: 'mpv connected' }
    return { status: 'degraded', detail: 'mpv not connected (synthesis still available)' }
  }

  _checkSynthesizer() {
    const s = this.deps.synthesizer
    if (!s) return { status: 'unhealthy', detail: 'no synthesizer' }
    return { status: 'healthy', detail: `edge-tts at ${s.bin}` }
  }

  _checkQueue() {
    const q = this.deps.queue
    if (!q) return { status: 'unhealthy', detail: 'no queue' }
    const st = q.getStatus()
    return {
      status: 'healthy',
      detail: `speaking=${st.speaking}, queueLength=${st.queueLength}, lock=${!!st.lock}`,
    }
  }

  _checkMultimedia() {
    const m = this.deps.multimedia
    if (!m) return { status: 'degraded', detail: 'no multimedia controller' }
    return { status: 'healthy', detail: m.getStatus() }
  }

  _checkMemory() {
    const usage = process.memoryUsage()
    const heapMb = Math.round(usage.heapUsed / 1024 / 1024)
    return {
      status: heapMb > 500 ? 'degraded' : 'healthy',
      detail: `heap ${heapMb}MB, rss ${Math.round(usage.rss / 1024 / 1024)}MB`,
    }
  }
}
