// windows-sapi.js — sintetizador de respaldo 100% local (voz de Windows).
//
// POR QUE (10/11/2026): edge-tts depende del servicio de Microsoft por
// internet y en este equipo se cuelga de forma intermitente: medido 2 de 3
// pruebas de 120 s sin escribir un byte, y las que funcionaron tardaron 87 s.
// Cuando edge-tts falla, la locucion se perdia o sonaba entrecortada.
//
// QUE HACE: mantiene UN daemon de PowerShell (scripts/sapi-voice.ps1) que
// lee peticiones JSON por stdin. El motor de voz se carga una vez (~15 s la
// primera vez) y despues responde en menos de 1 segundo.
//
// Es el ultimo recurso: si edge-tts funciona, su audio (mejor calidad) gana.

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { logger } from '../monitoring/logger.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PS_SCRIPT = fileURLToPath(new URL('../../scripts/sapi-voice.ps1', import.meta.url))
const POWERSHELL = 'powershell.exe'

export class WindowsSapi {
  constructor(opts = {}) {
    this.proc = null
    this.pending = new Map()
    this.buf = ''
    this.seq = 0
    this.ready = false
    this.starting = null
    this.voice = opts.voice || null
    this.available = false
    this.lastError = null
  }

  /**
   * Copia el daemon a una ruta LOCAL (powershell.exe no abre scripts por UNC).
   * El nombre lleva un hash del contenido para no arrastrar una version vieja.
   */
  _localScript() {
    if (this._localScriptPath) return this._localScriptPath
    try {
      const src = readFileSync(PS_SCRIPT)
      const hash = createHash('sha1').update(src).digest('hex').slice(0, 10)
      const dir = join(tmpdir(), 'ciudadan-tts-sapi')
      mkdirSync(dir, { recursive: true })
      const dst = join(dir, `sapi-voice-${hash}.ps1`)
      copyFileSync(PS_SCRIPT, dst)
      this._localScriptPath = dst
      return dst
    } catch (e) {
      logger.warn('No se pudo copiar el daemon SAPI a local', { error: e.message })
      return PS_SCRIPT
    }
  }

  async _ensure() {
    if (this.proc && this.proc.exitCode === null && this.ready) return true
    if (this.starting) return this.starting
    this.starting = new Promise((resolve) => {
      let settled = false
      const done = (v) => { if (!settled) { settled = true; resolve(v) } }
      try {
        // powershell.exe NO acepta rutas UNC en -File ("no existe"), y el
        // runtime vive en Kompa (UNC). Por eso el script se copia a una ruta
        // LOCAL y se ejecuta desde ahi.
        const localScript = this._localScript()
        const proc = spawn(POWERSHELL, [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', localScript,
        ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
        this.proc = proc
        proc.stdout.on('data', (c) => this._onData(c))
        proc.stderr.on('data', (c) => {
          const s = c.toString('utf8').trim()
          if (s) logger.debug('sapi stderr', { s: s.slice(0, 200) })
        })
        proc.on('error', (e) => {
          this.lastError = e.message
          this.available = false
          this.ready = false
          this._failAll(e.message)
          done(false)
        })
        proc.on('close', (code) => {
          this.ready = false
          this.available = false
          this._failAll(`daemon SAPI terminado (code ${code})`)
          done(false)
        })
        // El daemon puede tardar hasta ~20 s en arrancar (carga el motor de voz
        // de Windows). Si se pasa de aqui, se marca como no disponible, pero el
        // proceso sigue vivo: cuando llegue la linea 'ready' queda utilizable.
        const t = setTimeout(() => { this.lastError = 'el daemon SAPI no arranco a tiempo'; done(false) }, 60000)
        this._onReady = () => { clearTimeout(t); done(true) }
      } catch (e) {
        this.lastError = e.message
        done(false)
      }
    }).finally(() => { this.starting = null })
    return this.starting
  }

  _onData(chunk) {
    this.buf += chunk.toString('utf8')
    let idx
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim()
      this.buf = this.buf.slice(idx + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.ready) {
        this.ready = true
        this.available = true
        this.voice = msg.voice || this.voice
        logger.info('Voz local de Windows lista (respaldo del sintetizador)', { voice: this.voice })
        if (this._onReady) { const r = this._onReady; this._onReady = null; r() }
        continue
      }
      const p = this.pending.get(msg.id)
      if (p) { this.pending.delete(msg.id); p.resolve(msg) }
    }
  }

  _failAll(error) {
    for (const [, p] of this.pending) p.resolve({ ok: false, error })
    this.pending.clear()
  }

  /**
   * Sintetiza texto a un WAV local. Nunca lanza: devuelve null si no se pudo.
   */
  async synthesize(text, outPath, opts = {}) {
    const ok = await this._ensure()
    if (!ok) {
      logger.warn('Respaldo local de voz no disponible', { error: this.lastError })
      return null
    }
    const id = String(++this.seq)
    const payload = JSON.stringify({
      id, text: String(text || ''), out: outPath,
      voice: opts.voice || this.voice, rate: opts.rate ?? 0, volume: opts.volume ?? 100,
    }) + '\n'
    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ ok: false, error: 'timeout del daemon SAPI' })
      }, opts.timeoutMs ?? 60000)
      this.pending.set(id, {
        resolve: (m) => { clearTimeout(timer); resolve(m) },
      })
      try {
        this.proc.stdin.write(payload)
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        resolve({ ok: false, error: e.message })
      }
    })
    if (!result.ok) {
      logger.warn('Fallo la voz local de respaldo', { error: result.error })
      return null
    }
    return { path: outPath, bytes: result.bytes, voice: result.voice }
  }

  stop() {
    try { this.proc?.stdin?.end() } catch { }
    try { this.proc?.kill?.() } catch { }
    this.proc = null
    this.ready = false
    this.available = false
  }
}
