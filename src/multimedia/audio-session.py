import sys, json
from pycaw.pycaw import AudioUtilities

# --- Media control (GSMTC) vía winrt — pausa/reanuda apps con sesión multimedia (YouTube en Chrome sin CDP) ---
def _gsmtc():
    import asyncio
    from winrt.windows.media.control import GlobalSystemMediaTransportControlsSessionManager as Mgr
    async def run(fn):
        return await fn(Mgr)
    return asyncio.run, Mgr

async def _gsmtc_list(Mgr):
    mgr = await Mgr.request_async()
    out = []
    for s in mgr.get_sessions():
        try: app = s.source_app_user_model_id or ''
        except Exception: app = ''
        title = ''
        try:
            p = await s.try_get_media_properties_async()
            if p: title = ((p.title or '') + ' — ' + (p.artist or '')).strip(' —')
        except Exception: pass
        try: status = str(s.get_playback_info().playback_status)
        except Exception: status = 'unknown'
        out.append({"app": app, "title": title, "status": status})
    return out

async def _gsmtc_set(Mgr, app_substr, title_substr, action, only_playing):
    mgr = await Mgr.request_async()
    res = []
    for s in mgr.get_sessions():
        try: app = s.source_app_user_model_id or ''
        except Exception: app = ''
        if app_substr.lower() not in app.lower():
            continue
        title = ''
        status = 'unknown'
        try:
            p = await s.try_get_media_properties_async()
            if p: title = ((p.title or '') + ' — ' + (p.artist or '')).strip(' —')
            status = str(s.get_playback_info().playback_status)
        except Exception: pass
        if title_substr and title_substr.lower() not in title.lower():
            continue
        if only_playing and status != '4':  # 4 = Playing
            continue
        try:
            if action == 'pause': ok = await s.try_pause_async()
            elif action == 'resume': ok = await s.try_play_async()
            else: ok = await s.try_toggle_play_pause_async()
            res.append({"app": app, "title": title[:100], "ok": bool(ok), "statusBefore": status})
        except Exception as e:
            res.append({"app": app, "title": title[:100], "error": str(e)})
    return res

def _media(action, req):
    asyncio_run, Mgr = _gsmtc()
    if action == "media-list":
        return {"sessions": asyncio_run(_gsmtc_list(Mgr))}
    app = str(req.get("app", "chrome"))
    tsub = str(req.get("title", ""))
    only_playing = bool(req.get("onlyPlaying", True))
    if action == "media-pause":
        return {"paused": asyncio_run(_gsmtc_set(Mgr, app, tsub, "pause", only_playing))}
    if action == "media-resume":
        return {"resumed": asyncio_run(_gsmtc_set(Mgr, app, tsub, "resume", False))}
    if action == "media-toggle":
        return {"toggled": asyncio_run(_gsmtc_set(Mgr, app, tsub, "toggle", False))}
    return {"error": "unknown media action"}

def sessions():
    out = []
    for s in AudioUtilities.GetAllSessions():
        if not s.Process:
            continue
        try:
            sv = s.SimpleAudioVolume
            vol = round(sv.GetMasterVolume() * 100)
        except Exception:
            vol = -1
        out.append({"ProcessId": s.Process.pid, "ProcessName": s.Process.name().replace(".exe",""), "Volume": vol})
    return out

def handle(req):
    """Procesa una petición JSON {action, ...} y devuelve el dict de respuesta."""
    action = req.get("action", "list")
    if action == "list":
        return {"sessions": sessions()}
    if action == "get":
        pid = int(req.get("pid", 0))
        return {"sessions": [s for s in sessions() if s["ProcessId"] == pid]}
    if action == "set":
        pid = int(req.get("pid", 0)); vol = int(req.get("volume", 0))
        updated = []
        for s in AudioUtilities.GetAllSessions():
            if not s.Process or s.Process.pid != pid:
                continue
            try:
                s.SimpleAudioVolume.SetMasterVolume(max(0.0, min(1.0, vol / 100.0)), None)
                updated.append({"ProcessId": pid, "ProcessName": s.Process.name().replace(".exe",""), "NewVolume": vol})
            except Exception as e:
                updated.append({"ProcessId": pid, "Error": str(e)})
        return {"action": "set", "updated": updated}
    if action == "duck":
        names = [n.strip().lower() for n in str(req.get("names", "")).split(",") if n.strip()]
        pct = int(req.get("pct", 0))
        ducked, snaps = [], []
        for s in AudioUtilities.GetAllSessions():
            if not s.Process:
                continue
            nm = s.Process.name().replace(".exe", "").lower()
            if not any(nm == n or n in nm for n in names):
                continue
            try:
                sv = s.SimpleAudioVolume
                prev = round(sv.GetMasterVolume() * 100)
                newv = max(0, round(prev * (1 - pct / 100.0)))
                if newv != prev:
                    sv.SetMasterVolume(newv / 100.0, None)
                ducked.append({"ProcessId": s.Process.pid, "ProcessName": s.Process.name().replace(".exe",""), "PreviousVolume": prev, "NewVolume": newv})
                snaps.append({"ProcessId": s.Process.pid, "ProcessName": s.Process.name().replace(".exe",""), "PreviousVolume": prev})
            except Exception as e:
                ducked.append({"ProcessId": s.Process.pid, "Error": str(e)})
        return {"action": "duck", "percentage": pct, "ducked": ducked, "snapshots": snaps}
    if action == "restore":
        snaps = req.get("snapshots", [])
        restored = []
        for s in AudioUtilities.GetAllSessions():
            if not s.Process:
                continue
            for snap in snaps:
                if snap.get("ProcessId") == s.Process.pid:
                    try:
                        s.SimpleAudioVolume.SetMasterVolume(snap["PreviousVolume"] / 100.0, None)
                        restored.append({"ProcessId": s.Process.pid, "RestoredVolume": snap["PreviousVolume"]})
                    except Exception as e:
                        restored.append({"ProcessId": s.Process.pid, "Error": str(e)})
                    break
        return {"action": "restore", "restored": restored}
    if action.startswith("media-"):
        try:
            return _media(action, req)
        except Exception as e:
            return {"error": "media control no disponible: " + str(e)}
    return {"error": "unknown action: " + str(action)}

# Modo daemon: lee líneas JSON de stdin, responde una línea JSON por stdout (persistente, sin costo de arranque)
if len(sys.argv) > 1 and sys.argv[1] == "--daemon":
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            rid = req.pop("__id", None)
            resp = handle(req)
            if rid is not None:
                resp["__id"] = rid
        except Exception as e:
            resp = {"error": str(e)}
        sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    sys.exit(0)

# Modo CLI de un solo comando (compatibilidad)
action = sys.argv[1] if len(sys.argv) > 1 else "list"
req = {"action": action}
if action == "get" and len(sys.argv) > 2: req["pid"] = int(sys.argv[2])
if action == "set" and len(sys.argv) > 3: req["pid"] = int(sys.argv[2]); req["volume"] = int(sys.argv[3])
if action == "duck" and len(sys.argv) > 3: req["names"] = sys.argv[2]; req["pct"] = int(sys.argv[3])
if action == "restore" and len(sys.argv) > 2: req["snapshots"] = json.loads(sys.argv[2])
print(json.dumps(handle(req), ensure_ascii=False))
