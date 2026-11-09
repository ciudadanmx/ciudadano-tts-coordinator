// Controlador multimedia v2: ducking CONFIGURABLE POR APLICACIÓN.
//
// Modos por app: 'pause' | 'reduce' | 'ignore'
//  - pause:  suspender reproducción (solo apps con pausa selectiva, ej. YouTube via CDP).
//            Si la app no admite pausa selectiva, se reporta pauseSupported:false en el panel.
//  - reduce: reducir volumen de sus sesiones al X% respecto a su volumen ORIGINAL (snapshot),
//            rango 0-100. 0 = sin cambio, 100 = silencio.
//  - ignore: no tocar.
//
// Reglas obligatorias:
//  - NO tocamos el volumen maestro de Windows (solo ISimpleAudioVolume por sesión/proceso).
//  - NO tocamos la voz del coordinador (mpv queda excluido siempre).
//  - NO restauramos entre fragmentos consecutivos de una misma cola.
//  - Respetamos cambios manuales del usuario: al restaurar, si el volumen actual ya no es
//    el que pusimos nosotros, NO lo pisamos.
//  - Manejamos múltiples sesiones por app y sesiones nuevas que aparezcan durante la locución
//    (re-scan periódico).
//  - Recuperamos niveles ante cancelación/error (restoreVolumes en finally + snapshot en disco).
//  - No reanudamos contenido que el usuario pausó manualmente (solo reanudamos lo que pausamos).

import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { logger } from '../monitoring/logger.js'
import { WindowsAudioBridge } from './windows-audio.js'
import { YouTubeController } from './youtube.js'

const RESCAN_INTERVAL_MS = 4000
const VOLUME_TOLERANCE = 0.03 // 3% — si el usuario cambió el volumen manualmente, no restaurar
const EXCLUDED_PROCESSES = ['mpv', 'ciudadan-tts-coordinator'] // nunca tocar la voz del coordinador
const SNAPSHOT_FILE = join(homedir(), '.ciudadan-tts-coordinator', 'duck-snapshot.json')
// Volúmenes originales conocidos por pid (pid -> {original, ducked, appKey}).
// Vive en disco para que un proceso NUEVO sepa cuál era el volumen real antes del
// ducking: si no, tomaría el valor ya reducido como "original" (70% -> 49% -> ...)
// y el volumen nunca volvería a 100.
const ORIGINALS_FILE = join(homedir(), '.ciudadan-tts-coordinator', 'volume-originals.json')
// Contenido multimedia que pausamos y quedó pendiente de reanudar (sobrevive reinicios)
const PAUSED_FILE = join(homedir(), '.ciudadan-tts-coordinator', 'paused-media.json')

export class MultimediaController extends EventEmitter {
  constructor(config) {
    super()
    this.config = config
    this.active = false
    this.appStates = new Map() // appKey -> { mode, percentage, snapshots: Map pid->prevVol, duckedVol: Map pid->newVol, pausedTabs: Set, pauseSupported }
    this._audioBridge = null
    this._youtube = null
    this._rescanTimer = null
    // Volumen ORIGINAL real por pid (pid -> volumen previo al primer duck).
    // Evita la degradación acumulativa: si el restore de un ciclo no se aplicó,
    // el siguiente ciclo sigue usando el original (100) en vez de encadenar reducciones.
    this._originalByPid = new Map()
    this._lastDuckedByPid = new Map() // pid -> último valor que nosotros aplicamos
    // Sesiones ya duckeadas en el ciclo actual (pid -> appKey). Una sesión de audio
    // NO puede reducirse dos veces (youtube y chrome apuntan al mismo Chrome).
    this._duckedThisCycle = new Map()
    this._mediaCache = null // { ts, activo } — reproducción multimedia activa (GSMTC)
    // Volúmenes PENDIENTES de restaurar: pid -> { original, ducked, appKey }.
    // Registro global: NO se pierde aunque cambie la configuración o se reemplace
    // el estado de una app (antes el snapshot se perdía y el volumen quedaba bajo
    // para siempre, p.ej. YouTube/Chrome en 8%).
    this._pendingRestore = new Map()
    this._pendingMigration = false // hay claves viejas (youtube/chrome) que migrar
  }

  /**
   * Persiste la fusión de "youtube"+"chrome" en el control único "navegador".
   * La config del usuario queda limpia y el panel muestra una sola fila en vez de
   * dos controles compitiendo por el mismo proceso.
   */
  persistMigration() {
    try {
      const apps = { ...(this.config.multimedia?.applications || {}) }
      const fus = this._fusionarNavegador(apps)
      if (!fus) return false
      delete apps.youtube
      delete apps.chrome
      apps.navegador = fus.navegador
      this.config.multimedia = { ...this.config.multimedia, applications: apps }
      this._pendingMigration = false
      return { apps, navegador: fus.navegador }
    } catch (e) {
      logger.warn('No se pudo migrar la configuración multimedia', { error: e.message })
      return false
    }
  }

