export function createSessionStreamHandler(sessionManager) {
  return (ws, _request) => {
    const subscribed = new Set()

    ws.on('message', (raw) => {
      const { type, sessionId, data } = JSON.parse(raw)
      if (type !== 'input') return

      const session = sessionManager.get(sessionId)
      if (!session) {
        ws.send(JSON.stringify({ type: 'error', sessionId, data: 'unknown session' }))
        return
      }

      if (!subscribed.has(sessionId)) {
        subscribed.add(sessionId)
        session.pty.onData((chunk) => {
          ws.send(JSON.stringify({ type: 'output', sessionId, data: chunk }))
        })
      }

      session.pty.write(data)
    })
  }
}
