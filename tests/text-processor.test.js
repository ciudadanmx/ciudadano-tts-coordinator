// Pruebas del procesador de Markdown: listas, párrafos, código, respuestas largas.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { markdownToSpeech, chunkForSpeech, prepareReply } from '../src/synthesis/text-processor.js'

describe('markdownToSpeech - preservación de estructura', () => {
  test('lista numerada de 3 elementos se conserva completa', () => {
    const md = `Tenemos tres tareas:

1. Revisar las conexiones.
2. Actualizar los servicios.
3. Ejecutar las pruebas.

Después podemos continuar.`
    const out = markdownToSpeech(md)
    assert.ok(out.includes('1.'), 'debe conservar el número 1')
    assert.ok(out.includes('2.'), 'debe conservar el número 2')
    assert.ok(out.includes('3.'), 'debe conservar el número 3')
    assert.ok(out.includes('Revisar las conexiones'), 'debe incluir item 1')
    assert.ok(out.includes('Actualizar los servicios'), 'debe incluir item 2')
    assert.ok(out.includes('Ejecutar las pruebas'), 'debe incluir item 3')
    assert.ok(out.includes('Después podemos continuar'), 'debe incluir el párrafo final')
  })

  test('lista de 10 elementos no pierde ninguno', () => {
    const items = Array.from({ length: 10 }, (_, i) => `${i + 1}. Elemento número ${i + 1}.`).join('\n')
    const out = markdownToSpeech(items)
    for (let i = 1; i <= 10; i++) {
      assert.ok(out.includes(`Elemento número ${i}`), `falta elemento ${i}`)
    }
  })

  test('lista de 30 elementos no pierde ninguno', () => {
    const items = Array.from({ length: 30 }, (_, i) => `- Item ${i + 1} de la lista.`).join('\n')
    const out = markdownToSpeech(items)
    for (let i = 1; i <= 30; i++) {
      assert.ok(out.includes(`Item ${i} de la lista`), `falta item ${i}`)
    }
  })

  test('listas anidadas preservan jerarquía', () => {
    const md = `- Principal A
  - Sub A1
  - Sub A2
- Principal B
  - Sub B1`
    const out = markdownToSpeech(md)
    assert.ok(out.includes('Principal A'))
    assert.ok(out.includes('Sub A1'))
    assert.ok(out.includes('Sub A2'))
    assert.ok(out.includes('Principal B'))
    assert.ok(out.includes('Sub B1'))
    assert.ok(out.includes('subpunto'), 'debe indicar nivel anidado')
  })

  test('bloque de código se omite', () => {
    const md = `Antes del código.

\`\`\`javascript
const x = 42;
console.log(x);
\`\`\`

Después del código.`
    const out = markdownToSpeech(md)
    assert.ok(out.includes('Antes del código'))
    assert.ok(out.includes('Después del código'))
    assert.ok(!out.includes('const x = 42'), 'NO debe leer el código')
    assert.ok(!out.includes('console.log'), 'NO debe leer el código')
  })

  test('código inline se omite', () => {
    const md = 'Usa `npm install` para instalar dependencias.'
    const out = markdownToSpeech(md)
    assert.ok(!out.includes('npm install'), 'no debe leer código inline')
    assert.ok(out.includes('para instalar dependencias'))
  })

  test('títulos se convierten a texto con pausa', () => {
    const md = `# Título principal
## Subtítulo importante
Texto normal.`
    const out = markdownToSpeech(md)
    assert.ok(out.includes('Título principal'))
    assert.ok(out.includes('Subtítulo importante'))
    assert.ok(out.includes('Texto normal'))
  })

  test('enlaces: solo se lee el texto, no la URL', () => {
    const md = 'Visita [nuestra documentación](https://ejemplo.com/docs) para más info.'
    const out = markdownToSpeech(md)
    assert.ok(out.includes('nuestra documentación'))
    assert.ok(!out.includes('https://ejemplo.com'), 'no debe leer la URL')
  })

  test('tabla se resume', () => {
    const md = `| Nombre | Edad |
|--------|------|
| Ana    | 30   |
| Luis   | 25   |

Texto después.`
    const out = markdownToSpeech(md)
    assert.ok(out.includes('Tabla con'), 'debe anunciar la tabla')
    assert.ok(out.includes('filas'))
    assert.ok(out.includes('Texto después'))
  })
})

describe('chunkForSpeech - respuestas largas sin truncamiento', () => {
  test('texto de 5000 caracteres se divide en múltiples chunks sin pérdida', () => {
    const longText = 'Esta es una oración de prueba. '.repeat(200) // ~6400 chars
    const chunks = chunkForSpeech(longText, { maxCharsPerChunk: 320 })
    assert.ok(chunks.length > 1, 'debe haber más de un chunk')
    const totalLen = chunks.reduce((sum, c) => sum + c.text.length, 0)
    // Verificar que no se perdió contenido sustancial (permitimos pequeña pérdida por los \n)
    assert.ok(totalLen > longText.length * 0.9, `se perdió contenido: ${totalLen} vs ${longText.length}`)
    // Verificar índices secuenciales
    chunks.forEach((c, i) => assert.equal(c.index, i))
    // Verificar que todos tienen el mismo interventionId
    const ids = new Set(chunks.map(c => c.interventionId))
    assert.equal(ids.size, 1, 'todos los chunks deben tener el mismo interventionId')
  })

  test('texto de 10000+ caracteres', () => {
    const veryLong = 'Palabra '.repeat(2000) // ~14000 chars
    const chunks = chunkForSpeech(veryLong, { maxCharsPerChunk: 320 })
    assert.ok(chunks.length >= 30, `esperaba al menos 30 chunks, obtuvo ${chunks.length}`)
  })

  test('párrafos mezclados con listas', () => {
    const md = `Introducción.

1. Primero.
2. Segundo.

Conclusión.`
    const prepared = prepareReply(md)
    assert.ok(prepared.chunks.length >= 1)
    const fullText = prepared.chunks.map(c => c.text).join(' ')
    assert.ok(fullText.includes('Primero'))
    assert.ok(fullText.includes('Segundo'))
    assert.ok(fullText.includes('Conclusión'))
  })
})

describe('prepareReply - integración completa', () => {
  test('respuesta completa con títulos, listas, código y párrafos', () => {
    const md = `# Resultado del análisis

Encontré los siguientes puntos:

1. El servicio A está caído.
2. El servicio B responde lento.
   - Subpunto: latencia alta.
   - Subpunto: timeout en peticiones.
3. El servicio C funciona bien.

\`\`\`bash
sudo systemctl restart servicio-a
\`\`\`

Después de reiniciar, todo debería funcionar.

## Conclusión

Recomiendo monitorear durante 10 minutos.`
    const prepared = prepareReply(md)
    const full = prepared.chunks.map(c => c.text).join('\n')
    assert.ok(full.includes('servicio A está caído'))
    assert.ok(full.includes('servicio B responde lento'))
    assert.ok(full.includes('latencia alta'))
    assert.ok(full.includes('timeout en peticiones'))
    assert.ok(full.includes('servicio C funciona bien'))
    assert.ok(full.includes('Después de reiniciar'))
    assert.ok(full.includes('monitorear durante 10 minutos'))
    assert.ok(!full.includes('sudo systemctl'), 'NO debe incluir el comando del código')
    assert.ok(!full.includes('systemctl restart'), 'NO debe incluir código')
  })
})
