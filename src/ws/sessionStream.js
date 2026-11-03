// TIOCSWINSZ's winsize struct fields are unsigned 16-bit, so anything above
// 65535 wraps to an unrelated value instead of erroring; these bounds are
// also just how large a real terminal panel could plausibly be, so a huge
// client-supplied size is rejected well below the wrap point, not clamped
// up to it.
const MAX_COLS = 500
const MAX_ROWS = 300

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
        if (
          typeof sessionId !== 'string' ||
          !Number.isInteger(cols) || !Number.isInteger(rows) ||
          cols <= 0 || rows <= 0 || cols > MAX_COLS || rows > MAX_ROWS
        ) {
          ws.send(JSON.stringify({ type: 'error', sessionId: sessionId ?? null, data: 'invalid frame' }))
          return
        }
        const session = sessionManager.get(sessionId)
        if (!session) {
          ws.send(JSON.stringify({ type: 'error', sessionId, data: 'unknown session' }))
          return
        }
        try {
          session.pty.resize(cols, rows)
        } catch {
          ws.send(JSON.stringify({ type: 'error', sessionId, data: 'resize failed' }))
        }
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
