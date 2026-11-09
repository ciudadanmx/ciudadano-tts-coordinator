// Utilidades compartidas entre el hook de Claude Code y la CLI de control.
//
// IMPORTANTE (restricción arquitectónica): Claude Code es un CLIENTE ADICIONAL
// del ciudadano-tts-coordinator. Este módulo NO sintetiza ni reproduce audio:
// sólo habla el contrato HTTP público del servicio compartido que ya usan
// DSH1 (:3080) y DSH2 (:3081).

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'

export const CONFIG = {
  // Mismo servicio TTS centralizado que usan DSH1/DSH2. Sólo loopback.
  coordinatorUrl: process.env.CIUDADAN_TTS_COORDINATOR_URL || 'http://127.0.0.1:3199',
  tokenEnv: 'CIUDADAN_TTS_TOKEN',
  // Id de fuente registrado para Claude en el coordinador compartido.
  source: 'claude-orch',
  // Voz solicitada para Claude.
  voice: 'es-AR-TomasNeural',
  // Fragmentos iguales que usa el puente de DSH (ver dsh-bridge/lib/index.js).
  maxCharsPerChunk: 320,
  // Tope de caracteres hablados por respuesta (evita leer logs técnicos largos).
  maxSpokenChars: 20000,
  // Ventana de deduplicación: dos locuciones idénticas en menos de este
  // intervalo se consideran la misma locución (hook disparado dos veces).
  dedupeWindowMs: 60000,
  requestTimeoutMs: 8000,
}

/**
 * Rutas candidatas del perfil real del usuario.
 * `os.homedir()` sigue las variables HOME/USERPROFILE, que en algunos entornos
 * están remapeadas; `os.userInfo().homedir` devuelve el perfil real del SO.
 */
export function profileRoots() {
  const roots = []
  const push = (p) => { if (p && !roots.includes(p)) roots.push(p) }
  try { push(userInfo().homedir) } catch { /* ignorar */ }
  push(homedir())
  if (process.env.USERPROFILE) push(process.env.USERPROFILE)
  push('C:\\Users\\elyiz')
  return roots
}

/** Estado propio del adaptador (dedupe, logs). No toca el estado del coordinador. */
export function stateDir() {
  const dir = join(profileRoots()[0], '.ciudadan-claude-voice')
  try { mkdirSync(dir, { recursive: true }) } catch { /* sin estado */ }
  return dir
}

/**
 * Tokens candidatos del coordinador: variable de entorno y ficheros de token
 * de todos los perfiles candidatos.
 *
 * OJO: el servicio compartido vive bajo el perfil con el que arrancó, que
 * puede ser el HOME remapeado; el perfil del SO puede tener un token
 * antiguo. Por eso se prueban TODOS y se usa el que autentique.
 */
export function coordinatorTokens() {
  const out = []
  const env = process.env[CONFIG.tokenEnv]
  if (env && env.trim()) out.push(env.trim())
  for (const root of profileRoots()) {
    const file = join(root, '.ciudadan-tts-coordinator', 'token')
    try {
      if (existsSync(file)) {
        const tok = readFileSync(file, 'utf8').trim()
        if (tok && !out.includes(tok)) out.push(tok)
      }
    } catch { /* siguiente candidato */ }
  }
  return out
}

/** Primer token disponible (compatibilidad). */
export function coordinatorToken() {
  return coordinatorTokens()[0] || ''
}

