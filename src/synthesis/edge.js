// Síntesis TTS usando edge-tts CLI (mismo motor que el plugin dsh-tts).
// Genera archivos MP3 en disco para que mpv los reproduzca.

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { logger } from '../monitoring/logger.js'

// El catálogo de voces no cambia: se cachea 10 min para no invocar edge-tts cada vez.
const VOICE_CATALOG_TTL_MS = 10 * 60 * 1000

export class EdgeSynthesizer {
  constructor(config) {
    this.config = config
    this.bin = config.synthesis?.edgeBin || 'edge-tts'
    this.timeoutMs = config.synthesis?.timeoutMs || 60000
    this.cacheDir = config.synthesis?.cacheDir || join(tmpdir(), 'ciudadan-tts-cache')
    this.cacheEnabled = config.synthesis?.cacheEnabled !== false
    this.cacheMaxBytes = (config.synthesis?.cacheMaxMb || 200) * 1024 * 1024
    this._catalogCache = null
    this._ensureCacheDir()
  }

  async _ensureCacheDir() {
    try { await mkdir(this.cacheDir, { recursive: true }) } catch { /* ignore */ }
  }

  _cacheKey(text, voice) {
    return createHash('sha256').update(`${voice}:${text}`).digest('hex').slice(0, 32)
  }

  async _cleanCache() {
    if (!this.cacheEnabled) return
    try {
      const files = await readdir(this.cacheDir)
      let total = 0
      const entries = []
      for (const f of files) {
        const p = join(this.cacheDir, f)
        const s = await stat(p).catch(() => null)
        if (s) { total += s.size; entries.push({ p, mtime: s.mtimeMs, size: s.size }) }
      }
      if (total > this.cacheMaxBytes) {
        entries.sort((a, b) => a.mtime - b.mtime) // LRU: más viejos primero
        for (const e of entries) {
          if (total <= this.cacheMaxBytes) break
          await unlink(e.p).catch(() => {})
          total -= e.size
        }
      }
    } catch { /* ignore cache errors */ }
  }

