// Síntesis TTS usando edge-tts CLI (mismo motor que el plugin dsh-tts).
// Genera archivos MP3 en disco para que mpv los reproduzca.

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { statSync, mkdirSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { logger } from '../monitoring/logger.js'
import { WindowsSapi } from './windows-sapi.js'

// El catálogo de voces no cambia: se cachea 10 min para no invocar edge-tts cada vez.
const VOICE_CATALOG_TTL_MS = 10 * 60 * 1000

export class EdgeSynthesizer {
  constructor(config) {
    this.config = config
    this.bin = config.synthesis?.edgeBin || 'edge-tts'
    // El lanzador `edge-tts.exe` es un WRAPPER que lanza python.exe como hijo:
    // si el hijo se queda colgado, el wrapper nunca cierra y la cola se atasca
    // (además el hijo huérfano no se puede identificar). Se usa el MÓDULO
    // directamente (python -m edge_tts) cuando hay un python configurado.
    this.python = config.synthesis?.edgePython || ''
    this.timeoutMs = config.synthesis?.timeoutMs || 30000
    this.cacheDir = config.synthesis?.cacheDir || join(tmpdir(), 'ciudadan-tts-cache')
    this.cacheEnabled = config.synthesis?.cacheEnabled !== false
    this.cacheMaxBytes = (config.synthesis?.cacheMaxMb || 200) * 1024 * 1024
    // Respaldo local (voz de Windows, sin internet): si edge-tts no contesta
    // a tiempo, la locución suena igual con la voz local en vez de perderse.
    this.localFallback = config.synthesis?.localFallback !== false
    this.fallbackAfterMs = config.synthesis?.fallbackAfterMs || 40000
    this._sapi = this.localFallback ? new WindowsSapi() : null
    this._catalogCache = null
    this._ensureCacheDir()
  }

  /**
   * Arranca en segundo plano el daemon de voz local (respaldo). Se llama al
   * iniciar el servidor para que su motor quede cargado antes de la primera
   * locucion: en frio cuesta ~15 s, en caliente responde en <1 s.
   */
  warmup() {
    if (!this._sapi) return
    const t = setTimeout(() => {
      this._sapi._ensure()
        .then((ok) => {
          if (ok) logger.info('Respaldo de voz local listo', { voice: this._sapi.voice })
          else logger.warn('El respaldo de voz local no arranco', { error: this._sapi.lastError })
        })
        .catch(() => {})
    }, 1500)
    if (t.unref) t.unref()
  }

  /** Comando real de síntesis: [python, -m, edge_tts, ...] o el binario directo. */
  _cmd(args) {
    if (this.python) return { file: this.python, args: ['-m', 'edge_tts', ...args] }
    return { file: this.bin, args }
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
      // Los MP3 temporales (cache deshabilitado) viven en cacheDir/tmp y se
      // purgan por antiguedad: ya fueron reproducidos.
      const tmpSub = join(this.cacheDir, 'tmp')
      try {
        const olds = await readdir(tmpSub)
        const cutoff = Date.now() - 30 * 60 * 1000
        for (const f of olds) {
          const p = join(tmpSub, f)
          const s = await stat(p).catch(() => null)
          if (s && s.mtimeMs < cutoff) await unlink(p).catch(() => {})
        }
      } catch { /* no hay subdir tmp */ }
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
          // Se reproduce desde disco LOCAL: mpv leyendo por SMB se atasca.
          const localPath = this._localPlayback(cached, '.mp3')
          return { audio: cached, path: localPath, mime: 'audio/mpeg', cached: true, cachePath }
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

      // CARRERA (10/11/2026): edge-tts depende de internet y se cuelga con
      // facilidad. Si no contesta en fallbackAfterMs, entra la voz LOCAL de
      // Windows (sin internet, <1 s con el motor caliente) y gana la que
      // termine primero. Así la locución NUNCA se pierde ni queda en silencio.
      const edgePromise = this._runEdgeTts(cleanText, voice, outFile, textFile)
      let resolveLocal = null
      const localSignal = new Promise((resolve) => { resolveLocal = resolve })
      let fallbackTimer = null
      let localLanzado = false
      const wavPath = join(tmpDir, 'local.wav')
      const lanzarLocal = () => {
        if (localLanzado) return
        localLanzado = true
        logger.warn('edge-tts no contesta: entra la voz local de respaldo', {
          voice, textLen: cleanText.length,
        })
        this._sapi.synthesize(cleanText, wavPath, { timeoutMs: 90000 })
          .then((r) => resolveLocal(r
            ? { ok: true, source: 'local', bytes: r.bytes, path: wavPath }
            : { ok: false, source: 'local' }))
          .catch(() => resolveLocal({ ok: false, source: 'local' }))
      }
      if (this._sapi) {
        fallbackTimer = setTimeout(lanzarLocal, this.fallbackAfterMs)
      }

      // edgePromise se convierte en un resultado (nunca una excepción) para que
      // un fallo de edge-tts NO termine la carrera: en ese caso gana el local.
      const edgeOutcome = edgePromise.then(
        () => ({ ok: true, source: 'edge' }),
        (e) => ({ ok: false, source: 'edge', error: e })
      )

      let winner
      try {
        winner = await Promise.race([edgeOutcome, localSignal])
      } finally {
        if (fallbackTimer) clearTimeout(fallbackTimer)
      }

      // Si el local falló (o no existía), se espera a edge-tts.
      if (!winner || winner.ok === false) {
        if (winner && winner.source === 'edge' && winner.error) {
          // edge-tts falló: si el local no llegó a tiempo, se le da su oportunidad.
          if (this._sapi && !localLanzado) {
            lanzarLocal()
            const local = await Promise.race([
              localSignal,
              new Promise((r) => setTimeout(() => r({ ok: false }), 90000)),
            ])
            if (local && local.ok) winner = local
          }
          if (!winner || winner.ok === false) throw winner?.error || new Error('no se pudo sintetizar')
        } else {
          winner = await edgeOutcome
          if (!winner.ok) throw winner.error
        }
      }

      if (winner.source === 'local') {
        // Ganó la voz local: el WAV ya está escrito en tmpDir.
        const audio = await readFile(wavPath)
        if (!audio || audio.length < 512) throw new Error('la voz local devolvio audio vacio')
        logger.info('Locucion servida con la voz local de respaldo', {
          voice, bytes: audio.length, textLen: cleanText.length,
        })
        return await this._persist(audio, cachePath, tmpDir, 'audio/wav', '.wav')
      }
      // edge terminó sin error: seguir con el MP3.

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
        // La carpeta temporal ya no sirve: el audio vive en el cache. Antes no
        // se borraba en el camino de exito y se acumulaban miles de carpetas
        // 'ciudadan-edge-*' en %TEMP% (291 MB y contando).
        await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
        // REPRODUCCION DESDE DISCO LOCAL (11/11/2026): mpv leia el audio desde
        // Kompa por SMB y se quedaba atascado ('mpv poll' con pos=null durante
        // 45 s, y un WAV de 865 KB tardaba >400 s en abrir). Medido: leer por
        // red hace que la voz se oiga cortada. Se copia a local y se reproduce
        // desde ahi; el cache en Kompa se conserva para no resintetizar.
        const localPath = this._localPlayback(audio, '.mp3')
        return { audio, path: localPath, mime: 'audio/mpeg', cached: false, cachePath }
      }
      // Sin cache: el MP3 debe sobrevivir hasta que el reproductor lo use, pero
      // tampoco en %TEMP%: se deja en el stateDir (Kompa), dentro de audio-cache/tmp,
      // que el limpiador del cache Eventually elimina por antiguedad.
      const { writeFile } = await import('node:fs/promises')
      const persistDir = join(this.cacheDir, 'tmp')
      await mkdir(persistDir, { recursive: true })
      const persistPath = join(persistDir, `${randomUUID()}.mp3`)
      await writeFile(persistPath, audio)
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
      return { audio, path: persistPath, mime: 'audio/mpeg', cached: false, _tmpDir: persistDir }
    } catch (e) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
      throw e
    }
  }

  /**
   * Copia el audio a DISCO LOCAL para que mpv lo reproduzca sin pasar por la
   * red. Medido el 11/11/2026: con el archivo en Kompa (SMB), mpv se quedaba
   * atascado ('pos:null' durante 45 s) y la voz se oia cortada; desde local
   * arranca al instante. Los archivos viejos (>10 min) se limpian aqui mismo,
   * sin depender del limpiador.
   */
  _localPlayback(audio, ext = '.mp3') {
    const dir = join(tmpdir(), 'ciudadan-audio-local')
    try { mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
    try {
      const cutoff = Date.now() - 10 * 60 * 1000
      for (const f of readdirSync(dir)) {
        const p = join(dir, f)
        try { if (statSync(p).mtimeMs < cutoff) unlinkSync(p) } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    const p = join(dir, `${randomUUID()}${ext}`)
    writeFileSync(p, audio)
    return p
  }

  /**
   * Guarda el audio de la voz local de respaldo. El WAV no entra en el cache de
   * MP3 (son formatos distintos) y NO se deja en Kompa: se reproduce desde
   * disco LOCAL, porque mpv leyendo por SMB se atasca y la voz sale cortada.
   */
  async _persist(audio, cachePath, tmpDir, mime, ext) {
    const localPath = this._localPlayback(audio, ext)
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    return { audio, path: localPath, mime, cached: false, fallback: true }
  }

  _runEdgeTts(text, voice, outFile, textFile) {
    return new Promise((resolve, reject) => {
      // --file (UTF-8) en lugar de --text: sin corrupción de acentos y sin el
      // límite de longitud de la línea de comandos de Windows (~32k).
      const args = textFile
        ? ['--voice', voice, '--file', textFile, '--write-media', outFile]
        : ['--voice', voice, '--text', text, '--write-media', outFile]
      const cmd = this._cmd(args)
      logger.debug('Spawning edge-tts', { voice, textLen: text.length, cmd: cmd.file })
      const proc = spawn(cmd.file, cmd.args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      const errChunks = []
      let settled = false
      let watcher = null
      const finish = (fn, arg) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (watcher) { clearInterval(watcher); watcher = null }
        fn(arg)
      }
      const timer = setTimeout(() => {
        // edge-tts.exe es un WRAPPER que lanza python.exe como hijo: en Windows
        // matar el wrapper NO mata al hijo, que queda huérfano y bloquea la
        // cola (el 'close' nunca llega). Por eso:
        //   1) se mata el ÁRBOL de procesos (taskkill /T /F),
        //   2) si el MP3 ya estaba escrito y es utilizable, se USA en lugar de
        //      perder la locución entera.
        this._killTree(proc)
        try {
          const st = statSync(outFile)
          if (st.size > 1024) {
            logger.warn('edge-tts no cerró (timeout) pero el audio está completo: se usa', {
              voice, bytes: st.size, textLen: text.length,
            })
            finish(resolve, { timedOut: true, bytes: st.size })
            return
          }
        } catch { /* no hay archivo utilizable */ }
        finish(reject, new Error(`edge-tts timeout after ${this.timeoutMs}ms (voice: ${voice})`))
      }, this.timeoutMs)

      proc.stderr.on('data', (c) => errChunks.push(c))
      proc.on('error', (e) => {
        finish(reject, new Error(`edge-tts unavailable: ${e.message}`))
      })
      proc.on('close', (code) => {
        if (code !== 0) {
          const stderr = Buffer.concat(errChunks).toString('utf8').slice(0, 300)
          finish(reject, new Error(`edge-tts exit ${code}: ${stderr}`))
          return
        }
        finish(resolve)
      })

      // El wrapper de edge-tts puede NO cerrar nunca aunque el audio ya esté
      // escrito (el proceso queda colgado esperando). Esperar al 'close' hacía
      // que cada locución tardara el timeout completo (30 s) y la cola se
      // saturaba: las demás fuentes quedaban enterradas y no se oían.
      // Se vigila el archivo de salida: cuando su tamaño se estabiliza, el
      // MP3 está completo y se da por buena la síntesis.
      const POLL_MS = 250
      const ESTABLE_MS = 2000
      let lastSize = -1
      let estableDesde = 0
      watcher = setInterval(() => {
        let size = -1
        try { size = statSync(outFile).size } catch { return }
        if (size <= 1024) return
        if (size !== lastSize) {
          lastSize = size
          estableDesde = Date.now()
          return
        }
        if (Date.now() - estableDesde < ESTABLE_MS) return
        // El audio está completo: se cierra el proceso (a veces no termina solo)
        // y se resuelve con éxito.
        this._killTree(proc)
        logger.debug('edge-tts: audio completo por estabilidad del archivo', { voice, bytes: size })
        finish(resolve)
      }, POLL_MS)
    })
  }

  /**
   * Mata el ÁRBOL de procesos de una síntesis (Windows).
   * edge-tts.exe es un wrapper que lanza python.exe: matar sólo el wrapper deja
   * al hijo huérfano colgado y bloquea la cola.
   */
  _killTree(proc) {
    try {
      if (process.platform === 'win32' && proc.pid) {
        spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        return
      }
      proc.kill('SIGKILL')
    } catch { /* ya no existe */ }
  }

  /**
   * Limpia síntesis huérfanas de ejecuciones anteriores (edge-tts + su python
   * hijo). Se llama al arrancar el servicio: si el proceso murió con una
   * síntesis a medias, esos hijos se quedan colgados para siempre y la cola
   * deja de avanzar (el 'close' del wrapper nunca llega).
   *
   * En Windows 11 ya NO existe wmic, así que se usa PowerShell + CIM.
   */
  async cleanupOrphans() {
    if (process.platform !== 'win32') return 0
    let killed = 0
    try {
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const exec = promisify(execFile)
      // El comando filtra por ProcessName, así que no se mata a sí mismo
      // (powershell.exe no es edge-tts.exe ni python.exe).
      const ps = [
        "Get-CimInstance Win32_Process |",
        "Where-Object { ($_.Name -eq 'edge-tts.exe' -or $_.Name -eq 'python.exe') -and",
        "($_.CommandLine -like '*-m edge_tts*' -or $_.CommandLine -like '*ciudadan-edge-*') } |",
        'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue;',
        'Write-Output $_.ProcessId }',
      ].join(' ')
      const { stdout } = await exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
        windowsHide: true, timeout: 20000,
      }).catch(() => ({ stdout: '' }))
      killed = String(stdout || '').trim().split('\n').filter(l => /^\d+$/.test(l.trim())).length
    } catch { /* sin cleanup */ }
    if (killed) logger.warn('Síntesis edge-tts huérfanas limpiadas', { count: killed })
    return killed
  }

  async listVoices() {
    return new Promise((resolve, reject) => {
      const cmd = this._cmd(['--list-voices'])
      const proc = spawn(cmd.file, cmd.args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
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
      const cmd = this._cmd(['--list-voices'])
      const proc = spawn(cmd.file, cmd.args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
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