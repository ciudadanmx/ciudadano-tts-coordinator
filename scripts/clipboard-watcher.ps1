# clipboard-watcher.ps1 — monitor del portapapeles de Windows (Sprint 1).
#
# QUE HACE
#   Escucha los eventos nativos del portapapeles (AddClipboardFormatListener +
#   WM_CLIPBOARDUPDATE) y, si el modulo esta activado, envia el texto copiado
#   al coordinador TTS existente (127.0.0.1:3199). Registra el atajo global
#   Ctrl+Alt+R para activar/desactivar la captura.
#
# POR QUE ES UN PROCESO SEPARADO
#   El nucleo del coordinador debe quedar independiente de Windows (compatibilidad
#   futura con Linux). Este watcher es el UNICO componente con Win32; habla con
#   el coordinador por HTTP, igual que los DSH.
#
# PRIVACIDAD
#   - El texto NO se escribe en ningun log. Solo se reporta su longitud.
#   - El portapapeles NO se modifica ni se limpia: se lee con GetClipboardData +
#     GlobalLock, sin OpenClipboard/EmptyClipboard.
#   - Solo se envia al sintetizador TTS configurado (el coordinador local).
#
# REQUISITOS
#   powershell.exe (Windows PowerShell 5.1). PowerShell 7 no trae
#   System.Windows.Forms ni el runtime de .NET Framework que usa el Add-Type.

param(
  [string]$CoordinatorUrl = 'http://127.0.0.1:3199',
  [string]$TokenFile = "$env:USERPROFILE\.ciudadan-tts-coordinator\token",
  [int]$PollStatusMs = 5000
)

$ErrorActionPreference = 'Stop'

