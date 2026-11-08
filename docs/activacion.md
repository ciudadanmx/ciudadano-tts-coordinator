# Activación en producción — 2026-11-04

## Estado final verificado

| Servicio | Puerto | Estado | Bridge |
|---|---|---|---|
| ciudadano-tts-coordinator | 3199 | ✅ healthy, mpv ready | — |
| DSH1 | 3080 | ✅ activo | ✅ hasToken:true, source:dsh1 |
| DSH2 | 3081 | ✅ activo | ✅ hasToken:true, source:dsh2 |
| dsh-dany | 3091 | ✅ intacto (no tocado) | — |
| ChatGPT bridge | 8765/8770 | ✅ activos | — |

## Token

- Archivo: `~/.ciudadan-tts-coordinator/token` (64 hex chars, permisos restringidos)
- El coordinador lo lee del archivo (NO usar CIUDADAN_TTS_TOKEN en env si se inicia via cmd — quoting corrupto)
- El bridge de DSH1/DSH2 también lo lee del mismo archivo

## Inicio del coordinador (robusto)

```cmd
scripts\start-coordinator.cmd
```

O manual:
```cmd
cd %TEMP%\ciudadan-tts-coordinator
node src\server\index.js >> %USERPROFILE%\.ciudadan-tts-coordinator\server-stdout.log 2>&1
```

⚠️ **NO iniciar con pipes de PowerShell** — cuando el padre muere, el hijo entra en loop EPIPE.
El logger fue parcheado (`src/monitoring/logger.js`) para ignorar EPIPE en console.

## Prueba E2E realizada (evidencia)

```
POST /api/v1/speech {source:dsh2, voice:es-CO-SalomeNeural, text:"Hola, soy la voz de DSH2..."}
  → 202 queued → 🔊 reproduciendo → done ✅
POST /api/v1/speech {source:claude-code, voice:es-AR-TomasNeural, text:"Hola, soy Claude Code..."}
  → 202 queued → espera turno → 🔊 reproduciendo → done ✅
```

Sesiones registradas con voces persistentes:
- `dsh2-e2e` → es-CO-SalomeNeural
- `claude-e2e` → es-AR-TomasNeural

## Reversión inmediata

```powershell
# 1. Restaurar speakReplies en ambos DSH
powershell -File scripts\configure-dsh-plugin.ps1 -DSHHome "C:\Users\elyiz\.dsh-2" -Action disable
powershell -File scripts\configure-dsh-plugin.ps1 -DSHHome "C:\Users\elyiz\.dsh" -Action disable
# 2. Reiniciar DSH1 y DSH2 (vuelven al modo original)
# 3. Detener coordinador: taskkill /F /IM node.exe /FI "CMDLINE eq *src/server/index.js*"
# 4. Desinstalar hook Claude: powershell -File scripts\install-claude-hook.ps1 -Uninstall
```

## Archivos de respaldo creados

- `C:\Users\elyiz\.dsh-2\data\dsh-tts-backup-coordinator\`
- `C:\Users\elyiz\.dsh\data\dsh-tts-backup-coordinator\`
- `C:\Users\elyiz\.dsh-2\profiles\web\cordis.patch.yml.backup-bridge-*`
- `C:\Users\elyiz\.dsh\profiles\web\cordis.patch.yml.backup-bridge-*`
