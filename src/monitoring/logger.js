// Logger estructurado con niveles, rotación básica y redacción de texto sensible.

import { appendFileSync, existsSync, mkdirSync, statSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 }

let config = null
let logFile = null
let maxSizeBytes = 10 * 1024 * 1024

function init(cfg) {
  config = cfg
  logFile = cfg?.logging?.file || null
  maxSizeBytes = (cfg?.logging?.maxSizeMb || 10) * 1024 * 1024
  if (logFile) {
    try { mkdirSync(dirname(logFile), { recursive: true }) } catch { /* ignore */ }
  }
}

function rotateIfNeeded() {
  if (!logFile || !existsSync(logFile)) return
  try {
    const size = statSync(logFile).size
    if (size > maxSizeBytes) {
      renameSync(logFile, logFile + '.1')
    }
  } catch { /* ignore */ }
}

function redact(text) {
  // No registrar textos completos de locuciones (pueden contener datos sensibles)
  if (typeof text !== 'string') return text
  if (text.length > 120) return text.slice(0, 60) + '…[' + text.length + ' chars]'
  return text
}

function write(level, msg, meta) {
  const minLevel = LEVELS[config?.logging?.level || 'info'] ?? 1
  if (LEVELS[level] < minLevel) return
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(meta ? { meta: typeof meta === 'object' ? Object.fromEntries(
      Object.entries(meta).map(([k, v]) => [k, k.toLowerCase().includes('text') ? redact(v) : v])
    ) : meta } : {}),
  }
  const line = JSON.stringify(entry) + '\n'
  if (logFile) {
    try {
      rotateIfNeeded()
      appendFileSync(logFile, line)
    } catch { /* si falla el archivo, solo console */ }
  }
  const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  try {
    consoleFn(`[${entry.ts}] ${level.toUpperCase()}: ${msg}`, meta && typeof meta === 'object' ? JSON.stringify(meta).slice(0, 300) : '')
  } catch { /* stdout roto (EPIPE) — ignorar para no entrar en loop */ }
}

export const logger = {
  init,
  debug: (msg, meta) => write('debug', msg, meta),
  info: (msg, meta) => write('info', msg, meta),
  warn: (msg, meta) => write('warn', msg, meta),
  error: (msg, meta) => write('error', msg, meta),
}