  async init() {
    try {
      this._audioBridge = new WindowsAudioBridge()
      await this._audioBridge.init()
      logger.info(this._audioBridge.available
        ? 'Windows Audio Bridge activo — ducking por app habilitado'
        : 'Windows Audio Bridge no disponible — ducking será stub (se reporta en panel)')
      // Recuperación ante crash: si quedó un snapshot de ducking pendiente, restaurar volúmenes
      await this._recoverPendingSnapshot()
      // Volúmenes originales conocidos (persistidos): si el proceso anterior murió con
      // el volumen reducido, aquí se recupera el original real y se restaura.
      this._loadOriginals()
      if (this._pendingRestore.size) {
        try {
          await this.restoreVolumes()
          logger.info('Volúmenes restaurados tras reinicio', { count: this._pendingRestore.size })
        } catch (e) {
          logger.warn('No se pudieron restaurar los volúmenes pendientes', { error: e.message })
        }
      }
    } catch (e) {
      logger.warn('Error inicializando audio bridge', { error: e.message })
    }
    try {
      this._youtube = new YouTubeController(this.config, this._audioBridge)
      logger.info('YouTube Controller listo (CDP puerto ' + this._youtube.cdpPort + ')')
      // Recuperación ante reinicio: si quedó contenido multimedia pausado por nosotros,
      // reanudarlo (si no, el video se queda pausado para siempre).
      await this._recoverPausedMedia()
    } catch (e) {
      logger.warn('YouTube Controller no disponible', { error: e.message })
    }
    logger.info('MultimediaController v2 listo')
  }

  /**
   * Fusiona las claves antiguas "youtube" y "chrome" en el control único
   * "navegador" (mismo proceso de audio en Windows).
   * - "reduce 0%" equivale a "ignorar" (no baja nada).
   * - Si alguna de las dos estaba activa (pausar/reducir con % > 0), gana esa.
   */
  _fusionarNavegador(apps) {
    const legacy = [apps.youtube, apps.chrome].filter(Boolean)
    if (!legacy.length) return null
    const norm = p => {
      if (!p) return null
      if (p.mode === 'reduce' && !(p.percentage > 0)) return { ...p, mode: 'ignore', percentage: 0 }
      return p
    }
    const l = legacy.map(norm).filter(Boolean)
    const activa = l.find(p => p.mode !== 'ignore') || l[0] || { mode: 'ignore' }
    const navegador = {
      mode: activa.mode,
      percentage: activa.mode === 'reduce' ? Math.max(0, Math.min(100, activa.percentage ?? 0)) : 0,
      processNames: ['chrome'],
      matchUrl: 'youtube.com',
      pauseSupported: true,
    }
    return { navegador, legacy }
  }

  /**
   * Políticas por app desde config (con defaults).
   *
   * YouTube y Chrome son el MISMO proceso de audio en Windows (el audio de YouTube
   * sale por la sesión de Chrome), así que se controlan con UNA sola entrada:
   * "navegador" (Chrome / YouTube). Dos controles sobre el mismo proceso solo
   * generaban conflictos (p.ej. uno en "ignorar" y otro en "reducir").
   *
   * Modos del control único:
   *   - pausar  → pausa el video de YouTube de forma selectiva, no toca el volumen
   *   - reducir → baja el volumen de Chrome (y por tanto el de YouTube)
   *   - ignorar → no se toca nada
   */
  getAppPolicies() {
    const apps = this.config.multimedia?.applications || {}
    const defaults = {
      navegador: {
        mode: 'pause', percentage: 0, processNames: ['chrome'], matchUrl: 'youtube.com',
        pauseSupported: true, label: 'Navegador (Chrome / YouTube)',
      },
      spotify: { mode: 'ignore', percentage: 0, processNames: ['spotify'], pauseSupported: false, label: 'Spotify' },
      vlc: { mode: 'ignore', percentage: 0, processNames: ['vlc'], pauseSupported: false, label: 'VLC' },
    }
    const merged = { ...defaults }
    const fus = this._fusionarNavegador(apps)
    if (fus) {
      merged.navegador = { ...defaults.navegador, ...fus.navegador }
      this._pendingMigration = true
    }
    for (const [k, v] of Object.entries(apps)) {
      if (k === 'youtube' || k === 'chrome') continue
      merged[k] = { ...(defaults[k] || {}), ...v }
    }
    return merged
  }

