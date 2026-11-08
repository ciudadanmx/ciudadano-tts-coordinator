// Persistencia de configuración con merge profundo y validación.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const CONFIG_DIR = join(homedir(), '.ciudadan-tts-coordinator')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')
const DEFAULT_FILE = fileURLToPath(new URL('../../config/default.json', import.meta.url))

let config = null

function deepMerge(target, source) {
  const out = { ...target }
  for (const [k, v] of Object.entries(source || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      out[k] = deepMerge(target[k], v)
    } else {
      out[k] = v
    }
  }
  return out
}

export function loadConfig() {
  if (config) return config
  let defaults = {}
  try {
    defaults = JSON.parse(readFileSync(DEFAULT_FILE, 'utf8'))
  } catch { /* usar defaults hardcoded */ }
  // Aplicar rutas por defecto si no están definidas
  const home = homedir()
  defaults.server = defaults.server || {}
  defaults.recovery = defaults.recovery || {}
  defaults.logging = defaults.logging || {}
  defaults.synthesis = defaults.synthesis || {}
  if (!defaults.recovery.stateFile) defaults.recovery.stateFile = join(CONFIG_DIR, 'state.json')
  if (!defaults.logging.file) defaults.logging.file = join(CONFIG_DIR, 'coordinator.log')
  if (!defaults.synthesis.cacheDir) defaults.synthesis.cacheDir = join(CONFIG_DIR, 'audio-cache')

  let userCfg = {}
  try {
    if (existsSync(CONFIG_FILE)) {
      userCfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
    }
  } catch (e) {
    console.error('[config] Error leyendo config de usuario, usando defaults:', e.message)
  }
  config = deepMerge(defaults, userCfg)
  return config
}

export function saveConfig(partial) {
  const current = loadConfig()
  config = deepMerge(current, partial)
  try {
    mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 })
  } catch (e) {
    console.error('[config] Error guardando config:', e.message)
    throw e
  }
  return config
}

export function getConfig() {
  return loadConfig()
}

export function resetConfig() {
  config = null
  return loadConfig()
}
