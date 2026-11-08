// Registro de sesiones y asignación persistente de voces por sessionId.
// Las asignaciones sobreviven a reinicios del coordinador.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { logger } from '../monitoring/logger.js'

const STATE_DIR = join(homedir(), '.ciudadan-tts-coordinator')
const VOICES_FILE = join(STATE_DIR, 'voice-assignments.json')

const DEFAULT_PROFILES = {
  'dsh1-session-a': 'es-MX-DaliaNeural',
  'dsh1-session-b': 'es-MX-DaliaNeural',
  'dsh1-session-c': 'es-MX-DaliaNeural',
  'dsh2-default': 'es-CO-SalomeNeural',
  'claude-code': 'es-AR-TomasNeural',
}

const FALLBACK_VOICES = [
  'es-CO-SalomeNeural',
  'es-MX-DaliaNeural',
  'es-MX-JorgeNeural',
  'es-AR-TomasNeural',
  'es-ES-ElviraNeural',
  'es-ES-AlvaroNeural',
]

// Limpia títulos genéricos que llegan de los clientes ("session", "session-xxx", "untitled"...)
export function cleanTitle(t) {
  if (!t) return ''
  const s = String(t).trim()
  if (!s) return ''
  const low = s.toLowerCase()
  if (low === 'session' || low === 'sesión' || low === 'unknown' || low === 'untitled' || low === 'new chat' ||
      low.startsWith('session-') || low.startsWith('session_') || low.startsWith('sesion-')) return ''
  return s
}

export class SessionRegistry {
  constructor(config) {
    this.config = config
    this.assignments = new Map() // sessionId -> voice
    this.sessionInfo = new Map() // sessionId -> { source, title, displayTitle, lastSeen }
    this._load()
  }

  _load() {
    // Cargar asignaciones persistentes
    try {
      if (existsSync(VOICES_FILE)) {
        const data = JSON.parse(readFileSync(VOICES_FILE, 'utf8'))
        for (const [sid, voice] of Object.entries(data.assignments || {})) {
          this.assignments.set(sid, voice)
        }
      }
    } catch (e) {
      logger.warn('No se pudieron cargar asignaciones de voces', { error: e.message })
    }
    // Aplicar perfiles por defecto del config para sesiones conocidas
    const profiles = this.config.voices?.profiles || DEFAULT_PROFILES
    for (const [key, voice] of Object.entries(profiles)) {
      // Solo asignar si no existe ya una asignación persistente
      if (!this.assignments.has(key)) {
        this.assignments.set(key, voice)
      }
    }
  }

  _save() {
    try {
      mkdirSync(STATE_DIR, { recursive: true })
      const data = {
        assignments: Object.fromEntries(this.assignments),
        updatedAt: new Date().toISOString(),
      }
      writeFileSync(VOICES_FILE, JSON.stringify(data, null, 2), { mode: 0o600 })
    } catch (e) {
      logger.warn('No se pudieron guardar asignaciones de voces', { error: e.message })
    }
  }

  // Registrar/actualizar información de sesión
  registerSession(sessionId, info = {}) {
    const existing = this.sessionInfo.get(sessionId) || {}
    const title = cleanTitle(info.title) || cleanTitle(existing.title)
    const displayTitle = cleanTitle(info.displayTitle) || cleanTitle(info.title) || cleanTitle(existing.displayTitle)
    const taskTitle = cleanTitle(info.taskTitle) || cleanTitle(existing.taskTitle)
    this.sessionInfo.set(sessionId, {
      sessionId,
      source: info.source || existing.source || 'unknown',
      title,
      displayTitle,
      taskTitle,
      cwd: info.cwd || existing.cwd || '',
      lastSeen: Date.now(),
    })
    // Asignar voz si no tiene
    if (!this.assignments.has(sessionId)) {
      this.assignments.set(sessionId, this._autoAssignVoice(sessionId, info.source))
      this._save()
    }
    return this.getSession(sessionId)
  }

  _autoAssignVoice(sessionId, source) {
    // Lógica de asignación automática basada en source
    const profiles = this.config.voices?.profiles || DEFAULT_PROFILES
    if (source === 'claude-code' || source === 'claude') return profiles['claude-code'] || 'es-AR-TomasNeural'
    if (source === 'dsh1') {
      // DSH1 usa SOLO a Dalia mexicana — Jorge es exclusivo del dsh-dany remoto (3091)
      const dsh1Voices = ['es-MX-DaliaNeural']
      const used = new Set([...this.assignments.values()])
      const available = dsh1Voices.filter(v => !used.has(v))
      return available[0] || dsh1Voices[this.assignments.size % dsh1Voices.length]
    }
    if (source === 'dsh2') return profiles['dsh2-default'] || 'es-CO-SalomeNeural'
    // Fallback: primera voz disponible no usada
    const used = new Set([...this.assignments.values()])
    const fallbacks = this.config.voices?.fallbackChain || FALLBACK_VOICES
    return fallbacks.find(v => !used.has(v)) || fallbacks[0]
  }

  getVoice(sessionId) {
    if (this.assignments.has(sessionId)) return this.assignments.get(sessionId)
    // Auto-asignar si es nueva
    const info = this.sessionInfo.get(sessionId) || {}
    const voice = this._autoAssignVoice(sessionId, info.source)
    this.assignments.set(sessionId, voice)
    this._save()
    return voice
  }

  setVoice(sessionId, voice) {
    this.assignments.set(sessionId, voice)
    this._save()
    logger.info('Voice assigned', { sessionId, voice })
    return { ok: true, sessionId, voice }
  }

  getSession(sessionId) {
    const info = this.sessionInfo.get(sessionId) || { sessionId }
    return {
      ...info,
      voice: this.getVoice(sessionId),
    }
  }

  getAllSessions() {
    const result = []
    for (const [sid, info] of this.sessionInfo) {
      result.push({ ...info, voice: this.getVoice(sid) })
    }
    return result
  }

  getAllAssignments() {
    return Object.fromEntries(this.assignments)
  }

  resolveDisplayName(sessionId) {
    const info = this.sessionInfo.get(sessionId)
    if (!info) return this._shortId(sessionId)
    // Prioridad: taskTitle > title > displayTitle > project(cwd basename) > id corto limpio
    const t = cleanTitle(info.taskTitle) || cleanTitle(info.title) || cleanTitle(info.displayTitle)
    if (t) return t
    if (info.cwd) {
      const parts = info.cwd.replace(/\\/g, '/').split('/').filter(Boolean)
      if (parts.length) return parts[parts.length - 1]
    }
    return this._shortId(sessionId)
  }

  _shortId(sessionId) {
    if (!sessionId) return 'unknown'
    // quita el prefijo genérico "session-"/"sesion-" para no mostrar literalmente "session"
    const s = String(sessionId).replace(/^(session|sesion)[-_]?/i, '')
    return s.slice(0, 12) || 'unknown'
  }
}