  _isExcluded(processName) {
    const p = (processName || '').toLowerCase()
    return EXCLUDED_PROCESSES.some(e => p.includes(e))
  }

  /**
   * Una app en modo IGNORAR bloquea su proceso para TODAS las políticas: es la
   * misma sesión de audio (p.ej. YouTube y Chrome son el mismo proceso "chrome"),
   * así que si el usuario pone Chrome en "ignorar" su volumen no debe bajar,
   * aunque otra app (youtube) pida reducirlo.
   */
  _esIgnorada(processName, ignorados) {
    if (!ignorados || !ignorados.size) return false
    const p = (processName || '').toLowerCase()
    for (const n of ignorados) if (p.includes(n)) return true
    return false
  }

  /** Nombres de proceso bloqueados por apps en modo "ignorar". */
  _procesosIgnorados(policies) {
    const set = new Set()
    for (const pol of Object.values(policies || {})) {
      if (pol.mode !== 'ignore') continue
      for (const n of (pol.processNames || [])) {
        const s = String(n).trim().toLowerCase()
        if (s) set.add(s)
      }
    }
    return set
  }

  /**
   * Aplica la política multimedia al inicio de una secuencia de locuciones.
   * Llamar UNA vez por cola (no entre fragmentos).
   */
  async applyDucking(utterance) {
    if (this.active) return // ya activo — no re-aplicar entre fragmentos
    // Si quedó un snapshot pendiente (crash o restore interrumpido), limpiar antes
    // de tomar prev nuevos. Solo si no hay pendientes en memoria: si los hay, el
    // snapshot es redundante y restaurarlo aquí subiría el volumen a 100% entre
    // fragmentos (pico de audio).
    if (this._pendingRestore.size === 0) await this._recoverPendingSnapshot()
    this.active = true
    this._duckedThisCycle.clear() // ciclo nuevo: las sesiones pueden duckearse de nuevo
    const policies = this.getAppPolicies()
    logger.info('Aplicando políticas multimedia por app', { source: utterance?.source })
    // Control único del navegador: PAUSAR (pausa el video de YouTube, no toca el
    // volumen) | REDUCIR (baja el volumen de Chrome/Youtube) | IGNORAR (no toca nada).
    // Una app en modo IGNORAR bloquea su proceso para TODAS las políticas
    // (defensa extra: con el control único no suele hacer falta).
    const ignorados = this._procesosIgnorados(policies)
    if (ignorados.size) {
      logger.info('Procesos bloqueados por modo IGNORAR', { procesos: [...ignorados] })
    }

    for (const [appKey, pol] of Object.entries(policies)) {
      const state = { mode: pol.mode, percentage: pol.percentage, snapshots: new Map(), duckedVol: new Map(), pausedTabs: new Set(), pauseSupported: pol.pauseSupported !== false }
      this.appStates.set(appKey, state)

      try {
        if (pol.mode === 'ignore') continue

        if (pol.mode === 'pause') {
          if (pol.matchUrl) {
            const r = await this._youtube.pauseYouTube(pol.matchUrl)
            state.pausedTabs = new Set(this._youtube.pausedByUs)
            state.pausedMedia = this._youtube.pausedMedia?.length || 0 // pausa vía GSMTC (fallback)
            state.pauseMethod = r.method || 'cdp'
            state.pauseSupported = true
            this._mediaCache = null // el estado de reproducción cambió (caché obsoleta)
            logger.info(`[${appKey}] pausa selectiva`, { ...r, matchUrl: pol.matchUrl })
            this._savePausedMedia()
            this.emit('appPaused', { appKey, ...r })
          } else {
            // app sin pausa selectiva
            state.pauseSupported = false
            logger.warn(`[${appKey}] modo 'pause' solicitado pero la app no admite pausa selectiva — se marca en panel, no se simula`)
          }
          continue
        }

        if (pol.mode === 'reduce') {
          const pct = Math.max(0, Math.min(100, pol.percentage ?? 0))
          if (pct === 0) continue
          // Control único: si el modo es REDUCIR, el volumen baja SIEMPRE (haya o no
          // video). Para no bajar el volumen del navegador hay que usar PAUSAR
          // (pausa el video) o IGNORAR.
          await this._duckAppSessions(appKey, pol, state, pct, { ignorados })
        }
      } catch (e) {
        logger.warn(`Política de ${appKey} falló (non-fatal)`, { error: e.message })
      }
    }

    // Re-scan periódico: sesiones nuevas que aparezcan durante la locución
    this._startRescan()
    this._persistSnapshot()
    this.emit('duckingApplied', { apps: [...this.appStates.keys()] })
  }

