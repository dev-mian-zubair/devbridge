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

      const { type, sessionId, data } = frame ?? {}
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
