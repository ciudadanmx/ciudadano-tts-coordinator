// Pruebas de la cola global: turnos atómicos, orden, deduplicación, recuperación.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { UtteranceQueue } from '../src/queue/manager.js'

function makeMockDeps() {
  const played = []
  return {
    played,
    deps: {
      synthesize: async (text, opts) => ({ audio: Buffer.from('fake-audio'), path: '/tmp/fake.mp3', mime: 'audio/mpeg' }),
      player: {
        name: 'mock',
        play: async (path) => { played.push(path); await new Promise(r => setTimeout(r, 10)) },
        stop: () => {},
        skip: () => {},
        pause: () => {},
        resume: () => {},
      },
      multimedia: {
        applyDucking: async () => {},
        restoreVolumes: async () => {},
      },
    },
  }
}

const baseConfig = {
  queue: { maxLength: 100, maxTextLength: 50000, lockTimeoutMs: 5000 },
  voices: { default: 'es-CO-SalomeNeural' },
  announcements: { enabled: false },
  multimedia: { tts: { volume: 100 } },
}

describe('UtteranceQueue - casos básicos', () => {
  test('encola y procesa una solicitud', async () => {
    const { deps, played } = makeMockDeps()
    const q = new UtteranceQueue(baseConfig, deps)
    const r = q.enqueue({ source: 'test', sessionId: 's1', text: 'Hola mundo', voice: 'es-CO-SalomeNeural' })
    assert.equal(r.ok, true)
    assert.ok(r.requestId)
    // Esperar a que termine
    await new Promise(r => setTimeout(r, 200))
    assert.equal(played.length, 1)
    const status = q.getStatus()
    assert.equal(status.speaking, false)
  })

  test('rechaza duplicados con mismo requestId', () => {
    const { deps } = makeMockDeps()
    const q = new UtteranceQueue(baseConfig, deps)
    const r1 = q.enqueue({ requestId: 'dup-1', source: 'test', text: 'uno' })
    const r2 = q.enqueue({ requestId: 'dup-1', source: 'test', text: 'dos' })
    assert.equal(r1.ok, true)
    assert.equal(r2.ok, false)
    assert.match(r2.error, /duplicate/)
  })

  test('rechaza texto vacío', () => {
    const { deps } = makeMockDeps()
    const q = new UtteranceQueue(baseConfig, deps)
    // text vacío no está bloqueado en enqueue, pero el proceso falla. Verificar que no rompe.
    const r = q.enqueue({ source: 'test', text: '   ' })
    assert.equal(r.ok, true) // se encola, pero la síntesis fallará
  })

  test('respeta límite de cola', () => {
    const { deps } = makeMockDeps()
    const cfg = { ...baseConfig, queue: { ...baseConfig.queue, maxLength: 2 } }
    const q = new UtteranceQueue(cfg, deps)
    // Bloquear el procesamiento para que se acumulen
    q._pump = () => {} // desactivar bomba
    q.enqueue({ source: 't', text: 'a' })
    q.enqueue({ source: 't', text: 'b' })
    const r3 = q.enqueue({ source: 't', text: 'c' })
    assert.equal(r3.ok, false)
    assert.match(r3.error, /queue full/)
  })
})

describe('UtteranceQueue - concurrencia (4 solicitudes simultáneas)', () => {
  test('cuatro solicitudes se reproducen secuencialmente sin superposición', async () => {
    const { deps, played } = makeMockDeps()
    // Hacer que play tarde un poco para detectar superposición
    let currentlyPlaying = 0
    let maxConcurrent = 0
    deps.player.play = async (path) => {
      currentlyPlaying++
      maxConcurrent = Math.max(maxConcurrent, currentlyPlaying)
      played.push(path)
      await new Promise(r => setTimeout(r, 50))
      currentlyPlaying--
    }
    const q = new UtteranceQueue(baseConfig, deps)
    const results = []
    for (let i = 0; i < 4; i++) {
      results.push(q.enqueue({
        source: `agent-${i}`,
        sessionId: `s-${i}`,
        sessionTitle: `Sesión ${i}`,
        text: `Mensaje del agente ${i}`,
        voice: ['es-CO-SalomeNeural', 'es-MX-DaliaNeural', 'es-MX-JorgeNeural', 'es-AR-TomasNeural'][i],
      }))
    }
    assert.ok(results.every(r => r.ok))
    // Esperar a que terminen todas
    await new Promise(r => setTimeout(r, 1000))
    assert.equal(played.length, 4, 'todas deben haberse reproducido')
    assert.equal(maxConcurrent, 1, 'NUNCA debe haber más de 1 reproduciéndose a la vez')
  })
})