  /** Guarda el snapshot de volúmenes originales en disco para recuperación ante crash. */
  _persistSnapshot() {
    try {
      const data = { savedAt: Date.now(), apps: {} }
      for (const [appKey, state] of this.appStates) {
        if (state.snapshots?.size) {
          data.apps[appKey] = { mode: state.mode, snapshots: Object.fromEntries(state.snapshots) }
        }
      }
      // Volúmenes pendientes de restaurar (registro global) — imprescindible para
      // recuperar tras un crash cuando la config cambió a reduce 0 (el estado de la
      // app ya no tendría snapshot y el volumen se quedaría bajo).
      if (this._pendingRestore.size) {
        data.pending = Object.fromEntries([...this._pendingRestore.entries()].map(([pid, info]) =>
          [pid, { original: info.original, ducked: info.ducked, appKey: info.appKey }]))
      }
      mkdirSync(join(homedir(), '.ciudadan-tts-coordinator'), { recursive: true })
      writeFileSync(SNAPSHOT_FILE, JSON.stringify(data), { mode: 0o600 })
    } catch (e) { logger.warn('No se pudo persistir snapshot de ducking', { error: e.message }) }
  }

  _clearSnapshot() {
    try { if (existsSync(SNAPSHOT_FILE)) unlinkSync(SNAPSHOT_FILE) } catch {}
  }

  /** Persiste qué contenido multimedia pausamos (para poder reanudarlo tras un reinicio). */
  _savePausedMedia() {
    try {
      const titles = (this._youtube?.pausedMedia || []).map(p => p.title).filter(Boolean)
      // Si esta pausa no capturó nada (el contenido ya estaba pausado por nosotros),
      // NO se borra el registro anterior: si el proceso muere, hay que poder
      // reanudarlo. El archivo se borra al reanudar de verdad (_clearPausedMedia).
      if (!titles.length) return
      mkdirSync(join(homedir(), '.ciudadan-tts-coordinator'), { recursive: true })
      writeFileSync(PAUSED_FILE, JSON.stringify({ savedAt: Date.now(), titles }), { mode: 0o600 })
    } catch (e) { logger.warn('No se pudo persistir el contenido pausado', { error: e.message }) }
  }

  _clearPausedMedia() {
    try { if (existsSync(PAUSED_FILE)) unlinkSync(PAUSED_FILE) } catch {}
  }

  /** Títulos del contenido multimedia que pausamos y quedó pendiente de reanudar. */
  _pausadosRegistrados() {
    try {
      if (!existsSync(PAUSED_FILE)) return []
      const data = JSON.parse(readFileSync(PAUSED_FILE, 'utf8'))
      return Array.isArray(data.titles) ? data.titles : []
    } catch { return [] }
  }

  /**
   * Al iniciar: si quedamos con contenido multimedia pausado (el proceso murió o se
   * reinició antes de reanudar), se reanuda para que no quede pausado para siempre.
   */
  async _recoverPausedMedia() {
    try {
      if (!existsSync(PAUSED_FILE)) return
      const data = JSON.parse(readFileSync(PAUSED_FILE, 'utf8'))
      const titles = data.titles || []
      if (!titles.length) { this._clearPausedMedia(); return }
      if (!this._audioBridge?.available) {
        logger.warn('Bridge de audio no disponible — el contenido pausado se conserva para reintentar')
        return
      }
      const r = await this._youtube.resumeByTitles(titles)
      logger.warn('Contenido pausado pendiente (reinicio previo) — reanudado', { reanudados: r.resumed, titulos: titles })
      this._clearPausedMedia()
    } catch (e) { logger.warn('Recuperación de contenido pausado falló (non-fatal)', { error: e.message }) }
  }

  /** Carga los volúmenes originales conocidos (persistidos en disco). */
  _loadOriginals() {
    try {
      if (!existsSync(ORIGINALS_FILE)) return
      const data = JSON.parse(readFileSync(ORIGINALS_FILE, 'utf8'))
      const list = data.originals || data || {}
      for (const [pidStr, info] of Object.entries(list)) {
        const pid = Number(pidStr)
        if (!info || typeof info.original !== 'number') continue
        this._originalByPid.set(pid, info.original)
        if (typeof info.ducked === 'number') this._lastDuckedByPid.set(pid, info.ducked)
        this._pendingRestore.set(pid, { original: info.original, ducked: info.ducked, appKey: info.appKey || '?' })
      }
      if (this._pendingRestore.size) {
        logger.info('Volúmenes originales cargados de disco', { count: this._pendingRestore.size })
      }
    } catch (e) {
      logger.warn('No se pudieron cargar los volúmenes originales', { error: e.message })
    }
  }

