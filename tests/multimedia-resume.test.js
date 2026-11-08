// Pruebas de reanudación tras locución en modo 'pause' (YouTube):
// - la pausa pudo haber caído por CDP (pausedByUs) o por fallback GSMTC (pausedMedia)
// - restoreVolumes DEBE reanudar en ambos casos (antes sólo miraba pausedTabs)
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { YouTubeController } from '../src/multimedia/youtube.js'
import { MultimediaController } from '../src/multimedia/controller.js'

const cfg = {
  multimedia: {
    youtube: { pauseEnabled: true, resumeAutomatically: true, port: 9222 },
    applications: { youtube: { mode: 'pause', percentage: 100, processNames: ['chrome'], matchUrl: 'youtube.com', pauseSupported: true } },
  },
}

describe('YouTubeController.resumeYouTube', () => {
  test('reanuda por GSMTC las sesiones pausadas por fallback aunque CDP no esté disponible', async () => {
    const calls = []
    const fakeBridge = {
      available: true,
      _call: async (req) => {
        calls.push(req.action)
        if (req.action === 'media-resume') return { resumed: [{ ok: true, title: 'Video YT' }] }
        return {}
      },
    }
    const yt = new YouTubeController(cfg, fakeBridge)
    yt.pausedMedia = [{ ok: true, title: 'Video YT' }] // pausado vía GSMTC (CDP no disponible)
    yt.pausedByUs = new Set() // vacío: la pausa NO fue por CDP
    const r = await yt.resumeYouTube()
    assert.ok(calls.includes('media-resume'), 'se llamó media-resume GSMTC')
    assert.equal(r.resumed, 1)
    assert.equal(yt.pausedMedia.length, 0, 'pausedMedia limpiado')
  })

  test('si resumeAutomatically=false no reanuda y limpia estado', async () => {
    const cfgOff = JSON.parse(JSON.stringify(cfg))
    cfgOff.multimedia.youtube.resumeAutomatically = false
    const fakeBridge = { available: true, _call: async () => { throw new Error('no debe llamarse') } }
    const yt = new YouTubeController(cfgOff, fakeBridge)
    yt.pausedMedia = [{ ok: true }]
    yt.pausedByUs = new Set(['t1'])
    const r = await yt.resumeYouTube()
    assert.equal(r.resumed, 0)
    assert.equal(yt.pausedMedia.length, 0)
    assert.equal(yt.pausedByUs.size, 0)
  })
})

describe('MultimediaController.restoreVolumes - modo pause', () => {
  function makeController(youtubeStub) {
    const c = new MultimediaController(cfg)
    c._audioBridge = null
    c._youtube = youtubeStub
    c.active = true
    c.appStates.set('youtube', {
      mode: 'pause', percentage: 100,
      snapshots: new Map(), duckedVol: new Map(),
      pausedTabs: new Set(youtubeStub.pausedByUs),
      pausedMedia: youtubeStub.pausedMedia?.length || 0,
      pauseSupported: true,
    })
    return c
  }

  test('reanuda cuando la pausa fue por fallback GSMTC (pausedMedia, sin pausedTabs)', async () => {
    let resumed = 0
    const yt = { pausedByUs: new Set(), pausedMedia: [{ ok: true }], resumeYouTube: async () => { resumed++; return { resumed: 1 } } }
    const c = makeController(yt)
    await c.restoreVolumes()
    assert.equal(resumed, 1, 'resumeYouTube DEBE llamarse aunque pausedTabs esté vacío')
  })

  test('reanuda cuando la pausa fue por CDP (pausedTabs)', async () => {
    let resumed = 0
    const yt = { pausedByUs: new Set(['tab1']), pausedMedia: [], resumeYouTube: async () => { resumed++; return { resumed: 1 } } }
    const c = makeController(yt)
    await c.restoreVolumes()
    assert.equal(resumed, 1)
  })

  test('NO reanuda si no pausamos nada (evita tocar lo pausado manualmente por el usuario)', async () => {
    let resumed = 0
    const yt = { pausedByUs: new Set(), pausedMedia: [], resumeYouTube: async () => { resumed++; return { resumed: 0 } } }
    const c = makeController(yt)
    await c.restoreVolumes()
    assert.equal(resumed, 0)
  })
})
