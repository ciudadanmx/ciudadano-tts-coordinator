// Generación y validación de tokens de autenticación local.
// El token se lee de la variable de entorno CIUDADAN_TTS_TOKEN o se genera
// automáticamente y se guarda en el archivo de estado.

import { randomBytes, createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

const TOKEN_FILE = join(homedir(), '.ciudadan-tts-coordinator', 'token')
const ENV_VAR = 'CIUDADAN_TTS_TOKEN'

let cachedToken = null

export function getOrCreateToken() {
  if (cachedToken) return cachedToken
  // 1. Variable de entorno tiene prioridad
  if (process.env[ENV_VAR]) {
    cachedToken = process.env[ENV_VAR]
    return cachedToken
  }
  // 2. Leer de archivo existente
  try {
    if (existsSync(TOKEN_FILE)) {
      cachedToken = readFileSync(TOKEN_FILE, 'utf8').trim()
      if (cachedToken) return cachedToken
    }
  } catch { /* continuar a generar */ }
  // 3. Generar nuevo token y persistir
  cachedToken = randomBytes(32).toString('hex')
  try {
    mkdirSync(dirname(TOKEN_FILE), { recursive: true })
    writeFileSync(TOKEN_FILE, cachedToken, { mode: 0o600 })
  } catch { /* si no se puede guardar, usar en memoria */ }
  return cachedToken
}

export function validateToken(provided) {
  if (!provided) return false
  const expected = getOrCreateToken()
  // Comparación de tiempo constante para evitar timing attacks
  const a = createHash('sha256').update(String(provided)).digest()
  const b = createHash('sha256').update(expected).digest()
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

// Middleware de autenticación para rutas protegidas
export function requireAuth(req, res, next) {
  const auth = req.headers['authorization'] || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : (req.headers['x-ciudadan-token'] || '')
  if (!validateToken(token)) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: { code: 'unauthorized', message: 'Valid Bearer token required' } }))
    return
  }
  next()
}