  /** Persiste los volúmenes pendientes de restaurar (sobrevive a reinicios). */
  _saveOriginals() {
    try {
      const originals = {}
      for (const [pid, info] of this._pendingRestore) originals[pid] = info
      mkdirSync(join(homedir(), '.ciudadan-tts-coordinator'), { recursive: true })
      writeFileSync(ORIGINALS_FILE, JSON.stringify({ savedAt: Date.now(), originals }), { mode: 0o600 })
    } catch (e) {
      logger.warn('No se pudieron persistir los volúmenes originales', { error: e.message })
    }
  }

  /** Al iniciar: si quedó un snapshot pendiente (crash previo), restaurar volúmenes originales. */
  async _recoverPendingSnapshot() {
    try {
      if (!existsSync(SNAPSHOT_FILE)) return
      const data = JSON.parse(readFileSync(SNAPSHOT_FILE, 'utf8'))
      const hayApps = data.apps && Object.keys(data.apps).length
      const hayPending = data.pending && Object.keys(data.pending).length
      if (!hayApps && !hayPending) { this._clearSnapshot(); return }
      // Si el bridge no está listo NO se limpia el snapshot: se reintentará más tarde
      // (si no, el volumen se queda bajo para siempre tras el reinicio).
      if (!this._audioBridge?.available) {
        logger.warn('Bridge de audio no disponible — el snapshot de ducking se conserva para reintentar')
        return
      }
      logger.warn('Snapshot de ducking pendiente detectado (crash previo) — restaurando volúmenes',
        { apps: Object.keys(data.apps || {}), pendientes: Object.keys(data.pending || {}).length })
      if (this._audioBridge?.available) {
        // Volúmenes pendientes (fuente de verdad: registro global)
        for (const [pidStr, info] of Object.entries(data.pending || {})) {
          const pid = Number(pidStr)
          const current = await this._audioBridge.getVolumeByPid(pid)
          if (current !== null) {
            await this._audioBridge.setVolumeByPid(pid, info.original)
            logger.info(`[recuperación] pid ${pid} → ${info.original}% (estaba en ${current}%)`)
          }
        }
        for (const [appKey, app] of Object.entries(data.apps || {})) {
          for (const [pidStr, prevVol] of Object.entries(app.snapshots || {})) {
            const pid = Number(pidStr)
            if (data.pending && data.pending[pidStr]) continue // ya restaurado arriba
            const current = await this._audioBridge.getVolumeByPid(pid)
            if (current !== null) {
              await this._audioBridge.setVolumeByPid(pid, prevVol)
              logger.info(`[recuperación] pid ${pid} → ${prevVol}% (estaba en ${current}%)`)
            }
          }
        }
      }
      this._clearSnapshot()
    } catch (e) { logger.warn('Recuperación de snapshot falló (non-fatal)', { error: e.message }) }
  }

  /**
   * ¿Hay una sesión multimedia ACTIVA (Playing) de la app indicada?
   * Se consulta vía GSMTC (Windows Media Session). Caché de 5 s para no castigar el bridge.
   */
  /**
   * Estado multimedia de Chrome (GSMTC).
   * - `tieneMedia`: hay una sesión multimedia en Chrome (reproduciendo O pausada)
   *   → hay un video de YouTube presente.
   * - `reproduciendo`: está en estado Playing (status 4).
   * NOTA: el daemon ignora los filtros `app`/`onlyPlaying`, así que se filtra
   * aquí; y el estado GSMTC tiene lag (tras reanudar sigue marcando "pausado"
   * un instante), por eso la decisión se basa en `tieneMedia`, no en el estado.
   */
  async _estadoMediaChrome() {
    const now = Date.now()
    if (this._mediaCache && (now - this._mediaCache.ts) < 5000) return this._mediaCache.state
    let state = { tieneMedia: false, reproduciendo: false }
    try {
      const r = await this._audioBridge?._call({ action: 'media-list' })
      const list = (r && r.sessions) || []
      const ch = list.filter(s => /chrome/i.test(String(s.app || s.appName || '')))
      state = { tieneMedia: ch.length > 0, reproduciendo: ch.some(s => String(s.status) === '4') }
    } catch (e) {
      logger.warn('No se pudo consultar la reproducción activa', { error: e.message })
    }
    this._mediaCache = { ts: now, state }
    return state
  }

