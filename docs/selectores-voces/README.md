# Selectores de voces — procedencia y reutilización

## Componentes originales localizados

| Categoría | Archivo original | Copia en el repo |
|---|---|---|
| Femeninas | `C:\Users\elyiz\Ciudadan_Voces_TTS\comparador.html` | `comparador-femeninas.html` |
| Masculinas | `C:\Users\elyiz\Ciudadan_Voces_Dany\comparador.html` | `comparador-masculinas.html` |

Ambos son comparadores/casting de Edge Neural con reproductores `<audio>` locales
(MP3 ya grabados). **NO** son selectores `<select>` interactivos.

## Qué se reutilizó en el panel del coordinador

1. **Catálogo**: las 6 voces femeninas y las 6 masculinas del casting se conservan
   como grupo destacado `★ Ciudadan` dentro del selector del panel. Se declaran en
   `config/default.json` → `voices.featured` (con `female` y `male`).

   ```
   Femeninas: es-MX-DaliaNeural, es-US-PalomaNeural, es-CO-SalomeNeural,
               es-PE-CamilaNeural, es-AR-ElenaNeural, es-CL-CatalinaNeural
   Masculinas: es-MX-JorgeNeural, es-CL-LorenzoNeural, es-CO-GonzaloNeural,
               es-PE-AlexNeural, es-AR-TomasNeural, es-US-AlonsoNeural
   ```

2. **Categorías**: las pestañas 👩 Femeninas / 👨 Masculinas del panel equivalen a
   las dos interfaces originales, pero con el **catálogo completo** de edge-tts
   (322 voces reales) y no solo las 6 de cada casting.

3. **Muestras**: los comparadores usaban `<audio>` con MP3 locales (un reproductor
   del navegador). En el coordinador las muestras **no** usan `<audio>`: se sintetizan
   con el mismo motor `edge-tts` y se reproducen con el **mpv del coordinador**, por
   la cola global (prioridad normal: no interrumpen las locuciones de otros agentes).
   Así no hay un segundo motor TTS ni un segundo reproductor.

## Otros componentes revisados (no reutilizables)

- `C:\yii\ciudadan_app_monorepo\ciudadan_frontend\src\components\TextToSpeech.jsx`
- `C:\yii\work\hackabot-invitacion\ciudadan_frontend\src\components\TextToSpeech.jsx`
- `\\192.168.1.7\Kompa\Dev\...` (varias copias)

Usan la **Web Speech API del navegador** (`speechSynthesis.getVoices()`): sus
identificadores de voz no son compatibles con nuestro motor `edge-tts`, y no separan
género ni ofrecen catálogo. Por eso no se reutilizan.
