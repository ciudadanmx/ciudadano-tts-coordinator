// @ciudadan/dsh-tts-coordinator-bridge
// Plugin DSH que intercepta respuestas del agente y las envía al
// ciudadano-tts-coordinator en lugar de reproducirlas en el navegador.
//
// Uso: instalar junto a @goodandready/dsh-tts con speakReplies=false en este último.
// El bridge obtiene sessionId, sessionTitle y taskTitle reales del catálogo de sesiones.

import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const name = '@ciudadan/dsh-tts-coordinator-bridge'
export const inject = ['webServer']

const NS = 'ciudadan-tts-bridge'

// Configuración por defecto — se puede sobrescribir vía settings
const DEFAULT_CONFIG = {
  coordinatorUrl: 'http://127.0.0.1:3199',
  coordinatorTokenEnv: 'CIUDADAN_TTS_TOKEN',
  source: 'dsh', // 'dsh1' o 'dsh2' — se detecta por DSH_HOME
  enabled: true,
  announceTask: true,
  maxChunkChars: 320,
  skipCodeBlocks: true,
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULT_CONFIG, ...(config || {}) }

  // Detectar si somos DSH1 o DSH2 por la ruta de DSH_HOME
  const dshHome = process.env.DSH_HOME || ''
  if (dshHome.includes('.dsh-2')) cfg.source = 'dsh2'
  else if (dshHome.includes('.dsh')) cfg.source = 'dsh1'

  const token = process.env[cfg.coordinatorTokenEnv] || ''

  // Estado de sesiones: sessionId -> { title, displayTitle, taskTitle }
  const sessionMeta = new Map()

  // Cola de intervenciones por sesión (para agrupar fragmentos de streaming)
  const pendingInterventions = new Map()

  function getCoordinatorToken() {
    // Prioridad: 1) env var, 2) archivo persistente ~/.ciudadan-tts-coordinator/token
    const envTok = process.env[cfg.coordinatorTokenEnv]
    if (envTok) return envTok
    try {
      const tokenFile = join(homedir(), '.ciudadan-tts-coordinator', 'token')
      if (existsSync(tokenFile)) return readFileSync(tokenFile, 'utf8').trim()
    } catch {}
    return token
  }

  async function sendToCoordinator(payload) {
    if (!cfg.enabled) return { ok: false, error: 'disabled' }
    const tok = getCoordinatorToken()
    if (!tok) {
      console.warn('[ciudadan-bridge] No hay token CIUDADAN_TTS_TOKEN — no se puede enviar al coordinador')
      return { ok: false, error: 'no token' }
    }
    try {
      const res = await fetch(`${cfg.coordinatorUrl}/api/v1/speech`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${tok}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        console.warn(`[ciudadan-bridge] Coordinador respondió ${res.status}:`, data.error?.message || data.error || '')
        return { ok: false, error: data.error?.message || `HTTP ${res.status}` }
      }
      return { ok: true, ...data }
    } catch (e) {
      // El coordinador no está disponible — no bloquear al agente
      console.warn(`[ciudadan-bridge] Coordinador no disponible: ${e.message}`)
      return { ok: false, error: e.message }
    }
  }

  // Registrar metadatos de sesión cuando cambian
  async function refreshSessionMeta(sessionId) {
    try {
      // Intentar obtener del catálogo de sesiones del cliente vía webServer
      // El cliente envía metadatos via POST /api/ciudadan-bridge/session-meta
      // (ver registerHttpRoutes abajo)
      return sessionMeta.get(sessionId) || {}
    } catch { return {} }
  }

  // Obtener título real de la sesión desde el catálogo del cliente
  function getSessionTitle(sessionId) {
    const meta = sessionMeta.get(sessionId)
    if (!meta) return ''
    // Prioridad: taskTitle > title > displayTitle > cwd basename > sessionId corto
    if (meta.taskTitle) return meta.taskTitle
    if (meta.title) return meta.title
    if (meta.displayTitle) return meta.displayTitle
    if (meta.cwd) {
      const parts = String(meta.cwd).replace(/\\/g, '/').split('/').filter(Boolean)
      if (parts.length) return parts[parts.length - 1]
    }
    return String(sessionId || '').slice(0, 8)
  }

  // Dividir texto en fragmentos para el coordinador
  function chunkText(text, maxChars) {
    const paragraphs = String(text || '').split(/\n+/).map(p => p.trim()).filter(Boolean)
    if (!paragraphs.length) return []
    const chunks = []
    let current = ''
    for (const para of paragraphs) {
      if (current && (current.length + para.length + 1) > maxChars) {
        chunks.push(current)
        current = para
      } else {
        current = current ? current + '\n' + para : para
      }
      while (current.length > maxChars) {
        let cut = current.lastIndexOf(' ', maxChars)
        if (cut < maxChars * 0.3) cut = maxChars
        chunks.push(current.slice(0, cut).trim())
        current = current.slice(cut).trim()
      }
    }
    if (current) chunks.push(current)
    return chunks.filter(Boolean)
  }

  // Enviar una intervención completa al coordinador como fragmentos ordenados
  async function sendIntervention(sessionId, rawText, opts = {}) {
    const meta = sessionMeta.get(sessionId) || {}
    const title = getSessionTitle(sessionId)
    const interventionId = randomUUID()
    const chunks = chunkText(rawText, cfg.maxChunkChars)

    for (let i = 0; i < chunks.length; i++) {
      await sendToCoordinator({
        requestId: `${interventionId}-${i}`,
        source: cfg.source,
        sessionId,
        sessionTitle: meta.title || title,
        taskTitle: cfg.announceTask ? (meta.taskTitle || title) : '',
        text: chunks[i],
        priority: opts.priority || 'normal',
        interventionId,
        fragmentIndex: i,
        totalFragments: chunks.length,
      })
    }
  }

  // --- Escuchar eventos de sesión ---
  ctx.effect(() => ctx.on('session/event', async (session, event) => {
    if (!cfg.enabled) return
    const sid = session?.id
    if (!sid) return

    // Actualizar metadatos si vienen en el evento
    if (event.type === 'session/meta' || event.type === 'session/renamed') {
      const d = event.data || {}
      sessionMeta.set(sid, {
        title: d.title || session.title,
        displayTitle: d.displayTitle || session.displayTitle,
        taskTitle: d.taskTitle || d.activeTask || '',
        cwd: d.cwd || session.cwd,
      })
      return
    }

    if (event.type === 'assistant/message') {
      const msg = event.data?.message ?? event.data?.text ?? event.data
      let text = ''
      if (typeof msg === 'string') text = msg
      else if (msg?.content) {
        if (Array.isArray(msg.content)) {
          text = msg.content.filter(b => b?.type === 'text').map(b => b.text).join('\n')
        } else text = String(msg.content)
      } else if (msg?.text) text = String(msg.text)

      if (!text.trim()) return

      // Obtener tarea activa si está disponible
      const taskTitle = event.data?.taskTitle || event.data?.activeTask || session?.activeTask || ''

      // Actualizar meta de sesión
      const existing = sessionMeta.get(sid) || {}
      sessionMeta.set(sid, {
        ...existing,
        title: session.title || existing.title,
        displayTitle: session.displayTitle || existing.displayTitle,
        cwd: session.cwd || existing.cwd,
        taskTitle: taskTitle || existing.taskTitle,
      })

      await sendIntervention(sid, text)
    }
  }), 'ciudadan-bridge: enviar respuestas al coordinador')

  // --- Rutas HTTP para recibir metadatos del cliente ---
  ctx.effect(() => ctx.webServer?.register({
    kind: 'exact',
    path: '/ciudadan-bridge/session-meta',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405); res.end('POST only'); return
      }
      let body = ''
      req.on('data', c => body += c)
      req.on('end', () => {
        try {
          const data = JSON.parse(body || '{}')
          if (data.sessionId) {
            const existing = sessionMeta.get(data.sessionId) || {}
            sessionMeta.set(data.sessionId, { ...existing, ...data })
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
        } catch {
          res.writeHead(400); res.end('bad json')
        }
      })
    },
  }), 'ciudadan-bridge: session-meta route')

  ctx.effect(() => ctx.webServer?.register({
    kind: 'exact',
    path: '/ciudadan-bridge/status',
    handler: async (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        ok: true,
        enabled: cfg.enabled,
        source: cfg.source,
        coordinatorUrl: cfg.coordinatorUrl,
        hasToken: !!getCoordinatorToken(),
        knownSessions: sessionMeta.size,
      }))
    },
  }), 'ciudadan-bridge: status route')

  console.log(`[ciudadan-bridge] Activo — source=${cfg.source}, coordinador=${cfg.coordinatorUrl}, token=${getCoordinatorToken() ? 'sí' : 'NO'}`)
}