async function apiWithToken(path, opts, token) {
  const method = opts.method || 'GET'
  try {
    const res = await fetch(`${CONFIG.coordinatorUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(opts.timeoutMs || CONFIG.requestTimeoutMs),
    })
    let data = {}
    try { data = await res.json() } catch { data = {} }
    if (!res.ok) {
      return { ok: false, status: res.status, error: data?.error || { code: `http-${res.status}` } }
    }
    return { ok: true, status: res.status, data }
  } catch (e) {
    return { ok: false, error: { code: 'unreachable', message: e.message } }
  }
}

/**
 * Llamada autenticada al contrato HTTP del coordinador. Nunca lanza.
 * Si el primer token devuelve 401, se prueba con los demás candidatos.
 */
export async function api(path, opts = {}) {
  const tokens = coordinatorTokens()
  if (!tokens.length) return { ok: false, error: { code: 'no-token', message: 'sin token del coordinador' } }
  let last = null
  for (const token of tokens) {
    const res = await apiWithToken(path, opts, token)
    if (res.ok) return res
    last = res
    // Sólo se reintenta con otro token si el rechazo fue de autenticación.
    if (res.status !== 401) return res
  }
  return last
}

/** Registro en un log propio (nunca en stdout: stdout del hook vuelve a Claude). */
export function logLine(msg) {
  try {
    const file = join(stateDir(), 'claude-orch.log')
    writeFileSync(file, `${new Date().toISOString()} ${msg}\n`, { flag: 'a' })
  } catch { /* silencioso */ }
}

/* ------------------------------------------------------------------ *
 * Preparación del texto (markdown -> texto hablado -> fragmentos)
 * ------------------------------------------------------------------ */

let processorPromise = null
function loadProcessor() {
  if (!processorPromise) {
    processorPromise = import('../synthesis/text-processor.js').catch(() => null)
  }
  return processorPromise
}

/** Fallback mínimo si el módulo del coordinador no es alcanzable. */
function fallbackMarkdownToSpeech(markdown) {
  return String(markdown || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]+`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Convierte la respuesta de Claude en texto hablado y lo divide en
 * fragmentos, reutilizando el mismo preprocesador que usa el servicio.
 */
export async function prepareUtterance(rawText) {
  const proc = await loadProcessor()
  const spoken = proc
    ? proc.markdownToSpeech(rawText, { skipCodeBlocks: true, skipInlineCode: true, summarizeTables: true })
    : fallbackMarkdownToSpeech(rawText)
  if (!spoken || !spoken.trim()) return { spoken: '', chunks: [] }
  const limited = spoken.length > CONFIG.maxSpokenChars ? spoken.slice(0, CONFIG.maxSpokenChars) : spoken
  const chunks = proc
    ? proc.chunkForSpeech(limited, { maxCharsPerChunk: CONFIG.maxCharsPerChunk })
    : fallbackChunk(limited)
  return { spoken: limited, chunks }
}

function fallbackChunk(text) {
  const out = []
  const max = CONFIG.maxCharsPerChunk
  const paragraphs = text.split(/\n+/).map(p => p.trim()).filter(Boolean)
  let current = ''
  for (const para of paragraphs) {
    if (current && current.length + para.length + 1 > max) { out.push(current); current = para }
    else current = current ? current + '\n' + para : para
    while (current.length > max) { out.push(current.slice(0, max)); current = current.slice(max) }
  }
  if (current) out.push(current)
  return out.map((t, i) => ({ text: t, index: i, id: `frag-${i}`, totalFragments: out.length }))
}

/* ------------------------------------------------------------------ *
 * Deduplicación (evita leer dos veces la misma locución)
 * ------------------------------------------------------------------ */

const DEDUPE_FILE = () => join(stateDir(), 'dedupe.json')

export function dedupeKey(sessionId, text) {
  return createHash('sha256').update(`${sessionId}|${text}`).digest('hex')
}

/** Devuelve true si esta locución ya se envió dentro de la ventana. */
export function isDuplicate(key, windowMs = CONFIG.dedupeWindowMs) {
  let data = {}
  try { data = JSON.parse(readFileSync(DEDUPE_FILE(), 'utf8')) } catch { data = {} }
  const now = Date.now()
  const prev = data[key]
  if (prev && now - prev < windowMs) return true
  data[key] = now
  for (const [k, v] of Object.entries(data)) {
    if (now - v > 24 * 60 * 60 * 1000) delete data[k]
  }
  try { writeFileSync(DEDUPE_FILE(), JSON.stringify(data)) } catch { /* sin estado */ }
  return false
}

/* ------------------------------------------------------------------ *
 * Voz por sesión (asignación persistente en el servicio compartido)
 * ------------------------------------------------------------------ */

/**
 * Garantiza que la sesión de Claude tenga asignada la voz de Tomás en el
 * registro persistente del coordinador (sobrevive a reinicios del servicio).
 * El registro asigna por defecto una voz del fallbackChain a fuentes
 * desconocidas; por eso se fija explícitamente.
 */
export async function ensureVoice(sessionId) {
  if (!sessionId) return { ok: false, error: 'no-session' }
  const voices = await api('/api/v1/voices')
  const assignments = voices?.data?.assignments || {}
  if (assignments[sessionId] === CONFIG.voice) return { ok: true, voice: CONFIG.voice, changed: false }
  const res = await api(`/api/v1/sessions/${encodeURIComponent(sessionId)}/voice`, {
    method: 'PUT',
    body: { voice: CONFIG.voice },
  })
  return { ok: res.ok, voice: CONFIG.voice, changed: res.ok }
}
