// Pausa/reanudación automática de pestañas de YouTube via Chrome DevTools Protocol (CDP).
// Se conecta al puerto 9222 de Chrome (debe iniciarse con --remote-debugging-port=9222).
// Solo pausa pestañas que estaban reproduciendo; no toca las pausadas manualmente.

import { logger } from '../monitoring/logger.js'

export class YouTubeController {
  constructor(config, audioBridge = null) {
    this.config = config
    this.cdpPort = config.multimedia?.youtube?.port || 9222
    this.pausedByUs = new Set() // tabIds pausadas por nosotros (CDP)
    this.pausedMedia = [] // sesiones GSMTC pausadas por nosotros (fallback)
    this.ws = null
    this.msgId = 0
    this.pending = new Map()
    this._audioBridge = audioBridge // para fallback GSMTC (media-pause)
    this.lastMethod = 'none' // 'cdp' | 'gsmtc'
  }

  async _getTargets() {
    const res = await fetch(`http://127.0.0.1:${this.cdpPort}/json`)
    if (!res.ok) throw new Error(`CDP no disponible en puerto ${this.cdpPort} (inicia Chrome con --remote-debugging-port=${this.cdpPort})`)
    return res.json()
  }

  async _connect(wsUrl) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl)
      ws.onopen = () => resolve(ws)
      ws.onerror = (e) => reject(new Error('WebSocket error'))
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data)
          if (msg.id && this.pending.has(msg.id)) {
            const { resolve } = this.pending.get(msg.id)
            this.pending.delete(msg.id)
            resolve(msg.result || msg.error)
          }
        } catch { /* ignore */ }
      }
      ws.onclose = () => { this.ws = null }
      setTimeout(() => reject(new Error('WS timeout')), 5000)
    })
  }

  async _send(ws, method, params = {}) {
    const id = ++this.msgId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP timeout: ${method}`))
        }
      }, 5000)
    })
  }

  async _evalOnTab(ws, expression) {
    const result = await this._send(ws, 'Runtime.evaluate', { expression, returnByValue: true })
    return result?.result?.value
  }

  async pauseYouTube(matchUrl = 'youtube.com') {
    if (!this.config.multimedia?.youtube?.pauseEnabled && matchUrl === 'youtube.com') return { paused: 0 }
    try {
      const targets = await this._getTargets()
      // Pausa SELECTIVA: solo pestañas que cumplan matchUrl (ej. youtube.com/watch).
      // Nunca pausa todo Chrome, solo las pestañas que coinciden.
      const matching = targets.filter(t => t.url?.includes(matchUrl))
      let pausedCount = 0

      for (const tab of matching) {
        if (!tab.webSocketDebuggerUrl) continue
        try {
          const ws = await this._connect(tab.webSocketDebuggerUrl)
          // Verificar si el video está reproduciendo
          const isPlaying = await this._evalOnTab(ws, `
            (() => {
              const v = document.querySelector('video');
              return v ? !v.paused && !v.ended : false;
            })()
          `)
          if (isPlaying) {
            await this._evalOnTab(ws, `
              (() => {
                const v = document.querySelector('video');
                if (v && !v.paused) { v.pause(); return true; }
                return false;
              })()
            `)
            this.pausedByUs.add(tab.id)
            pausedCount++
            logger.info('YouTube pausado', { tabId: tab.id, url: tab.url?.slice(0, 80) })
          }
          ws.close()
        } catch (e) {
          logger.warn('Error pausando tab de YouTube', { tabId: tab.id, error: e.message })
        }
      }
      return { paused: pausedCount, tabs: matching.length, matchUrl }
    } catch (e) {
      logger.warn('CDP no disponible para pausa selectiva — fallback a GSMTC (pausa la sesión multimedia activa de Chrome)', { error: e.message, matchUrl })
      // Fallback: pausar vía GlobalSystemMediaTransportControls (solo sesiones en Playing)
      if (this._audioBridge?.available) {
        try {
          const r = await this._audioBridge._call({ action: 'media-pause', app: 'chrome', title: '', onlyPlaying: true })
          const paused = r.paused || []
          this.pausedMedia = paused.filter(p => p.ok)
          this.lastMethod = 'gsmtc'
          logger.info('GSMTC: Chrome pausado (sesión multimedia activa)', { count: this.pausedMedia.length, titles: this.pausedMedia.map(p => p.title) })
          return { paused: this.pausedMedia.length, method: 'gsmtc', titles: this.pausedMedia.map(p => p.title), matchUrl, cdpError: e.message }
        } catch (e2) {
          logger.warn('Fallback GSMTC también falló', { error: e2.message })
          return { paused: 0, error: e.message + ' / gsmtc: ' + e2.message }
        }
      }
      return { paused: 0, error: e.message }
    }
  }

  async resumeYouTube(matchUrl = 'youtube.com') {
    // Reanudación automática: se puede desactivar explícitamente, pero por defecto
    // es TRUE. Antes se miraba `config.multimedia.youtube.resumeAutomatically`,
    // clave que ya no existe (ahora el control es "navegador"): si faltaba, el
    // bloque se activaba y el contenido pausado NUNCA se reanudaba.
    const mm = this.config.multimedia || {}
    const auto = mm.navegador?.resumeAutomatically ?? mm.youtube?.resumeAutomatically ?? true
    if (auto === false) {
      this.pausedByUs.clear()
      this.pausedMedia = []
      return { resumed: 0, disabled: true }
    }
    let resumed = 0
    const errors = []

    // 1) CDP: reanudar SOLO las pestañas que pausamos nosotros por CDP
    try {
      const targets = await this._getTargets()
      for (const tabId of this.pausedByUs) {
        const tab = targets.find(t => t.id === tabId && t.url?.includes(matchUrl))
        if (!tab?.webSocketDebuggerUrl) continue
        try {
          const ws = await this._connect(tab.webSocketDebuggerUrl)
          await this._evalOnTab(ws, `
            (() => {
              const v = document.querySelector('video');
              if (v && v.paused) { v.play(); return true; }
              return false;
            })()
          `)
          resumed++
          logger.info('YouTube reanudado (CDP)', { tabId })
          ws.close()
        } catch (e) {
          logger.warn('Error reanudando tab de YouTube (CDP)', { tabId, error: e.message })
        }
      }
    } catch (e) {
      errors.push('cdp: ' + e.message)
      logger.warn('CDP no disponible al reanudar — se intentará GSMTC', { error: e.message })
    }
    this.pausedByUs.clear()

    // 2) GSMTC: reanudar las sesiones multimedia que pausamos por fallback
    //    (pasa cuando Chrome no tiene --remote-debugging-port=9222).
    //    ANTES esto sólo corría si el CDP fallaba por completo; si la pausa fue
    //    GSMTC, pausedByUs estaba vacío y NUNCA se reanudaba. Ahora siempre se intenta.
    if (this._audioBridge?.available && this.pausedMedia.length) {
      try {
        const r = await this._audioBridge._call({ action: 'media-resume', app: 'chrome', title: '', onlyPlaying: false })
        const okCount = (r.resumed || []).filter(p => p.ok).length
        resumed += okCount
        this.lastMethod = 'gsmtc'
        logger.info('GSMTC: sesiones multimedia reanudadas tras locución', { resumed: okCount, titles: (r.resumed || []).map(p => p.title) })
      } catch (e) {
        errors.push('gsmtc: ' + e.message)
        logger.warn('Fallback GSMTC de reanudación falló', { error: e.message })
      }
    }
    this.pausedMedia = []

    const out = { resumed }
    if (errors.length) out.errors = errors
    return out
  }

  /**
   * Reanuda sesiones multimedia concretas por título (GSMTC).
   * Se usa en la recuperación tras reinicio: el contenido que pausamos puede
   * haberse quedado pausado si el proceso murió antes de restaurarlo.
   */
  async resumeByTitles(titles = []) {
    if (!this._audioBridge?.available || !titles.length) return { resumed: 0, errors: [] }
    let resumed = 0
    const errors = []
    for (const title of titles) {
      try {
        const r = await this._audioBridge._call({ action: 'media-resume', app: 'chrome', title, onlyPlaying: false })
        const ok = (r.resumed || []).filter(p => p.ok).length
        resumed += ok
        if (ok) logger.info('GSMTC: sesión reanudada tras reinicio', { title })
      } catch (e) {
        errors.push(`${title}: ${e.message}`)
      }
    }
    // Fallback: si el título no coincidió (p.ej. caracteres especiales), se reanuda
    // la sesión multimedia pausada de Chrome sin filtrar. Solo se usa en la
    // recuperación tras reinicio, donde sabemos que la pausa fue nuestra.
    if (resumed === 0) {
      try {
        const r = await this._audioBridge._call({ action: 'media-resume', app: 'chrome', title: '', onlyPlaying: false })
        const ok = (r.resumed || []).filter(p => p.ok).length
        if (ok) {
          resumed += ok
          logger.warn('GSMTC: reanudación por título no coincidió — se reanudó la sesión pausada de Chrome', { reanudados: ok })
        }
      } catch (e) {
        errors.push('fallback: ' + e.message)
      }
    }
    return { resumed, errors }
  }

  async mediaStatus() {    if (!this._audioBridge?.available) return { available: false }
    try {
      const r = await this._audioBridge._call({ action: 'media-list' })
      return { available: true, sessions: r.sessions || [] }
    } catch (e) { return { available: false, error: e.message } }
  }
}
