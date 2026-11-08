// Integración con Claude Code via hooks oficiales.
// Claude Code ejecuta scripts en eventos como Stop y SubagentStop.
// Este módulo proporciona el script hook que se registra en ~/.claude/hooks/
// y envía el texto final al ciudadano-tts-coordinator con voz es-AR-TomasNeural.

import { randomUUID } from 'node:crypto'

const CONFIG = {
  coordinatorUrl: process.env.CIUDADAN_TTS_COORDINATOR_URL || 'http://127.0.0.1:3199',
  tokenEnv: 'CIUDADAN_TTS_TOKEN',
  source: 'claude-code',
  voice: 'es-AR-TomasNeural',
}

/**
 * Envía una locución al coordinador.
 * Diseñado para ejecutarse como hook de Claude Code (recibe JSON por stdin).
 */
export async function sendToCoordinator(payload) {
  const token = process.env[CONFIG.tokenEnv]
  if (!token) return { ok: false, error: 'no token' }
  try {
    const res = await fetch(`${CONFIG.coordinatorUrl}/api/v1/speech`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        requestId: randomUUID(),
        source: CONFIG.source,
        sessionId: payload.sessionId || 'claude-code',
        sessionTitle: payload.sessionTitle || payload.project || 'Claude Code',
        taskTitle: payload.taskTitle || payload.summary || '',
        voice: payload.voice || CONFIG.voice,
        text: payload.text || '',
        priority: 'normal',
      }),
      signal: AbortSignal.timeout(10000),
    })
    return await res.json()
  } catch (e) {
    // No bloquear a Claude si el coordinador no está disponible
    return { ok: false, error: e.message }
  }
}

/**
 * Script ejecutable como hook de Claude Code.
 * Lee JSON de stdin con el evento y envía al coordinador.
 * Uso en ~/.claude/settings.json:
 * {
 *   "hooks": {
 *     "Stop": [{ "matcher": "", "hooks": [{ "type": "command", "command": "node /ruta/ciudadan-tts-coordinator/src/integrations/claude-hook.js" }] }]
 *   }
 * }
 */
export async function claudeHookMain() {
  let input = ''
  // Leer stdin
  for await (const chunk of process.stdin) input += chunk
  try {
    const event = JSON.parse(input || '{}')
    // Evento Stop: { hook_event_name: "Stop", session_id, transcript_path, ... }
    // Evento SubagentStop: { hook_event_name: "SubagentStop", ... }
    const text = event.final_message || event.text || event.summary || event.message || ''
    if (!text.trim()) return // nada que decir

    // Evitar duplicados entre Stop y SubagentStop del mismo turno
    const sessionId = event.session_id || 'claude-code'

    await sendToCoordinator({
      sessionId,
      sessionTitle: event.project || event.cwd || 'Claude Code',
      taskTitle: event.task || event.summary || '',
      text: String(text).slice(0, 10000), // límite razonable
    })
  } catch (e) {
    // Silencioso: nunca bloquear a Claude
    console.error('[claude-hook] error:', e.message)
  }
}

// Si ejecutado directamente (no como módulo)
if (import.meta.url === `file://${process.argv[1]}`) {
  claudeHookMain()
}
