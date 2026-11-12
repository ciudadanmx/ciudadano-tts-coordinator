// Servicio de lectura del portapapeles (Sprint 1).
//
// QUÉ ES Y QUÉ NO ES
//   Este módulo es la PARTE INDEPENDIENTE DE WINDOWS: guarda el estado de la
//   captura, valida el texto y decide qué se encola. NO usa Win32, NO abre el
//   portapapeles, NO lee el contenido del portapapeles.
//
//   El componente que SI usa Win32 (AddClipboardFormatListener + RegisterHotKey)
//   es scripts/clipboard-watcher.ps1, un proceso separado en la sesión
//   interactiva que habla con este servicio por HTTP, igual que los DSH.
//   Así el núcleo del coordinador conserva su compatibilidad con Linux.
//
// PRIVACIDAD
//   - El texto recibido NO se registra en logs (solo su longitud).
//   - Las locuciones del portapapeles son EFÍMERAS: no van al historial.
//   - El contenido solo viaja al sintetizador TTS configurado.

import { createHash } from 'node:crypto'
import { logger } from '../monitoring/logger.js'

const DEFAULT_MAX_CHARS = 2000
const DEFAULT_HOTKEY = 'Ctrl+Alt+R'

export class ClipboardService {
  /**
   * @param {object} config  configuración del coordinador
   * @param {object} sources  registro de fuentes (SourceRegistry)
   * @param {object} queue    gestor de cola (QueueManager)
   */
  constructor(config, sources, queue) {
    this.config = config || {}
    this.sources = sources
    this.queue = queue
    // Estado que reporta el watcher de Windows (lo actualiza vía HTTP).
    this.watcher = {
      running: false,
      hotkeyRegistered: false,
      hotkeyError: null,
      hotkey: this.hotkey,
      pid: null,
      seenAt: null,
    }
    this.lastTextAt = null
    this.lastTextLength = 0
    this.lastTextHash = null
    this.readCount = 0
    this.duplicateCount = 0
  }

  get hotkey() {
    return this.config.clipboard?.hotkey || DEFAULT_HOTKEY
  }

  get maxChars() {
    const n = Number(this.config.clipboard?.maxChars ?? DEFAULT_MAX_CHARS)
    return Number.isFinite(n) && n > 0 ? Math.min(n, 50000) : DEFAULT_MAX_CHARS
  }

  /** La captura esta activa solo si la fuente 'clipboard' esta habilitada. */
  isEnabled() {
    const s = this.sources?.get('clipboard')
    return !!(s && s.enabled)
  }

  getStatus() {
    const s = this.sources?.get('clipboard')
    return {
      ok: true,
      enabled: this.isEnabled(),
      source: 'clipboard',
      sourceEnabled: !!(s && s.enabled),
      voice: s?.voice || '',
      hotkey: this.hotkey,
      maxChars: this.maxChars,
      watcher: { ...this.watcher, hotkey: this.hotkey },
      lastTextAt: this.lastTextAt,
      lastTextLength: this.lastTextLength,
      readCount: this.readCount,
      duplicateCount: this.duplicateCount,
    }
  }

  /** Activa o desactiva la captura. La fuente 'clipboard' es la fuente de verdad. */
  setEnabled(enabled) {
    const want = !!enabled
    const s = this.sources?.setEnabled('clipboard', want)
    if (!s) return { ok: false, error: 'fuente clipboard no encontrada' }
    // Al desactivar se corta la lectura en curso de esa fuente: no queda sonando.
    let stopped = 0
    if (!want) {
      const r = this.queue?.cancelSession('clipboard')
      stopped = r?.cancelled ?? 0
    }
    logger.info('Captura del portapapeles ' + (want ? 'activada' : 'desactivada'), { stopped })
    return { ok: true, enabled: want, stopped: { stopped } }
  }

  toggle() {
    return this.setEnabled(!this.isEnabled())
  }

  /** El watcher de Windows reporta su estado (si arrancó, si el atajo quedó libre). */
  setWatcherStatus(data) {
    this.watcher = {
      running: !!data?.running,
      hotkeyRegistered: !!data?.hotkeyRegistered,
      hotkeyError: data?.hotkeyError || null,
      hotkey: data?.hotkey || this.hotkey,
      pid: data?.pid ?? null,
      seenAt: Date.now(),
    }
    logger.info('Estado del watcher del portapapeles', {
      running: this.watcher.running,
      hotkeyRegistered: this.watcher.hotkeyRegistered,
      hotkeyError: this.watcher.hotkeyError,
    })
    return { ok: true, watcher: this.watcher }
  }

  /**
   * Texto copiado. Se valida y se encola como locución efímera de la fuente
   * 'clipboard'. NO se registra el contenido: solo la longitud.
   *
   * Si el texto es IDÉNTICO al de la copia anterior no se vuelve a encolar
   * (se guarda solo su hash SHA-256, nunca el texto). Copiar lo mismo otra
   * vez no repite la lectura.
   *
   * @returns {{ok:boolean, error?:string, requestId?:string, chars?:number, duplicate?:boolean}}
   */
  submitText(text) {
    if (!this.isEnabled()) return { ok: false, error: 'captura desactivada' }
    const raw = String(text ?? '')
    const trimmed = raw.trim()
    if (!trimmed) return { ok: false, error: 'texto vacío' }
    const max = this.maxChars
    const clipped = trimmed.length > max ? trimmed.slice(0, max) : trimmed
    // Hash del contenido para detectar copias idénticas. NUNCA se guarda el texto.
    const hash = createHash('sha256').update(clipped).digest('hex')
    if (hash === this.lastTextHash) {
      // Mismo texto que la copia anterior: no se agrega a la cola.
      this.duplicateCount++
      logger.info('Texto del portapapeles idéntico al anterior: se omite', {
        chars: clipped.length,
      })
      return { ok: true, duplicate: true, chars: clipped.length, text: clipped }
    }
    this.lastTextHash = hash
    // SIN contenido en el log: solo longitud y si fue recortado.
    logger.info('Texto del portapapeles recibido', {
      chars: clipped.length, recortado: clipped.length < trimmed.length,
    })
    this.lastTextAt = Date.now()
    this.lastTextLength = clipped.length
    this.readCount++
    return { ok: true, chars: clipped.length, text: clipped }
  }
}
