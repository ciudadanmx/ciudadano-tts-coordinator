# Guía de reversión — ciudadano-tts-coordinator

## Desactivar el coordinador y volver al plugin original

### Paso 1: Detener el servicio coordinador

```powershell
# Encontrar y detener el proceso
Get-Process node | Where-Object { $_.CommandLine -like '*ciudadan-tts-coordinator*' } | Stop-Process -Force
```

O simplemente cerrar la terminal donde corre (Ctrl+C).

### Paso 2: Revertir la configuración del plugin dsh-tts en DSH2

```powershell
powershell -ExecutionPolicy Bypass -File "K:\agente2ciudadanmex\ciudadan-tts-coordinator\scripts\configure-dsh-plugin.ps1" `
  -DSHHome "C:\Users\elyiz\.dsh-2" -Action disable
```

Esto restaura `speakReplies: true` desde el backup en `C:\Users\elyiz\.dsh-2\data\dsh-tts-backup-coordinator\`.

### Paso 3: Revertir DSH1 (si se aplicó)

```powershell
powershell -ExecutionPolicy Bypass -File "K:\agente2ciudadanmex\ciudadan-tts-coordinator\scripts\configure-dsh-plugin.ps1" `
  -DSHHome "C:\Users\elyiz\.dsh" -Action disable
```

### Paso 4: Desinstalar hook de Claude Code (opcional)

```powershell
powershell -ExecutionPolicy Bypass -File "K:\agente2ciudadanmex\ciudadan-tts-coordinator\scripts\install-claude-hook.ps1" -Uninstall
```

### Paso 5: Verificar estado

```powershell
# En cada DSH:
powershell -ExecutionPolicy Bypass -File "...\configure-dsh-plugin.ps1" -DSHHome "C:\Users\elyiz\.dsh-2" -Action status
# Debe mostrar: speakReplies = true (modo original)
```

### Paso 6: Reiniciar DSH (solo si es necesario)

El cambio de `speakReplies` se aplica en caliente en la mayoría de los casos.
Si no, reiniciar la sesión web de DSH correspondiente.

## Archivos que NO se modifican durante la reversión

- Ningún archivo del plugin `@goodandready/dsh-tts` instalado
- Ninguna credencial
- Ningún otro servicio (DSH1, DSH2, puentes)

## Archivos propios del coordinador (seguros de eliminar)

```
~/.ciudadan-tts-coordinator/          — token, config, cache, voice-assignments
%TEMP%\ciudadan-tts-coordinator\       — copia temporal de trabajo
K:\agente2ciudadanmex\ciudadan-tts-coordinator\  — código fuente (se puede conservar o eliminar)
```
