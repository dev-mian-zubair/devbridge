export function createSessionStreamHandler(sessionManager) {
  return (ws, _request) => {
    const disposables = new Map()

    ws.on('message', (raw) => {
      let frame
      try {
        frame = JSON.parse(raw)
      } catch {
        ws.send(JSON.stringify({ type: 'error', sessionId: null, data: 'invalid frame' }))
        return
      }

      const { type, sessionId, data, cols, rows } = frame ?? {}

      // The PTY is spawned at a fixed size before the browser's xterm.js
      // instance has ever reported its own — without this, the CLI's
      // full-screen TUI positions its cursor assuming a terminal width
      // that doesn't match what's actually rendered, producing garbled
      // output. The client sends its real size once it knows it (after
      // fitting to its container) and on every resize after that.
      if (type === 'resize') {
        if (typeof sessionId !== 'string' || !Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) {
          ws.send(JSON.stringify({ type: 'error', sessionId: sessionId ?? null, data: 'invalid frame' }))
          return
        }
        const session = sessionManager.get(sessionId)
        if (!session) {
          ws.send(JSON.stringify({ type: 'error', sessionId, data: 'unknown session' }))
          return
        }
        session.pty.resize(cols, rows)
        return
      }

      if (type !== 'input' || typeof sessionId !== 'string' || typeof data !== 'string') {
        ws.send(JSON.stringify({ type: 'error', sessionId: sessionId ?? null, data: 'invalid frame' }))
        return
      }

      const session = sessionManager.get(sessionId)
      if (!session) {
        ws.send(JSON.stringify({ type: 'error', sessionId, data: 'unknown session' }))
        return
      }

      if (!disposables.has(sessionId)) {
        const disposable = session.pty.onData((chunk) => {
          ws.send(JSON.stringify({ type: 'output', sessionId, data: chunk }))
        })
        disposables.set(sessionId, disposable)
      }

      session.pty.write(data)
    })

    ws.on('close', () => {
      for (const disposable of disposables.values()) {
        disposable?.dispose?.()
      }
      disposables.clear()
    })
  }
}
