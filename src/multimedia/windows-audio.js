// Puente de audio nativo para Windows usando Core Audio API vía Python (pycaw/comtypes).
// Mantiene UN proceso python en modo daemon (--daemon): lee JSON lines por stdin y responde
// por stdout — sin costo de arranque por llamada (evita carga CPU que corta el audio de mpv).

import { spawn } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { logger } from '../monitoring/logger.js'

const PY_SCRIPT = new URL('./audio-session.py', import.meta.url).pathname
  .replace(/^\/([A-Z]:)/, '$1')

function findPython() {
  return process.env.CIUDADAN_PYTHON || 'python'
}

export class WindowsAudioBridge {
  constructor() {
    this.available = false
    this.snapshotDir = mkdtempSync(join(tmpdir(), 'ciudadan-audio-'))
    this._proc = null
    this._buf = ''
    this._pending = new Map() // id -> {resolve, timer}
    this._seq = 0
    this._starting = null
  }

  async _ensureDaemon() {
    if (this._proc && this._proc.exitCode === null) return true
    if (this._starting) return this._starting
    this._starting = new Promise((resolve) => {
      let proc
      try {
        proc = spawn(findPython(), [PY_SCRIPT, '--daemon'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      } catch (e) {
        this._starting = null
        resolve(false)
        return
      }
      this._proc = proc
      this._buf = ''
      proc.stdout.on('data', (d) => {
        this._buf += d.toString('utf8')
        let idx
        while ((idx = this._buf.indexOf('\n')) >= 0) {
          const line = this._buf.slice(0, idx).trim()
          this._buf = this._buf.slice(idx + 1)
          if (!line) continue
          try {
            const msg = JSON.parse(line)
            const p = this._pending.get(msg.__id)
            if (p) {
              this._pending.delete(msg.__id)
              clearTimeout(p.timer)
              p.resolve(msg)
            }
          } catch { /* línea rota */ }
        }
      })
      proc.stderr.on('data', (d) => logger.debug('audio-daemon stderr', { data: d.toString().slice(0, 200) }))
      const onDead = () => {
        for (const [, p] of this._pending) { clearTimeout(p.timer); p.resolve({ error: 'daemon murió' }) }
        this._pending.clear()
        this._proc = null
        this._starting = null
      }
      proc.on('error', onDead)
      proc.on('close', onDead)
      // handshake
      this._callRaw({ action: 'list' }).then((r) => {
        this._starting = null
        resolve(!r.error)
      })
    })
    return this._starting
  }

  _callRaw(req, timeoutMs = 10000) {
    return new Promise((resolve) => {
      if (!this._proc || this._proc.exitCode !== null) { resolve({ error: 'daemon no activo' }); return }
      const id = ++this._seq
      const payload = JSON.stringify({ ...req, __id: id }) + '\n'
      const timer = setTimeout(() => {
        if (this._pending.has(id)) { this._pending.delete(id); resolve({ error: 'timeout' }) }
      }, timeoutMs)
      this._pending.set(id, { resolve, timer })
      try { this._proc.stdin.write(payload) } catch { resolve({ error: 'write failed' }) }
    })
  }

  async init() {
    try {
      const ok = await this._ensureDaemon()
      this.available = !!ok
      if (this.available) {
        const r = await this._callRaw({ action: 'list' })
        logger.info('Windows Audio Bridge OK — daemon pycaw activo', { sessionCount: r.sessions?.length || 0 })
      } else {
        logger.warn('Windows Audio Bridge no disponible (falta python/pycaw) — modo stub')
      }
    } catch (e) {
      logger.warn('Error inicializando Windows Audio Bridge', { error: e.message })
      this.available = false
    }
  }

  async _call(req) {
    if (!this.available) return { error: 'bridge not available' }
    const ok = await this._ensureDaemon()
    if (!ok) { this.available = false; return { error: 'daemon no disponible' } }
    return this._callRaw(req)
  }

  async listSessions() {
    if (!this.available) return { error: 'bridge not available', sessions: [] }
    return this._call({ action: 'list' })
  }

  /** Volumen actual (0-100) de un PID. null si no existe. */
  async getVolumeByPid(pid) {
    const r = await this._call({ action: 'get', pid: Number(pid) })
    if (r.error || !r.sessions?.length) return null
    return r.sessions[0].Volume
  }

  /** Fijar volumen (0-100) de un PID. */
  async setVolumeByPid(pid, volume) {
    const vol = Math.max(0, Math.min(100, Math.round(volume)))
    return this._call({ action: 'set', pid: Number(pid), volume: vol })
  }

  async duckApp(processNames, percentage) {
    if (!this.available) return { stub: true, processNames, percentage }
    if (!processNames?.length || percentage <= 0) return { stub: false, ducked: [] }
    const result = await this._call({ action: 'duck', names: processNames.join(','), pct: percentage })
    if (result.error) {
      logger.warn('duckApp falló', { error: result.error, processNames })
      return { stub: false, error: result.error, ducked: [] }
    }
    const snapFile = join(this.snapshotDir, `snap-${Date.now()}.json`)
    try { writeFileSync(snapFile, JSON.stringify(result)) } catch {}
    logger.info('Ducking aplicado', {
      processNames, percentage,
      ducked: result.ducked?.map(d => `${d.ProcessName}(${d.ProcessId}): ${d.PreviousVolume}%→${d.NewVolume}%`),
    })
    return {
      stub: false,
      processNames,
      percentage,
      previousVolumes: result.snapshots || [],
      duckedAt: Date.now(),
      snapshotFile: snapFile,
      ducked: result.ducked,
    }
  }

  async restoreApp(snapshot) {
    if (!this.available || snapshot.stub || !snapshot.previousVolumes?.length) return
    const result = await this._call({ action: 'restore', snapshots: snapshot.previousVolumes })
    if (result.error) {
      logger.warn('restoreApp falló', { error: result.error })
    } else {
      logger.info('Volumen restaurado', { restored: result.restored?.map(r => `${r.ProcessId}: ${r.RestoredVolume}%`) })
    }
  }

  async duckMultiple(appConfigs) {
    const snapshots = {}
    for (const [appKey, appCfg] of Object.entries(appConfigs)) {
      if (!appCfg.enabled || !appCfg.processNames?.length) continue
      const snap = await this.duckApp(appCfg.processNames, appCfg.percentage)
      if (snap && !snap.stub) snapshots[appKey] = snap
    }
    return snapshots
  }

  async restoreMultiple(snapshots) {
    for (const [, snap] of Object.entries(snapshots || {})) {
      await this.restoreApp(snap)
    }
  }

  async shutdown() {
    if (this._proc) { try { this._proc.kill() } catch {} this._proc = null }
  }
}