# --------------------------------------------------------------------------
# C#: ventana "message-only" + AddClipboardFormatListener + RegisterHotKey.
# --------------------------------------------------------------------------
$cs = @'
using System;
using System.Collections.Concurrent;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public class ClipboardWatcher
{
    // ---- constantes Win32 ----
    const int WM_CLIPBOARDUPDATE = 0x031D;
    const int WM_HOTKEY         = 0x0312;
    const int WM_CLOSE          = 0x0010;
    const int WM_DESTROY        = 0x0002;
    const uint WM_APP_TEST      = 0x8001; // autotest del bucle de mensajes
    const uint CF_UNICODETEXT   = 13;
    static readonly IntPtr HWND_MESSAGE = new IntPtr(-3);
    const uint WS_EX_TOOLWINDOW = 0x00000080, WS_EX_NOACTIVATE = 0x08000000;
    const uint MOD_CONTROL = 0x0002, MOD_ALT = 0x0001, MOD_NOREPEAT = 0x4000;

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool AddClipboardFormatListener(IntPtr hwnd);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool RemoveClipboardFormatListener(IntPtr hwnd);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool RegisterHotKey(IntPtr hwnd, int id, uint fsModifiers, uint vk);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool UnregisterHotKey(IntPtr hwnd, int id);
    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr GetClipboardData(uint uFormat);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool IsClipboardFormatAvailable(uint format);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool OpenClipboard(IntPtr hWndNewOwner);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool CloseClipboard();
    [DllImport("user32.dll", SetLastError = true)]
    static extern uint GetClipboardSequenceNumber();
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr GlobalLock(IntPtr hMem);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GlobalUnlock(IntPtr hMem);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern ushort RegisterClass(ref WNDCLASS lpwc);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateWindowEx(uint dwExStyle, string lpClassName, string lpWindowName,
        uint dwStyle, int x, int y, int nWidth, int nHeight, IntPtr hWndParent, IntPtr hMenu,
        IntPtr hInstance, IntPtr lpParam);
    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr DefWindowProc(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool DestroyWindow(IntPtr hWnd);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool TranslateMessage(ref MSG lpMsg);
    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr DispatchMessage(ref MSG lpMsg);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr GetModuleHandle(string lpModuleName);

    [StructLayout(LayoutKind.Sequential)]
    public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int pt_x; public int pt_y; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct WNDCLASS
    {
        public uint style;
        public IntPtr lpfnWndProc;
        public int cbClsExtra;
        public int cbWndExtra;
        public IntPtr hInstance;
        public IntPtr hIcon;
        public IntPtr hCursor;
        public IntPtr hbrBackground;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpszMenuName;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpszClassName;
    }

    // ---- configuracion ----
    string coordinatorUrl;
    public string token; // publico: PowerShell lo renueva si el token rota
    int hotkeyId = 0xC11B;
    uint hotkeyModifiers;
    uint hotkeyVk;

    // ---- eventos hacia PowerShell ----
    // IMPORTANTE: el hilo del watcher NO puede invocar scriptblocks de
    // PowerShell (no es seguro entre hilos en PS 5.1). En su lugar, encola
    // eventos aqui y el hilo principal de PowerShell los procesa:
    //   "SELFTEST" | "HOTKEY" | "ERR|<msg>" | "TEXT|<texto copiado>"
    public ConcurrentQueue<string> Events = new ConcurrentQueue<string>();

    IntPtr hwnd = IntPtr.Zero;
    Thread thread;
    volatile bool running = false;
    uint lastSequence = 0;
    static WndProcDelegate keepAlive;

    delegate IntPtr WndProcDelegate(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    public bool HotkeyRegistered { get; private set; }
    public string HotkeyError { get; private set; }

    public ClipboardWatcher(string url, string tokenFile, string hotkey)
    {
        coordinatorUrl = url.TrimEnd('/');
        try { if (File.Exists(tokenFile)) token = File.ReadAllText(tokenFile).Trim(); } catch { }
        ParseHotkey(hotkey);
    }

    void ParseHotkey(string hotkey)
    {
        // "Ctrl+Alt+R" -> modificadores + tecla virtual.
        uint mods = 0; uint vk = 0;
        foreach (var part in (hotkey ?? "").Split('+'))
        {
            var p = part.Trim().ToUpperInvariant();
            if (p == "CTRL" || p == "CONTROL") mods |= MOD_CONTROL;
            else if (p == "ALT") mods |= MOD_ALT;
            else if (p == "SHIFT") mods |= 0x0004;
            else if (p == "WIN") mods |= 0x0008;
            else if (p.Length == 1) vk = (uint)System.Windows.Forms.Keys.A + (uint)(p[0] - 'A');
            else if (p.StartsWith("F") && p.Length > 1)
            {
                int fn;
                if (int.TryParse(p.Substring(1), out fn)) vk = (uint)(0x70 + fn - 1);
            }
        }
        hotkeyModifiers = mods | MOD_NOREPEAT;
        hotkeyVk = vk;
    }

    public void Start()
    {
        running = true;
        thread = new Thread(Run);
        thread.IsBackground = true;
        thread.Start();
    }

    public void Stop()
    {
        running = false;
        try { if (hwnd != IntPtr.Zero) PostMessage(hwnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero); } catch { }
    }

    void Run()
    {
        try
        {
            WNDCLASS wc = new WNDCLASS();
            wc.lpfnWndProc = Marshal.GetFunctionPointerForDelegate(keepAlive = new WndProcDelegate(WndProc));
            wc.hInstance = GetModuleHandle(null);
            wc.lpszClassName = "CiudadanClipboardWatcher";
            if (RegisterClass(ref wc) == 0)
            {
                Report("RegisterClass fallo: " + Marshal.GetLastWin32Error());
                return;
            }
            // Ventana top-level oculta (toolwindow, sin activar, no visible):
            // las ventanas "message-only" (HWND_MESSAGE) NO reciben de forma
            // fiable WM_CLIPBOARDUPDATE en todas las versiones de Windows.
            hwnd = CreateWindowEx(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, "CiudadanClipboardWatcher", "CiudadanClipboardWatcher",
                0, 0, 0, 0, 0, IntPtr.Zero, IntPtr.Zero, wc.hInstance, IntPtr.Zero);
            if (hwnd == IntPtr.Zero)
            {
                Report("CreateWindowEx fallo: " + Marshal.GetLastWin32Error());
                return;
            }

            if (!AddClipboardFormatListener(hwnd))
                Report("AddClipboardFormatListener fallo: " + Marshal.GetLastWin32Error());

            if (hotkeyVk != 0)
            {
                if (RegisterHotKey(hwnd, hotkeyId, hotkeyModifiers, hotkeyVk))
                {
                    HotkeyRegistered = true;
                    HotkeyError = null;
                }
                else
                {
                    int err = Marshal.GetLastWin32Error();
                    HotkeyRegistered = false;
                    HotkeyError = err == 1409
                        ? "El atajo ya esta reservado por otra aplicacion (ERROR_HOTKEY_ALREADY_REGISTERED)"
                        : "RegisterHotKey fallo (codigo " + err + ")";
                    Report(HotkeyError);
                }
            }

            MSG msg;
            while (running && GetMessage(out msg, IntPtr.Zero, 0, 0) != false)
            {
                TranslateMessage(ref msg);
                DispatchMessage(ref msg);
            }

            try { RemoveClipboardFormatListener(hwnd); } catch { }
            try { if (HotkeyRegistered) UnregisterHotKey(hwnd, hotkeyId); } catch { }
            try { DestroyWindow(hwnd); } catch { }
        }
        catch (Exception ex) { Report("watcher: " + ex.Message); }
    }

    IntPtr WndProc(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam)
    {
        if (Msg == WM_APP_TEST) { Events.Enqueue("SELFTEST"); return IntPtr.Zero; }
        if (Msg == WM_CLIPBOARDUPDATE)
        {
            try { HandleClipboardUpdate(); } catch (Exception ex) { Report("clipboard: " + ex.Message); }
            return IntPtr.Zero;
        }
        if (Msg == WM_HOTKEY)
        {
            Events.Enqueue("HOTKEY");
            return IntPtr.Zero;
        }
        if (Msg == WM_CLOSE || Msg == WM_DESTROY) { running = false; return IntPtr.Zero; }
        return DefWindowProc(hWnd, Msg, wParam, lParam);
    }

    void HandleClipboardUpdate()
    {
        // 1) Numero de secuencia: si es el mismo evento, no se procesa dos veces.
        uint seq = GetClipboardSequenceNumber();
        if (seq == lastSequence) return;

        // 2) Solo texto. Las imagenes, archivos y otros formatos se ignoran.
        if (!IsClipboardFormatAvailable(CF_UNICODETEXT)) { lastSequence = seq; return; }
        // Abrir solo para LEER: jamas se modifica ni se limpia el portapapeles.
        // (Si otro proceso tiene el portapapeles abierto, OpenClipboard falla
        // con ERROR_ACCESS_DENIED: se descarta el evento sin consumir la seq.)
        if (!OpenClipboard(hwnd)) return;
        IntPtr h = GetClipboardData(CF_UNICODETEXT);
        if (h == IntPtr.Zero) { CloseClipboard(); return; }

        // 3) Leer el texto (sin alterar el portapapeles).
        string text = null;
        IntPtr p = GlobalLock(h);
        if (p != IntPtr.Zero)
        {
            try { text = Marshal.PtrToStringUni(p); } finally { GlobalUnlock(h); }
        }
        CloseClipboard();
        if (string.IsNullOrWhiteSpace(text)) { lastSequence = seq; return; }
        lastSequence = seq;

        // 4) El texto NUNCA se registra en un log: va a la cola de eventos
        //    para que el hilo principal de PowerShell lo envie al coordinador.
        Events.Enqueue("TEXT|" + text);
    }

    void Report(string msg) { try { Events.Enqueue("ERR|" + msg); } catch { } }

    // ---- HTTP minimo contra el coordinador local ----
    public string HttpGet(string path)
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create(coordinatorUrl + path);
            req.Method = "GET";
            req.Timeout = 4000;
            if (!string.IsNullOrEmpty(token)) req.Headers["Authorization"] = "Bearer " + token;
            using (var resp = (HttpWebResponse)req.GetResponse())
            using (var sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8)) return sr.ReadToEnd();
        }
        catch { return null; }
    }

    public string HttpPost(string path, string json)
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create(coordinatorUrl + path);
            req.Method = "POST";
            req.Timeout = 8000;
            req.ContentType = "application/json";
            if (!string.IsNullOrEmpty(token)) req.Headers["Authorization"] = "Bearer " + token;
            var bytes = Encoding.UTF8.GetBytes(json ?? "{}");
            req.ContentLength = bytes.Length;
            using (var st = req.GetRequestStream()) st.Write(bytes, 0, bytes.Length);
            using (var resp = (HttpWebResponse)req.GetResponse())
            using (var sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8)) return sr.ReadToEnd();
        }
        catch { return null; }
    }
}
'@

