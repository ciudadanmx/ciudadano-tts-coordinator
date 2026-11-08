// Script que se inyecta en el cliente web de DSH para enviar metadatos reales
// de sesión (título, displayTitle, cwd, tarea activa) al servidor del bridge.
//
// Este código corre en el navegador y hace POST a /ciudadan-bridge/session-meta
// cada vez que cambia la sesión activa o su título.

(function () {
  if (window.__CIUDADAN_BRIDGE_INJECTED__) return
  window.__CIUDADAN_BRIDGE_INJECTED__ = true

  let lastSent = null

  function sendMeta() {
    try {
      // Intentar leer del catálogo de sesiones expuesto por DSH
      const catalog = window.__DSH_SESSIONS__ ||
        (window.dsh && window.dsh.sessions && window.dsh.sessions.list) ||
        null

      if (!catalog) return

      let sessions = []
      if (catalog.getSnapshot) {
        const snap = catalog.getSnapshot()
        sessions = Object.values(snap.byId || {})
      } else if (Array.isArray(catalog)) {
        sessions = catalog
      }

      for (const s of sessions) {
        const meta = {
          sessionId: s.id,
          title: s.title || '',
          displayTitle: s.displayTitle || s.title || '',
          cwd: s.cwd || '',
          taskTitle: s.activeTask || s.taskTitle || '',
        }
        const key = JSON.stringify(meta)
        if (key === lastSent) continue
        lastSent = key

        fetch('/ciudadan-bridge/session-meta', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(meta),
          credentials: 'same-origin',
        }).catch(() => {})
      }
    } catch { /* silencioso */ }
  }

  // Enviar periódicamente y en cambios de ruta
  setInterval(sendMeta, 3000)
  window.addEventListener('popstate', sendMeta)
  // Observar cambios en el DOM que puedan indicar cambio de sesión
  if (typeof MutationObserver !== 'undefined') {
    const obs = new MutationObserver(() => sendMeta())
    obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['title'] })
  }
})()
