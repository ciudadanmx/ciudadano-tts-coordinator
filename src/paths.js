// Rutas del coordinador.
//
// - CONFIG_DIR (LOCAL): token y config.json. Se quedan en el disco local a
//   propósito: son secretos y configuración del usuario, y no deben viajar a
//   la red.
// - STATE_DIR: todo lo que CRECE (cache de audio, logs, cola, historial,
//   snapshots de volumen). Por defecto local; se puede mover a Kompa con la
//   variable de entorno CIUDADAN_TTS_STATE_DIR o con `paths.stateDir` en la
//   config. Esto es lo que se llenaba el disco local.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'

export const CONFIG_DIR = join(homedir(), '.ciudadan-tts-coordinator')

function resolveStateDir() {
  // 1) Variable de entorno (tareas programadas, despliegues).
  const env = process.env.CIUDADAN_TTS_STATE_DIR
  if (env && String(env).trim()) return String(env).trim()
  // 2) paths.stateDir de la config del usuario (p.ej. Kompa).
  try {
    const raw = readFileSync(join(CONFIG_DIR, 'config.json'), 'utf8')
    const cfg = JSON.parse(raw)
    if (cfg?.paths?.stateDir && String(cfg.paths.stateDir).trim()) return String(cfg.paths.stateDir).trim()
  } catch { /* sin config de usuario: se usa el local */ }
  // 3) Local.
  return CONFIG_DIR
}

export const STATE_DIR = resolveStateDir()

export function ensureStateDir() {
  try { mkdirSync(STATE_DIR, { recursive: true }) } catch { /* ignore */ }
}

// stateDir(override): override gana (p.ej. paths.stateDir de la config).
export function stateDir(override) {
  if (override && String(override).trim()) return String(override).trim()
  return STATE_DIR
}

export function statePath(...parts) {
  ensureStateDir()
  return join(STATE_DIR, ...parts)
}
