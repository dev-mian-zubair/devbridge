// The dashboard's WS connection serves two unrelated purposes: a live feed
// of turnSessions activity (snapshot on connect, then every session:update
// / session:delta the chat-completions route and turnSessions publish —
// see src/turnEvents.js), and driving the single, dedicated login PTY
// (src/loginSession.js) through its own login:* frames. Neither purpose
// needs — or gets — a faithfully rendered terminal: the observability feed
// is plain assistant text, and the login flow only needs a URL/code
// extracted from raw output, not a real screen.
export function createSessionStreamHandler({ turnSessions, events, loginSession }) {
  return (ws, _request) => {
    let startedLogin = false

    ws.send(JSON.stringify({ type: 'snapshot', sessions: turnSessions.list() }))
    const unsubscribe = events.subscribe((message) => {
      ws.send(JSON.stringify(message))
    })

    ws.on('message', async (raw) => {
      let frame
      try {
        frame = JSON.parse(raw)
      } catch {
        ws.send(JSON.stringify({ type: 'error', data: 'invalid frame' }))
        return
      }

      const { type, data } = frame ?? {}

      if (type === 'login:start') {
        startedLogin = true
        await loginSession.start((chunk) => {
          ws.send(JSON.stringify({ type: 'login:output', data: chunk }))
        })
        return
      }

      if (type === 'login:input') {
        if (typeof data !== 'string') {
          ws.send(JSON.stringify({ type: 'error', data: 'invalid frame' }))
          return
        }
        loginSession.input(data)
        return
      }

      if (type === 'login:complete') {
        loginSession.dispose()
        return
      }

      ws.send(JSON.stringify({ type: 'error', data: 'invalid frame' }))
    })

    ws.on('close', () => {
      unsubscribe()
      // A dashboard tab closing mid-login is exactly the abandonment case
      // the login session's own GC timeout is a backstop for — disposing
      // here handles the common case immediately instead of waiting it out.
      if (startedLogin) loginSession.dispose()
    })
  }
}
