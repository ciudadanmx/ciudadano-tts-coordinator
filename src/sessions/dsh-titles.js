// Resuelve títulos REALES de sesiones DSH leyendo los archivos session*.jsonl.zstd
// de ~/.dsh/sessions y ~/.dsh-2/sessions vía python+zstandard (con caché por mtime).
// Refresca en segundo plano cada 20s.

import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'
import { logger } from '../monitoring/logger.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PY = join(HERE, 'read-titles.py')
const STATE_DIR = join(homedir(), '.ciudadan-tts-coordinator')
const CACHE = join(STATE_DIR, 'dsh-titles-cache.json')
// Python con ruta absoluta (el proceso puede arrancar sin PATH completo)
const PYTHON = 'C:\\Python313\\python.exe'
// Homes DSH: migrados a Kompa (2026-11-07); se mantienen los locales como fallback
const HOMES = [
  '\\\\192.168.1.7\\Kompa\\_dsh_profiles\\dsh1',
  '\\\\192.168.1.7\\Kompa\\_dsh_profiles\\dsh2',
  join(homedir(), '.dsh'),
  join(homedir(), '.dsh-2'),
]

export class DshTitleResolver {
  constructor() {
    this.titles = new Map()
    this.timer = null
    this._lastRefresh = 0
    this._running = false
  }

  start() {
    try { mkdirSync(STATE_DIR, { recursive: true }) } catch {}
    // primer refresh diferido y ASYNC para no bloquear el arranque del servidor
    setTimeout(() => this.refresh(), 500)
    this.timer = setInterval(() => this.refresh(), 20000)
    if (this.timer.unref) this.timer.unref()
  }

  refresh() {
    if (this._running) return
    this._running = true
    try {
      const child = spawn(PYTHON, [PY, CACHE, ...HOMES], {
        windowsHide: true, maxBuffer: 64 * 1024 * 1024,
        // Forzar UTF-8 en el proceso Python: si stdout sale en cp1252, los acentos
        // se corrompen al decodificarlos como UTF-8 en Node ("Cómo" -> "C?mo").
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      })
      let out = ''
      let err = ''
      // CRÍTICO: decodificar UTF-8 con StringDecoder. Con d.toString() un carácter
      // multibyte partido entre dos chunks se pierde y queda como U+FFFD ("�"),
      // lo que rompía los acentos de los títulos ("Ó" -> "�").
      const decoder = new StringDecoder('utf8')
      const killer = setTimeout(() => { try { child.kill() } catch {} }, 180000)
      // Consumir línea por línea: el script emite el cache de inmediato y luego la versión actualizada
      let buf = ''
      child.stdout.on('data', d => {
        const text = decoder.write(d)
        out += text
        buf += text
        const lines = buf.split('\n')
        buf = lines.pop()
        for (const line of lines) {
          const t = line.trim()
          if (!t.startsWith('{')) continue
          try {
            const map = JSON.parse(t)
            if (map && typeof map === 'object') {
              this.titles = new Map(Object.entries(map))
              this._lastRefresh = Date.now()
            }
          } catch { /* línea parcial */ }
        }
      })
      child.stderr.on('data', d => { err += d.toString() })
      child.on('close', (code) => {
        clearTimeout(killer)
        this._running = false
        // Volcar los bytes finales que puedan quedar en el decoder
        try { buf += decoder.end() } catch {}
        const tail = buf.trim()
        if (tail.startsWith('{')) {
          try {
            const map = JSON.parse(tail)
            if (map && typeof map === 'object') {
              this.titles = new Map(Object.entries(map))
              this._lastRefresh = Date.now()
            }
          } catch { /* línea parcial */ }
        }
        if (code === 0) {
          logger.info('dsh titles actualizados', { titles: this.titles.size })
        } else if (err) {
          logger.warn('dsh titles: python falló', { stderr: err.slice(0, 200) })
        }
      })
      child.on('error', (e) => { clearTimeout(killer); this._running = false; logger.warn('dsh titles spawn falló', { error: e.message }) })
    } catch (e) {
      this._running = false
      logger.warn('dsh titles refresh falló (non-fatal)', { error: e.message })
    }
  }

  resolve(sessionId) {
    if (!sessionId) return ''
    const raw = String(sessionId).trim()
    if (!raw) return ''
    const direct = this.titles.get(raw)
    if (direct) return direct
    // Normalizar: el cliente puede mandar el UUID puro o con prefijo 'session-',
    // y en disco puede estar en cualquiera de las dos formas.
    const variants = new Set([raw])
    if (raw.startsWith('session-')) variants.add(raw.slice('session-'.length))
    else variants.add('session-' + raw)
    for (const v of variants) {
      const t = this.titles.get(v)
      if (t) return t
    }
    // Último recurso: comparar por UUID sin prefijo
    const uuid = raw.replace(/^session-/, '')
    for (const [k, t] of this.titles) {
      if (k.replace(/^session-/, '') === uuid) return t
    }
    return ''
  }

  get size() { return this.titles.size }
}
