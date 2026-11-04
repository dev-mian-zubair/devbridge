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
    let loginOutputListener = null

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
        loginOutputListener = (chunk) => {
          ws.send(JSON.stringify({ type: 'login:output', data: chunk }))
        }
        await loginSession.start(loginOutputListener)
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
      // Detach, not dispose: the login PTY is a single shared singleton
      // (loginSession.js) — this connection may just be a second tab
      // observing an already-active session, not its owner, so "this
      // connection closed" doesn't mean "the login is abandoned."
      // loginSession.detach() only tears the session down after a short
      // grace period with zero listeners left attached (a reload/second
      // tab reconnecting cancels it) — see its own comment for why.
      // Confirmed live: disposing unconditionally here tore down a session
      // right after the CLI printed "Login successful. Press Enter to
      // continue…", before credentials were written.
      if (loginOutputListener) loginSession.detach(loginOutputListener)
    })
  }
}
