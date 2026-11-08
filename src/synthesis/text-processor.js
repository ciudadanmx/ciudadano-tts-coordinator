// Procesador de Markdown semántico para TTS.
// A diferencia del stripForSpeech del plugin (que usa /\s+/g y destruye estructura),
// este módulo preserva listas, párrafos, títulos y maneja respuestas largas
// dividiéndolas en fragmentos sin truncamiento silencioso.

/**
 * Convierte Markdown a texto hablado preservando estructura semántica.
 * - Código en bloque: omitido (con aviso opcional)
 * - Código inline: omitido
 * - Listas numeradas y con viñetas: se leen elemento por elemento con pausas
 * - Listas anidadas: se indican niveles
 * - Títulos: se anuncian como tales
 * - Tablas: se resumen
 * - Imágenes: se omiten las rutas
 * - Enlaces: se lee el texto del enlace
 */
export function markdownToSpeech(markdown, opts = {}) {
  const options = {
    skipCodeBlocks: opts.skipCodeBlocks !== false,
    skipInlineCode: opts.skipInlineCode !== false,
    summarizeTables: opts.summarizeTables !== false,
    skipImagePaths: opts.skipImagePaths !== false,
    codeBlockNotice: opts.codeBlockNotice || '',
    ...opts,
  }

  let text = String(markdown || '')
  if (!text.trim()) return ''

  // 1. Bloques de código fenceados ```...```
  if (options.skipCodeBlocks) {
    text = text.replace(/```[\s\S]*?```/g, (block) => {
      const lines = block.split('\n').length - 2
      return options.codeBlockNotice ? ` ${options.codeBlockNotice.replace('{n}', Math.max(1, lines))} ` : ' '
    })
  }

  // 2. Código inline `code`
  if (options.skipInlineCode) {
    text = text.replace(/`[^`\n]+`/g, ' ')
  }

  // 3. Imágenes ![alt](url)
  if (options.skipImagePaths) {
    text = text.replace(/!\[[^\]]*\]\([^)]+\)/g, (m) => {
      const alt = m.match(/!\[([^\]]*)\]/)?.[1]
      return alt ? ` Imagen: ${alt}. ` : ' '
    })
  }

  // 4. Tablas markdown → resumen
  if (options.summarizeTables) {
    text = text.replace(/(?:^[ \t]*\|.*\|[ \t]*$\n?)+/gm, (run) => {
      const rows = run.trim().split('\n')
        .filter(line => !/^\s*\|[\s:|-]+\|\s*$/.test(line))
      return ` Tabla con ${Math.max(1, rows.length)} filas. `
    })
  }

  // 5. Enlaces [texto](url) → solo el texto
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')

  // 6. Títulos: # Título → "Título." (con pausa después)
  text = text.replace(/^#{1,6}\s+(.+)$/gm, (m, title) => `${title.trim()}. `)

  // 7. Listas numeradas: "1. item" → "Uno. item" o "Número 1: item"
  text = text.replace(/^(\s*)(\d+)\.\s+(.+)$/gm, (m, indent, num, item) => {
    const depth = Math.floor(indent.length / 2)
    const prefix = depth > 0 ? 'subpunto ' : ''
    return `${prefix}${num}. ${item.trim()} `
  })

  // 8. Listas con viñetas: "- item" o "* item"
  text = text.replace(/^(\s*)[-*]\s+(.+)$/gm, (m, indent, item) => {
    const depth = Math.floor(indent.length / 2)
    const prefix = depth > 0 ? 'subpunto ' : 'punto '
    return `${prefix}${item.trim()} `
  })

  // 9. Negrita/cursiva: **texto** o *texto* → texto (sin asteriscos)
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1')
  text = text.replace(/\*([^*\n]+)\*/g, '$1')
  text = text.replace(/__([^_]+)__/g, '$1')
  text = text.replace(/_([^_\n]+)_/g, '$1')

  // 10. Citas blockquote: > texto
  text = text.replace(/^>\s?(.*)$/gm, '$1 ')

  // 11. Líneas horizontales ---
  text = text.replace(/^[-*_]{3,}$/gm, ' ')

  // 12. HTML tags restantes
  text = text.replace(/<[^>]+>/g, ' ')

  // 13. Normalizar espacios en blanco PERO preservar párrafos (doble salto = pausa)
  text = text.replace(/[^\S\n]{2,}/g, ' ') // espacios múltiples (no newlines) → un espacio
  text = text.replace(/\n{3,}/g, '\n\n')   // máximo 2 newlines seguidos
  text = text.split('\n').map(l => l.trim()).filter(l => l.length > 0).join('\n')

  return text.trim()
}

/**
 * Divide el texto procesado en fragmentos para síntesis/streaming.
 * Cada fragmento tiene: id único, interventionId, índice secuencial.
 * No trunca silenciosamente: si el texto es muy largo, genera más fragmentos.
 */
export function chunkForSpeech(text, opts = {}) {
  const maxChars = opts.maxCharsPerChunk || 320
  const interventionId = opts.interventionId || randomId()
  const paragraphs = String(text || '').split(/\n+/).map(p => p.trim()).filter(Boolean)
  if (!paragraphs.length) return []

  const chunks = []
  let current = ''
  let idx = 0

  for (const para of paragraphs) {
    // Si un párrafo solo excede el límite, dividirlo en oraciones
    if (para.length > maxChars * 2) {
      if (current) { chunks.push({ text: current, index: idx++, interventionId }); current = '' }
      const sentences = splitIntoSentences(para, maxChars)
      for (const s of sentences) {
        chunks.push({ text: s, index: idx++, interventionId })
      }
      continue
    }
    if (current && (current.length + para.length + 1) > maxChars) {
      chunks.push({ text: current, index: idx++, interventionId })
      current = para
    } else {
      current = current ? current + '\n' + para : para
    }
  }
  if (current) chunks.push({ text: current, index: idx++, interventionId })

  return chunks.map(c => ({ ...c, id: `${interventionId}-${c.index}`, totalFragments: chunks.length }))
}

function splitIntoSentences(text, maxChars) {
  const sentences = []
  let remaining = String(text || '').trim()
  while (remaining.length > maxChars) {
    // Buscar último punto/coma/espacio antes del límite
    let cut = remaining.lastIndexOf('. ', maxChars)
    if (cut < maxChars * 0.3) cut = remaining.lastIndexOf(', ', maxChars)
    if (cut < maxChars * 0.3) cut = remaining.lastIndexOf(' ', maxChars)
    if (cut < maxChars * 0.3) cut = maxChars
    sentences.push(remaining.slice(0, cut).trim())
    remaining = remaining.slice(cut).trim()
  }
  if (remaining) sentences.push(remaining)
  return sentences.filter(Boolean)
}

function randomId() {
  return 'int-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

/**
 * Prepara una respuesta completa del agente para TTS:
 * 1. Markdown → texto hablado
 * 2. División en fragmentos
 * 3. Opcionalmente antepone el anuncio de tarea
 */
export function prepareReply(markdown, opts = {}) {
  const spoken = markdownToSpeech(markdown, opts)
  if (!spoken) return { text: '', chunks: [] }
  const chunks = chunkForSpeech(spoken, opts)
  return { text: spoken, chunks }
}
