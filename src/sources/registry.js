// Registro de fuentes de voz: los agentes/servicios que envían locuciones.
//
// Cada fuente conserva:
//   id       identificador estable (dsh1, dsh2, dany, claude, whatsapp, ...)
//   name     nombre visible en el panel
//   enabled  si el coordinador reproduce sus locuciones (checkbox del panel)
//   voice    voz seleccionada para esa fuente
//   aliases  identificadores alternativos que se resuelven a esta fuente
//   meta     preferencias futuras (extensible: severidad, horario, etc.)
//
// Persistencia: ~/.ciudadan-tts-coordinator/sources.json
//
// El panel NO escribe las filas a mano: las genera desde este registro, de modo
// que agregar una fuente nueva (WhatsApp, correo, alertas del monitor...) es
// únicamente agregar una entrada en config/default.json → "sources".

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { logger } from '../monitoring/logger.js'
import { STATE_DIR } from '../paths.js'

const SOURCES_FILE = join(STATE_DIR, 'sources.json')
const ASSIGNMENTS_FILE = join(STATE_DIR, 'voice-assignments.json')

// "Conectado" = hubo actividad real de esa fuente en los últimos 5 minutos.
const ACTIVITY_WINDOW_MS = 5 * 60 * 1000

// Fuentes por defecto. Los alias reflejan los identificadores REALES que usan
// los clientes actuales (ver docs/fuentes-de-voz.md).
export const DEFAULT_SOURCES = [
  {
    id: 'dsh1', name: 'DSH1', enabled: true, voice: 'es-MX-DaliaNeural',
    aliases: ['dsh1', 'dsh-1', 'agente1', 'dsh'],
  },
  {
    id: 'dsh2', name: 'DSH2', enabled: true, voice: 'es-CO-SalomeNeural',
    aliases: ['dsh2', 'dsh-2', 'agente2'],
  },
  {
    id: 'dany', name: 'DSH Dany', enabled: true, voice: 'es-CL-LorenzoNeural',
    aliases: ['dany', 'dsh-dany', 'danny'],
  },
  {
    id: 'claude', name: 'Claude', enabled: true, voice: 'es-AR-TomasNeural',
    aliases: ['claude', 'claude-code', 'claude-orch', 'claudeorch'],
  },
  {
    // Portapapeles de Windows (Sprint 1). NACE DESACTIVADA: la captura no se
    // activa sola al reiniciar. El interruptor "Leer portapapeles" del panel y
    // el atajo global Ctrl+Alt+R la activan de forma explicita.
    id: 'clipboard', name: 'Portapapeles', enabled: false, voice: 'es-MX-DaliaNeural',
    aliases: ['clipboard', 'portapapeles', 'clip'],
  },
]

const norm = (s) => String(s || '').trim().toLowerCase()

export class SourceRegistry {
  constructor(config) {
    this.config = config || {}
    this.sources = new Map() // id -> fuente
    this.aliasMap = new Map() // alias normalizado -> id
    this.activity = new Map() // id -> { lastSeen, count }
    this._load()
    this.ensureDefaults()
  }

  // --- persistencia ---
  _load() {
    try {
      if (!existsSync(SOURCES_FILE)) return
      const data = JSON.parse(readFileSync(SOURCES_FILE, 'utf8'))
      for (const s of data.sources || []) {
        if (!s?.id) continue
        this.sources.set(s.id, {
          id: s.id,
          name: s.name || s.id,
          enabled: s.enabled !== false,
          voice: s.voice || '',
          aliases: Array.isArray(s.aliases) ? s.aliases : [],
          meta: s.meta && typeof s.meta === 'object' ? s.meta : {},
        })
      }
      if (data.savedAt) logger.info('Fuentes de voz cargadas de disco', { count: this.sources.size })
    } catch (e) {
      logger.warn('No se pudieron cargar las fuentes de voz', { error: e.message })
    }
  }

  _save() {
    try {
      mkdirSync(STATE_DIR, { recursive: true })
      const data = {
        savedAt: new Date().toISOString(),
        sources: [...this.sources.values()],
      }
      writeFileSync(SOURCES_FILE, JSON.stringify(data, null, 2), { mode: 0o600 })
    } catch (e) {
      logger.warn('No se pudieron guardar las fuentes de voz', { error: e.message })
    }
  }

  _reindex() {
    this.aliasMap.clear()
    for (const s of this.sources.values()) {
      this.aliasMap.set(norm(s.id), s.id)
      for (const a of s.aliases || []) this.aliasMap.set(norm(a), s.id)
    }
  }