  /** ¿Hay reproducción multimedia activa en la app? (status 4 = Playing) */
  async _hayMediaActivo(app = 'chrome') {
    if (!this._audioBridge?.available) return false
    if (/chrome/i.test(app)) {
      const s = await this._estadoMediaChrome()
      return s.reproduciendo
    }
    try {
      const r = await this._audioBridge._call({ action: 'media-list' })
      const list = (r && r.sessions) || []
      return list.some(s => String(s.app || '').toLowerCase().includes(app.toLowerCase()) && String(s.status) === '4')
    } catch (e) {
      logger.warn('No se pudo consultar la reproducción activa', { error: e.message })
      return false
    }
  }

  async _duckAppSessions(appKey, pol, state, pct, opts = {}) {
    if (!this._audioBridge?.available) { state.stub = true; return }
    const sessions = await this._audioBridge.listSessions()
    const ignorados = opts.ignorados || this._procesosIgnorados(this.getAppPolicies())
    const targets = (sessions.sessions || []).filter(s =>
      pol.processNames?.some(n => s.ProcessName?.toLowerCase().includes(n.toLowerCase())) &&
      !this._isExcluded(s.ProcessName) &&
      // Una app en IGNORAR bloquea su proceso para todas las políticas.
      !this._esIgnorada(s.ProcessName, ignorados)
    )
    // REGLA: el volumen de Chrome NO se baja solo cuando el contenido de YouTube
    // está en modo PAUSAR (o sea, se va a pausar: bajarlo no aporta nada y deja
    // el audio bajo al reanudar). Si la política es REDUCIR, el volumen SE BAJA
    // siempre, haya o no reproducción activa.
    // El valor ya viene calculado en applyDucking (medido ANTES de pausar).
    const skipIfPlaying = opts.skipIfPlaying ?? state.skipIfPlaying
    if (skipIfPlaying) {
      state.skippedPlaying = true
      logger.info(`[${appKey}] hay video en Chrome y YouTube está en modo pausar — NO se baja su volumen`)
      return
    }
    for (const s of targets) {
      if (state.snapshots.has(s.ProcessId)) continue // ya lo tenemos
      // Si esta sesión ya fue duckeada por otra app en este ciclo (p.ej. youtube y
      // chrome comparten la sesión de Chrome), NO se reduce otra vez.
      const yaDuck = this._duckedThisCycle.get(s.ProcessId)
      if (yaDuck) {
        logger.info(`[${appKey}] ${s.ProcessName}(${s.ProcessId}) ya duckeada por '${yaDuck}' — no se reduce de nuevo`)
        continue
      }
      const current = s.Volume
      // Determinar el volumen ORIGINAL real:
      //  - si el volumen actual sigue siendo el que nosotros duckeamos (el restore no se aplicó),
      //    se conserva el original conocido (no se encadena la reducción);
      //  - si cambió (restore aplicado o ajuste manual), el actual pasa a ser el original.
      const knownOriginal = this._originalByPid.get(s.ProcessId)
      const lastDucked = this._lastDuckedByPid.get(s.ProcessId)
      const stillDucked = knownOriginal !== undefined && lastDucked !== undefined &&
        Math.abs(current - lastDucked) <= 2
      const original = stillDucked ? knownOriginal : current
      this._originalByPid.set(s.ProcessId, original)
      const newVol = Math.max(0, Math.round(original * (1 - pct / 100)))
      if (newVol === current) {
        this._lastDuckedByPid.set(s.ProcessId, current)
        // Aunque el volumen ya coincida, hay que guardar el original para poder restaurarlo
        if (original !== current) {
          state.snapshots.set(s.ProcessId, original)
          state.duckedVol.set(s.ProcessId, current)
          this._pendingRestore.set(s.ProcessId, { original, ducked: current, appKey })
          this._saveOriginals()
        }
        continue
      }
      const r = await this._audioBridge.setVolumeByPid(s.ProcessId, newVol)
      if (r && !r.error) {
        state.snapshots.set(s.ProcessId, original)
        state.duckedVol.set(s.ProcessId, newVol)
        this._lastDuckedByPid.set(s.ProcessId, newVol)
        this._duckedThisCycle.set(s.ProcessId, appKey)
        this._pendingRestore.set(s.ProcessId, { original, ducked: newVol, appKey })
        this._saveOriginals()
        logger.info(`[${appKey}] duck ${s.ProcessName}(${s.ProcessId}): ${current}%→${newVol}% (original ${original}%)`)
      }
    }
  }