Add-Type -TypeDefinition $cs -ReferencedAssemblies System.Windows.Forms, System.Drawing

# --------------------------------------------------------------------------
# PowerShell: conecta el watcher de C# con el coordinador.
# --------------------------------------------------------------------------
function Get-Token { try { if (Test-Path -LiteralPath $TokenFile) { return (Get-Content -LiteralPath $TokenFile -Raw).Trim() } } catch { } return $null }

$watcher = New-Object ClipboardWatcher -ArgumentList @($CoordinatorUrl, $TokenFile, 'Ctrl+Alt+R')

function Write-Line([string]$msg) {
  [Console]::Out.WriteLine(("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg))
  [Console]::Out.Flush()
}

function Send-CopiedText([string]$text) {
  # 1) el modulo esta activado? (el coordinador es la fuente de verdad)
  $st = $watcher.HttpGet('/api/v1/clipboard/status')
  if (-not $st) { return }
  try { $j = $st | ConvertFrom-Json } catch { return }
  if (-not $j.enabled) { return }

  # 2) limite de longitud (lo aplica tambien el coordinador)
  $max = 2000
  if ($j.maxChars) { $max = [int]$j.maxChars }
  if ($text.Length -gt $max) { $text = $text.Substring(0, $max) }

  # 3) enviar al coordinador por el MISMO endpoint que usan los DSH. El
  #    coordinador valida, reemplaza la lectura anterior de esta fuente y la
  #    marca como efimera (no va al historial). Aqui no se registra el texto.
  $payload = @{ text = $text; source = 'clipboard'; sessionId = 'clipboard' } | ConvertTo-Json -Compress
  $null = $watcher.HttpPost('/api/v1/speech', $payload)
}

$watcher.Start()
Start-Sleep -Milliseconds 800

# --- reportar el estado del watcher al coordinador ---
$statusPayload = @{
  running = $true
  hotkeyRegistered = $watcher.HotkeyRegistered
  hotkeyError = $watcher.HotkeyError
  hotkey = 'Ctrl+Alt+R'
  pid = $PID
} | ConvertTo-Json -Compress
$null = $watcher.HttpPost('/api/v1/clipboard/watcher-status', $statusPayload)

Write-Line ("watcher del portapapeles activo | atajo registrado: {0} | {1}" -f `
  $watcher.HotkeyRegistered, $(if ($watcher.HotkeyError) { $watcher.HotkeyError } else { 'sin errores' }))

# --- bucle principal: procesa los eventos que encola el hilo del watcher ---
# (el hilo de C# no puede llamar scriptblocks de PowerShell: no es seguro).
$lastStatus = [DateTime]::MinValue
try {
  while ($true) {
    $ev = $null
    while ($watcher.Events.TryDequeue([ref]$ev)) {
      if ($ev -eq 'SELFTEST') {
        Write-Line 'DBG selftest OK (bucle de mensajes y WndProc responden)'
      } elseif ($ev -eq 'HOTKEY') {
        # Atajo global Ctrl+Alt+R: alterna la captura. Solo se registra el estado.
        $res = $watcher.HttpPost('/api/v1/clipboard/toggle', '{}')
        Write-Line ("atajo Ctrl+Alt+R -> {0}" -f $res)
      } elseif ($ev.StartsWith('ERR|')) {
        Write-Line $ev.Substring(4)
      } elseif ($ev.StartsWith('TEXT|')) {
        Send-CopiedText $ev.Substring(5)
      }
    }
    # Re-reportar el estado cada 30 s: si el coordinador se reinicio, su estado
    # en memoria queda en "no corriendo" hasta que el watcher se lo diga otra vez.
    if (([DateTime]::Now - $lastStatus).TotalSeconds -ge 30) {
      $lastStatus = [DateTime]::Now
      $statusPayload = @{
        running = $true
        hotkeyRegistered = $watcher.HotkeyRegistered
        hotkeyError = $watcher.HotkeyError
        hotkey = 'Ctrl+Alt+R'
        pid = $PID
      } | ConvertTo-Json -Compress
      $null = $watcher.HttpPost('/api/v1/clipboard/watcher-status', $statusPayload)
    }
    # el token puede rotarse: se relee de vez en cuando
    $t = Get-Token
    if ($t) { $watcher.token = $t }
    Start-Sleep -Milliseconds 300
  }
} finally {
  try { $watcher.Stop() } catch { }
}