  /**
   * Crea las fuentes por defecto SIN sobrescribir lo que ya esté configurado
   * (ni en disco ni en voices.profiles del config).
   */
  ensureDefaults() {
    const configured = this.config.sources?.sources || this.config.sources || []
    const defaults = Array.isArray(configured) && configured.length ? configured : DEFAULT_SOURCES
    // Las fuentes integradas (p.ej. 'clipboard') se agregan SIEMPRE, aunque la
    // configuración del usuario no las liste. Si el usuario ya la desactivo,
    // su estado guardado (enabled:false) se respeta: aqui solo se anaden las
    // que NO existen todavia en el mapa.
    const list = [...defaults]
    for (const d of DEFAULT_SOURCES) {
      if (!list.some(x => x.id === d.id)) list.push(d)
    }
    let changed = false
    for (const d of list) {
      if (!d?.id) continue
      const existing = this.sources.get(d.id)
      if (existing) {
        // Se completan los campos que falten, sin pisar enabled/voice ya guardados.
        if (!existing.voice && d.voice) { existing.voice = d.voice; changed = true }
        if (!existing.name) { existing.name = d.name || d.id; changed = true }
        if (!existing.aliases?.length && d.aliases) { existing.aliases = d.aliases; changed = true }
        continue
      }
      const vozInicial = this._initialVoice(d)
      this.sources.set(d.id, {
        id: d.id,
        name: d.name || d.id,
        enabled: d.enabled !== false,
        voice: vozInicial,
        aliases: d.aliases || [],
        meta: d.meta && typeof d.meta === 'object' ? d.meta : {},
      })
      changed = true
      logger.info('Fuente de voz registrada', { id: d.id, voice: vozInicial })
    }
    this._reindex()
    if (changed) this._save()
  }

  /**
   * Voz inicial de una fuente: respeta la configuración persistente existente.
   * Orden: config.sources > voices.profiles (por alias) > voice-assignments.json
   * (por alias) > valor por defecto de la fuente.
   */
  _initialVoice(def) {
    const aliases = new Set([norm(def.id), ...(def.aliases || []).map(norm)])
    const profiles = this.config.voices?.profiles || {}
    for (const [key, voice] of Object.entries(profiles)) {
      if (aliases.has(norm(key)) && voice) return voice
    }
    // Asignaciones persistentes por sesión: si una sesión de esa fuente ya tiene
    // voz asignada, se respeta (no se sobrescribe la preferencia del agente).
    try {
      if (existsSync(ASSIGNMENTS_FILE)) {
        const data = JSON.parse(readFileSync(ASSIGNMENTS_FILE, 'utf8'))
        for (const [key, voice] of Object.entries(data.assignments || {})) {
          if (aliases.has(norm(key)) && voice) return voice
        }
      }
    } catch { /* sin asignaciones previas */ }
    return def.voice || this.config.voices?.default || 'es-CO-SalomeNeural'
  }

  // --- consultas ---
  get(id) {
    const key = norm(id)
    const real = this.aliasMap.get(key) || (this.sources.has(id) ? id : null)
    return real ? this.sources.get(real) : null
  }

  /** Resuelve el identificador que llega en una petición a la fuente canónica. */
  resolve(sourceRaw) {
    if (!sourceRaw) return null
    return this.get(sourceRaw)
  }

  /** Una fuente desconocida (p.ej. un servicio nuevo) NO se bloquea: se permite. */
  isEnabled(sourceRaw) {
    const s = this.resolve(sourceRaw)
    if (!s) return true
    return s.enabled !== false
  }

  isConnected(id) {
    const act = this.activity.get(id)
    if (!act) return false
    return Date.now() - act.lastSeen <= ACTIVITY_WINDOW_MS
  }

  list() {
    return [...this.sources.values()].map(s => {
      const act = this.activity.get(s.id)
      return {
        id: s.id,
        name: s.name,
        enabled: s.enabled !== false,
        voice: s.voice,
        aliases: s.aliases || [],
        meta: s.meta || {},
        connected: this.isConnected(s.id),
        lastSeen: act?.lastSeen || null,
        utterances: act?.count || 0,
      }
    })
  }

  // --- mutaciones ---
  markSeen(sourceRaw) {
    const s = this.resolve(sourceRaw)
    if (!s) return null
    const act = this.activity.get(s.id) || { lastSeen: 0, count: 0 }
    act.lastSeen = Date.now()
    act.count += 1
    this.activity.set(s.id, act)
    return s
  }

  setEnabled(id, enabled) {
    const s = this.get(id)
    if (!s) return null
    s.enabled = !!enabled
    this._save()
    logger.info('Fuente de voz actualizada', { id: s.id, enabled: s.enabled })
    return s
  }

  setVoice(id, voice) {
    const s = this.get(id)
    if (!s) return null
    s.voice = voice
    this._save()
    logger.info('Voz de fuente actualizada', { id: s.id, voice })
    return s
  }

  setMeta(id, meta) {
    const s = this.get(id)
    if (!s) return null
    s.meta = { ...(s.meta || {}), ...(meta || {}) }
    this._save()
    return s
  }
}