  _startRescan() {
    this._stopRescan()
    this._rescanTimer = setInterval(async () => {
      if (!this.active) { this._stopRescan(); return }
      try {
        const policies = this.getAppPolicies()
        for (const [appKey, pol] of Object.entries(policies)) {
          if (pol.mode !== 'reduce') continue
          const state = this.appStates.get(appKey)
          if (!state) continue
          const pct = Math.max(0, Math.min(100, pol.percentage ?? 0))
          if (pct === 0) continue
          await this._duckAppSessions(appKey, pol, state, pct) // solo toma sesiones nuevas (snapshots.has filtra)
        }
      } catch (e) { logger.warn('rescan ducking falló (non-fatal)', { error: e.message }) }
    }, RESCAN_INTERVAL_MS)
  }

  _stopRescan() {
    if (this._rescanTimer) { clearInterval(this._rescanTimer); this._rescanTimer = null }
  }

  /**
   * Restaura TODO al terminar la secuencia (o ante cancelación/error).
   * Respeta cambios manuales: si el volumen actual ya no es el ducked, no se pisa.
   */
  /**
   * Restaura el estado multimedia.
   * - Normal: restaura volúmenes y reanuda lo pausado.
   * - `soloPausa: true`: usado ENTRE FRAGMENTOS de la misma intervención. El
   *   volumen se queda reducido (sin picos de audio entre fragmentos) pero el
   *   contenido pausado (video de YouTube) SE REANUDA, para que no quede pausado
   *   durante toda la cola. La siguiente locución vuelve a pausarlo.
   */
  async restoreVolumes(opts = {}) {
    const soloPausa = !!opts.soloPausa
    this._stopRescan()
    const hayPendientes = this._pendingRestore.size > 0
    const hayPausas = this._pausadosRegistrados().length > 0 ||
      [...this.appStates.values()].some(s =>
        s.mode === 'pause' && (s.pausedTabs?.size || s.pausedMedia || this._youtube?.pausedMedia?.length))
    if (!soloPausa && !this.active && !hayPendientes) return
    if (soloPausa && !hayPausas) return
    this.active = false
    logger.info('Restaurando estado multimedia por app', { pendientes: hayPendientes, soloPausa })

    // 1) Volúmenes PENDIENTES de restaurar (registro global: sobrevive a cambios de
    //    configuración y a fallos previos). Antes el snapshot vivía en el estado de la
    //    app y se perdía al reemplazarla -> el volumen quedaba bajo para siempre
    //    (YouTube/Chrome se quedó en 8% y nunca volvía a 100).
    //    Con soloPausa NO se tocan los volúmenes (se mantienen reducidos).
    if (!soloPausa && this._audioBridge?.available) {
      for (const [pid, info] of [...this._pendingRestore.entries()]) {
        try {
          const current = await this._audioBridge.getVolumeByPid(pid)
          if (current !== null && Math.abs(current - info.ducked) / 100 > VOLUME_TOLERANCE) {
            // El usuario movió el volumen a mano: NO se pisa su ajuste.
            logger.info(`[${info.appKey}] pid ${pid}: volumen cambiado manualmente (${current}%), no se restaura a ${info.original}%`)
            this._pendingRestore.delete(pid)
            this._lastDuckedByPid.delete(pid)
            continue
          }
          await this._audioBridge.setVolumeByPid(pid, info.original)
          this._pendingRestore.delete(pid)
          this._lastDuckedByPid.delete(pid)
          logger.info(`[${info.appKey}] restaurado pid ${pid} → ${info.original}%`)
        } catch (e) {
          logger.warn(`[${info.appKey}] no se pudo restaurar pid ${pid}`, { error: e.message })
        }
      }
      this._saveOriginals()
    } else if (!soloPausa) {
      this._pendingRestore.clear()
      this._saveOriginals()
    }
    for (const [appKey, state] of this.appStates) {
      try {
        // El restore de volúmenes ya se hizo arriba con el registro global de
        // pendientes (no depende del estado de la app).
        // Reanudar SOLO lo que pausamos nosotros (nunca lo pausado manualmente).
        // Cubrir AMBOS caminos: pestañas CDP (pausedTabs) y sesiones GSMTC (pausedMedia
        // en el YouTubeController) — antes sólo se miraba pausedTabs y la pausa por
        // fallback GSMTC nunca se reanudaba.
        //
        // Además se consulta el REGISTRO PERSISTIDO (paused-media.json): si el video ya
        // estaba pausado por nosotros, esta pausa captura 0 sesiones y, sin el
        // registro, el video se quedaba pausado para siempre.
        const titulos = this._pausadosRegistrados()
        const debeReanudar = state.mode === 'pause' && this._youtube &&
          (state.pausedTabs?.size || state.pausedMedia || this._youtube.pausedMedia?.length || titulos.length)
        if (debeReanudar) {
          let r = await this._youtube.resumeYouTube()
          // Si no se reanudó nada (el contenido ya estaba pausado por nosotros y esta
          // pausa no capturó sesiones), se reanuda por el registro persistido.
          if (!r.resumed && titulos.length) {
            const r2 = await this._youtube.resumeByTitles(titulos)
            r = { ...r, resumed: (r.resumed || 0) + (r2.resumed || 0), errors: [...(r.errors || []), ...(r2.errors || [])] }
          }
          if (r.resumed) this._clearPausedMedia()
          this._mediaCache = null // el estado de reproducción cambió (caché obsoleta)
          logger.info(`[${appKey}] reanudación selectiva tras locución`, r)
          this.emit('appResumed', { appKey, ...r })
        }
      } catch (e) {
        logger.warn(`Restauración de ${appKey} falló`, { error: e.message })
      }
    }
    this.appStates.clear()
    this._duckedThisCycle.clear()
    if (!soloPausa) this._clearSnapshot()
    this.emit('volumesRestored')
  }

