// Pruebas del anuncio de nombre de sesión/tarea en locuciones TTS.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { UtteranceQueue, buildAnnouncement } from '../src/queue/manager.js'

describe('buildAnnouncement', () => {
  const cfg = { enabled: true, prefixTemplate: '{sessionName}. {taskTitle}.', minTitleLength: 3, maxTitleLength: 80 }

  test('anuncia sesión y tarea cuando ambas existen y difieren', () => {
    assert.equal(buildAnnouncement(cfg, 'Puente GPT', 'Reparar worker'), 'Puente GPT. Reparar worker.')
  })

  test('no duplica cuando sesión y tarea son iguales', () => {
    assert.equal(buildAnnouncement(cfg, 'Puente GPT', 'Puente GPT'), 'Puente GPT.')
  })

  test('plantilla vieja "{taskTitle}." con tarea vacía cae al nombre de sesión (fallback)', () => {
    const old = { ...cfg, prefixTemplate: '{taskTitle}.' }
    assert.equal(buildAnnouncement(old, 'Puente GPT', ''), 'Puente GPT.')
  })

  test('plantilla vieja con tarea presente anuncia la tarea (compat hacia atrás)', () => {
    const old = { ...cfg, prefixTemplate: '{taskTitle}.' }
    assert.equal(buildAnnouncement(old, 'Puente GPT', 'Reparar worker'), 'Reparar worker.')
  })

  test('plantilla con token de sesión vacío pero tarea presente usa la tarea', () => {
    const t = { ...cfg, prefixTemplate: '{sessionName}.' }
    assert.equal(buildAnnouncement(t, '', 'Reparar worker'), 'Reparar worker.')
  })

  test('deshabilitado devuelve vacío', () => {
    assert.equal(buildAnnouncement({ ...cfg, enabled: false }, 'X', 'Y'), '')
  })

  test('título demasiado corto no se anuncia', () => {
    assert.equal(buildAnnouncement(cfg, 'ab', ''), '')
  })

  test('limpia segmentos vacíos intermedios', () => {
    const t = { ...cfg, prefixTemplate: '{sessionName}. {taskTitle}.' }
    assert.equal(buildAnnouncement(t, 'Solo sesión', ''), 'Solo sesión.')
  })

  test('no rompe los puntos internos del título (ej. v1.2)', () => {
    assert.equal(buildAnnouncement({ ...cfg, prefixTemplate: '{sessionName}. {taskTitle}.' }, 'PRUEBA v1.2', ''), 'PRUEBA v1.2.')
  })

  test('respeta maxTitleLength', () => {
    const largo = 'x'.repeat(200)
    const out = buildAnnouncement({ ...cfg, prefixTemplate: '{sessionName}.' }, largo, '')
    assert.equal(out.length, 81) // 80 + '.'
  })
})

describe('UtteranceQueue - anuncio con nombre real de sesión', () => {
  function makeDeps(captured) {
    return {
      synthesize: async (text, opts) => { captured.push(text); return { audio: Buffer.from('x'), path: '/tmp/x.mp3', mime: 'audio/mpeg' } },
      player: { play: async () => { await new Promise(r => setTimeout(r, 5)) }, stop: () => {}, skip: () => {}, pause: () => {}, resume: () => {} },
      multimedia: { applyDucking: async () => {}, restoreVolumes: async () => {} },
    }
  }

  const cfg = {
    queue: { maxLength: 100, maxTextLength: 50000, lockTimeoutMs: 5000 },
    voices: { default: 'es-CO-SalomeNeural' },
    announcements: { enabled: true, prefixTemplate: '{sessionName}. {taskTitle}.', minTitleLength: 3, maxTitleLength: 80 },
    multimedia: { tts: { volume: 100 } },
  }

  test('el texto sintetizado empieza con el nombre de la sesión (fragmento 0)', async () => {
    const captured = []
    const q = new UtteranceQueue(cfg, makeDeps(captured))
    const r = q.enqueue({ source: 'dsh2', sessionId: 'session-abc', sessionName: 'PRUEBA DEL PUENTE GPT', sessionTitle: 'session-abc', taskTitle: '', text: 'Hola mundo', fragmentIndex: 0, totalFragments: 1 })
    assert.equal(r.ok, true)
    await new Promise(r => setTimeout(r, 300))
    assert.equal(captured.length, 1)
    assert.ok(captured[0].startsWith('PRUEBA DEL PUENTE GPT.'), 'prefix de sesión presente: ' + captured[0].slice(0, 60))
    assert.ok(captured[0].includes('Hola mundo'))
  })

  test('fragmentos >0 NO llevan anuncio', async () => {
    const captured = []
    const q = new UtteranceQueue(cfg, makeDeps(captured))
    q.enqueue({ source: 'dsh2', sessionId: 's', sessionName: 'Sesion X', text: 'segundo fragmento', fragmentIndex: 1, totalFragments: 2, requestId: 'f1-1' })
    await new Promise(r => setTimeout(r, 300))
    assert.equal(captured.length, 1)
    assert.equal(captured[0], 'segundo fragmento')
  })

  test('sin sessionName usa sessionTitle; si no, taskTitle', async () => {
    const captured = []
    const q = new UtteranceQueue(cfg, makeDeps(captured))
    q.enqueue({ source: 'dsh2', sessionId: 's2', sessionTitle: 'Título sesión', taskTitle: 'Tarea activa', text: 'uno', requestId: 'a-0', fragmentIndex: 0 })
    await new Promise(r => setTimeout(r, 300))
    assert.ok(captured[0].startsWith('Título sesión. Tarea activa.'), captured[0].slice(0, 60))
  })
})