  /**
   * Sintetiza texto a MP3 usando edge-tts.
   * @returns {Promise<{audio: Buffer, path: string, mime: string, cached: boolean}>}
   */
  async synthesize(text, opts = {}) {
    const voice = opts.voice || 'es-CO-SalomeNeural'
    const cleanText = String(text || '').trim()
    if (!cleanText) throw new Error('empty text')

    // Cache lookup
    const key = this._cacheKey(cleanText, voice)
    const cachePath = join(this.cacheDir, key + '.mp3')
    if (this.cacheEnabled) {
      try {
        const cached = await readFile(cachePath)
        if (cached.length > 32) {
          logger.debug('Cache hit', { voice, key })
          return { audio: cached, path: cachePath, mime: 'audio/mpeg', cached: true }
        }
      } catch { /* no está en cache */ }
    }

    // Síntesis con edge-tts
    const tmpDir = await mkdtemp(join(tmpdir(), 'ciudadan-edge-'))
    const outFile = join(tmpDir, 'out.mp3')
    const textFile = join(tmpDir, 'input.txt')
    try {
      // El texto va por ARCHIVO en UTF-8, no como argumento de consola: en Windows
      // los argumentos se decodifican con la codificación de la consola (cp1252) y
      // los acentos se perdían ("Ó" -> "?") al sintetizar.
      const { writeFile: writeFileUtf8 } = await import('node:fs/promises')
      await writeFileUtf8(textFile, cleanText, 'utf8')
      await this._runEdgeTts(cleanText, voice, outFile, textFile)
      const audio = await readFile(outFile)
      if (!audio || audio.length < 32) throw new Error('edge-tts produced empty audio')

      // Guardar en cache
      if (this.cacheEnabled) {
        try {
          await this._ensureCacheDir()
          const { writeFile } = await import('node:fs/promises')
          await writeFile(cachePath, audio)
          this._cleanCache()
        } catch { /* cache write is best-effort */ }
        return { audio, path: cachePath, mime: 'audio/mpeg', cached: false }
      }
      // Sin cache: copiar a archivo temporal persistente
      const { writeFile } = await import('node:fs/promises')
      const persistPath = join(tmpDir, 'persist.mp3')
      await writeFile(persistPath, audio)
      return { audio, path: persistPath, mime: 'audio/mpeg', cached: false, _tmpDir: tmpDir }
    } catch (e) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
      throw e
    }
  }

  _runEdgeTts(text, voice, outFile, textFile) {
    return new Promise((resolve, reject) => {
      // --file (UTF-8) en lugar de --text: sin corrupción de acentos y sin el
      // límite de longitud de la línea de comandos de Windows (~32k).
      const args = textFile
        ? ['--voice', voice, '--file', textFile, '--write-media', outFile]
        : ['--voice', voice, '--text', text, '--write-media', outFile]
      logger.debug('Spawning edge-tts', { voice, textLen: text.length })
      const proc = spawn(this.bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      const errChunks = []
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL') } catch { /* gone */ }
        reject(new Error(`edge-tts timeout after ${this.timeoutMs}ms (voice: ${voice})`))
      }, this.timeoutMs)

      proc.stderr.on('data', (c) => errChunks.push(c))
      proc.on('error', (e) => {
        clearTimeout(timer)
        reject(new Error(`edge-tts unavailable: ${e.message}`))
      })
      proc.on('close', (code) => {
        clearTimeout(timer)
        if (code !== 0) {
          const stderr = Buffer.concat(errChunks).toString('utf8').slice(0, 300)
          reject(new Error(`edge-tts exit ${code}: ${stderr}`))
          return
        }
        resolve()
      })
    })
  }

  async listVoices() {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.bin, ['--list-voices'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      const out = []
      proc.stdout.on('data', (c) => out.push(c))
      proc.on('close', (code) => {
        if (code !== 0) return reject(new Error(`exit ${code}`))
        const text = Buffer.concat(out).toString('utf8')
        const voices = text.split('\n')
          .map(l => l.trim())
          .filter(l => l.startsWith('es-'))
          .map(l => l.split(/\s+/)[0])
        resolve(voices)
      })
      proc.on('error', reject)
    })
  }

  /**
   * Catálogo COMPLETO de voces de edge-tts con género, región, idioma y
   * personalidad. Es lo que consume el selector de voces del panel.
   * No modifica el motor de síntesis: solo lee `edge-tts --list-voices`.
   */
  async listVoiceCatalog() {
    if (this._catalogCache && Date.now() - this._catalogCache.at < VOICE_CATALOG_TTL_MS) {
      return this._catalogCache.voices
    }
    const voices = await new Promise((resolve, reject) => {
      const proc = spawn(this.bin, ['--list-voices'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      const out = []
      proc.stdout.on('data', (c) => out.push(c))
      proc.on('close', (code) => {
        if (code !== 0) return reject(new Error(`exit ${code}`))
        const text = Buffer.concat(out).toString('utf8')
        const list = []
        for (const line of text.split('\n')) {
          const t = line.trim()
          if (!t) continue
          if (/^Name\s+Gender/i.test(t)) continue
          if (/^-+/.test(t)) continue
          const cols = t.split(/\s{2,}/).map(c => c.trim()).filter(Boolean)
          if (cols.length < 2) continue
          const id = cols[0]
          if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){1,3}-[A-Za-z]+/.test(id)) continue
          const segs = id.split('-')
          const language = segs[0]
          // La región es el primer segmento de 2 letras MAYÚSCULAS (p.ej. "es-MX",
          // "sr-Latn-RS" -> RS). Si no hay, se usa el segundo segmento.
          const regionIdx = segs.findIndex((s, i) => i > 0 && /^[A-Z]{2}$/.test(s))
          const country = regionIdx > 0 ? segs[regionIdx] : (segs[1] || '').toUpperCase()
          list.push({
            id,
            name: voiceDisplayName(id),
            gender: cols[1] || '',
            language,
            country,
            locale: regionIdx > 0 ? language + '-' + country : id.slice(0, 5),
            categories: cols[2] || '',
            personalities: cols[3] || '',
            spanish: language === 'es',
          })
        }
        resolve(list)
      })
      proc.on('error', reject)
    })
    this._catalogCache = { at: Date.now(), voices }
    return voices
  }
}

// Nombre legible de una voz: es-MX-DaliaNeural -> Dalia
function voiceDisplayName(id) {
  const parts = String(id).split('-')
  const name = parts.slice(2).join('-') || parts[parts.length - 1] || id
  return name.replace(/Neural$/i, '').replace(/(\w)(\w*)/, (_, a, b) => a + b.toLowerCase())
}