  /** Estado por app para el panel: sesiones detectadas, volumen actual, estado ducking, config. */
  async getAppStatus() {
    const policies = this.getAppPolicies()
    let sessions = []
    if (this._audioBridge?.available) {
      const r = await this._audioBridge.listSessions()
      sessions = r.sessions || []
    }
    const apps = []
    for (const [appKey, pol] of Object.entries(policies)) {
      const state = this.appStates.get(appKey)
      const detected = sessions.filter(s =>
        pol.processNames?.some(n => s.ProcessName?.toLowerCase().includes(n.toLowerCase())) &&
        !this._isExcluded(s.ProcessName)
      )
      apps.push({
        appKey,
        label: pol.label || appKey,
        mode: pol.mode || 'ignore',
        percentage: pol.percentage ?? 0,
        processNames: pol.processNames || [],
        matchUrl: pol.matchUrl || null,
        pauseSupported: pol.pauseSupported !== false && (appKey === 'youtube' || !!pol.matchUrl),
        detectedSessions: detected.map(s => ({ pid: s.ProcessId, process: s.ProcessName, volume: s.Volume })),
        ducking: state ? {
          active: this.active,
          duckedCount: state.duckedVol?.size || 0,
          pausedTabs: state.pausedTabs?.size || 0,
          pausedMedia: state.pausedMedia || 0,
          pauseMethod: state.pauseMethod || null,
          stub: !!state.stub,
        } : { active: false, duckedCount: 0, pausedTabs: 0, pausedMedia: 0, pauseMethod: null, stub: !this._audioBridge?.available },
      })
    }
    // Conflictos: dos apps sobre el MISMO proceso de audio. Si una está en IGNORAR,
    // bloquea el proceso para las demás (no se puede bajar Chrome y YouTube a la vez:
    // en Windows el audio de YouTube sale por la sesión de Chrome).
    const porProceso = new Map()
    for (const [appKey, pol] of Object.entries(policies)) {
      for (const n of (pol.processNames || [])) {
        const k = String(n).toLowerCase()
        if (!porProceso.has(k)) porProceso.set(k, [])
        porProceso.get(k).push({ appKey, mode: pol.mode, percentage: pol.percentage ?? 0 })
      }
    }
    const conflicts = []
    for (const [proc, list] of porProceso) {
      if (list.length < 2) continue
      const ignorada = list.find(x => x.mode === 'ignore')
      if (!ignorada) continue
      const otras = list.filter(x => x.appKey !== ignorada.appKey)
      conflicts.push({
        process: proc,
        ignoredApp: ignorada.appKey,
        blockedApps: otras.map(x => x.appKey),
        message: `"${ignorada.appKey}" está en IGNORAR: su proceso (${proc}) NO baja de volumen, ` +
          `aunque ${otras.map(x => `"${x.appKey}"`).join(' y ')} lo pidan — en Windows ` +
          `${otras.map(x => `"${x.appKey}"`).join(' y ')} usan el mismo proceso de audio (${proc}).`,
      })
    }
    return {
      audioBridgeAvailable: this._audioBridge?.available || false,
      youtubeControllerAvailable: !!this._youtube,
      active: this.active,
      excludedProcesses: EXCLUDED_PROCESSES,
      conflicts,
      apps,
    }
  }

  async listAudioSessions() {
    if (this._audioBridge?.available) return this._audioBridge.listSessions()
    return { error: 'bridge not available', sessions: [] }
  }

  getStatus() {
    return {
      active: this.active,
      audioBridgeAvailable: this._audioBridge?.available || false,
      youtubeControllerAvailable: !!this._youtube,
      apps: [...this.appStates.keys()],
      pausedYouTubeTabs: this._youtube?.pausedByUs?.size || 0,
    }
  }
}