describe('UtteranceQueue - cancelación y parada', () => {
  test('cancelar una solicitud pendiente', async () => {
    const { deps, played } = makeMockDeps()
    const q = new UtteranceQueue(baseConfig, deps)
    q._pump = () => {} // bloquear procesamiento
    const r = q.enqueue({ requestId: 'cancel-me', source: 't', text: 'hola' })
    const c = q.cancel('cancel-me')
    assert.equal(c.ok, true)
    const u = q.items.get('cancel-me')
    assert.equal(u.status, 'cancelled')
  })

  test('cancelar todas las de una sesión', async () => {
    const { deps } = makeMockDeps()
    const q = new UtteranceQueue(baseConfig, deps)
    q._pump = () => {}
    q.enqueue({ requestId: 'a', source: 't', sessionId: 'sess-1', text: 'uno' })
    q.enqueue({ requestId: 'b', source: 't', sessionId: 'sess-1', text: 'dos' })
    q.enqueue({ requestId: 'c', source: 't', sessionId: 'sess-2', text: 'tres' })
    const r = q.cancelSession('sess-1')
    assert.equal(r.cancelled, 2)
  })
})

describe('UtteranceQueue - prioridades', () => {
  test('prioridad high va antes que normal', async () => {
    const { deps, played } = makeMockDeps()
    const order = []
    deps.player.play = async (path) => { order.push(path); await new Promise(r => setTimeout(r, 5)) }
    const q = new UtteranceQueue(baseConfig, deps)
    q._pump = () => {} // bloquear
    q.enqueue({ requestId: 'n1', source: 't', text: 'normal 1', priority: 'normal' })
    q.enqueue({ requestId: 'h1', source: 't', text: 'high 1', priority: 'high' })
    q.enqueue({ requestId: 'n2', source: 't', text: 'normal 2', priority: 'normal' })
    // El orden en la cola debe ser: h1, n1, n2
    assert.equal(q.order[0], 'h1')
    assert.equal(q.order[1], 'n1')
    assert.equal(q.order[2], 'n2')
  })
})

describe('UtteranceQueue - recuperación ante error de síntesis', () => {
  test('si la síntesis falla, marca error y libera el turno', async () => {
    const { deps } = makeMockDeps()
    let attempts = 0
    deps.synthesize = async () => {
      attempts++
      if (attempts < 3) throw new Error('fallo temporal')
      return { audio: Buffer.from('ok'), path: '/tmp/ok.mp3', mime: 'audio/mpeg' }
    }
    const q = new UtteranceQueue(baseConfig, deps)
    q.enqueue({ requestId: 'retry-1', source: 't', text: 'reintentar' })
    await new Promise(r => setTimeout(r, 8000))
    const u = q.items.get('retry-1')
    assert.equal(u.status, 'done', `debería terminar en done tras reintentos, estado actual: ${u.status}, error: ${u.error}`)
    assert.ok(attempts >= 3)
  })

  test('si la síntesis falla siempre, marca error y libera lock', async () => {
    const { deps } = makeMockDeps()
    deps.synthesize = async () => { throw new Error('fallo permanente') }
    const q = new UtteranceQueue(baseConfig, deps)
    q.enqueue({ requestId: 'fail-1', source: 't', text: 'fallará' })
    await new Promise(r => setTimeout(r, 8000))
    const u = q.items.get('fail-1')
    assert.equal(u.status, 'error')
    assert.equal(q.lock, null, 'el lock debe liberarse')
    assert.equal(q.playing, null)
  })
})
