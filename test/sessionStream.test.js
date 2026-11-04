import { describe, it, expect, vi } from 'vitest'
import { createSessionStreamHandler } from '../src/ws/sessionStream.js'

function fakeWs() { return { send: vi.fn(), on: vi.fn() } }

function fakeTurnSessions(sessions = []) {
  return { list: vi.fn(() => sessions) }
}

function fakeEvents() {
  let listener = null
  return {
    subscribe: vi.fn((cb) => { listener = cb; return vi.fn() }),
    emit: (message) => listener?.(message),
  }
}

function fakeLoginSession() {
  return { start: vi.fn(async () => {}), input: vi.fn(), detach: vi.fn(), dispose: vi.fn(), isActive: vi.fn(() => false) }
}

function wire(ws, turnSessions, events, loginSession) {
  const handler = createSessionStreamHandler({ turnSessions, events, loginSession })
  handler(ws, {})
  const onMessage = ws.on.mock.calls.find(([event]) => event === 'message')[1]
  const onClose = ws.on.mock.calls.find(([event]) => event === 'close')?.[1]
  return { onMessage, onClose }
}

describe('createSessionStreamHandler', () => {
  it('sends a snapshot of turnSessions.list() immediately on connect', () => {
    const ws = fakeWs()
    const sessions = [{ sessionId: 's1', projectPath: '/p', status: 'idle' }]
    wire(ws, fakeTurnSessions(sessions), fakeEvents(), fakeLoginSession())
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'snapshot', sessions }))
  })

  it('forwards every message published on the shared event bus to the socket', () => {
    const ws = fakeWs()
    const events = fakeEvents()
    wire(ws, fakeTurnSessions(), events, fakeLoginSession())
    events.emit({ type: 'session:update', session: { sessionId: 's1' } })
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'session:update', session: { sessionId: 's1' } }))
  })

  it('login:start starts the login session with a callback that forwards output as login:output', async () => {
    const ws = fakeWs()
    const loginSession = fakeLoginSession()
    const { onMessage } = wire(ws, fakeTurnSessions(), fakeEvents(), loginSession)
    await onMessage(JSON.stringify({ type: 'login:start' }))
    expect(loginSession.start).toHaveBeenCalledTimes(1)
    const onOutput = loginSession.start.mock.calls[0][0]
    onOutput('visit https://example.com')
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'login:output', data: 'visit https://example.com' }))
  })

  it('login:input forwards its data to loginSession.input', async () => {
    const ws = fakeWs()
    const loginSession = fakeLoginSession()
    const { onMessage } = wire(ws, fakeTurnSessions(), fakeEvents(), loginSession)
    await onMessage(JSON.stringify({ type: 'login:input', data: 'pasted-code\r' }))
    expect(loginSession.input).toHaveBeenCalledWith('pasted-code\r')
  })

  it('login:input with non-string data sends an error frame instead of forwarding it', async () => {
    const ws = fakeWs()
    const loginSession = fakeLoginSession()
    const { onMessage } = wire(ws, fakeTurnSessions(), fakeEvents(), loginSession)
    await onMessage(JSON.stringify({ type: 'login:input', data: 42 }))
    expect(loginSession.input).not.toHaveBeenCalled()
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'error', data: 'invalid frame' }))
  })

  it('login:complete disposes the login session', async () => {
    const ws = fakeWs()
    const loginSession = fakeLoginSession()
    const { onMessage } = wire(ws, fakeTurnSessions(), fakeEvents(), loginSession)
    await onMessage(JSON.stringify({ type: 'login:complete' }))
    expect(loginSession.dispose).toHaveBeenCalledTimes(1)
  })

  it('sends an error frame for malformed JSON instead of throwing', async () => {
    const ws = fakeWs()
    const { onMessage } = wire(ws, fakeTurnSessions(), fakeEvents(), fakeLoginSession())
    await expect(onMessage('not json')).resolves.not.toThrow()
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'error', data: 'invalid frame' }))
  })

  it('sends an error frame for an unknown frame type', async () => {
    const ws = fakeWs()
    const { onMessage } = wire(ws, fakeTurnSessions(), fakeEvents(), fakeLoginSession())
    await onMessage(JSON.stringify({ type: 'nonsense' }))
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'error', data: 'invalid frame' }))
  })

  it('detaches (not disposes) the login session on close if this connection started one', async () => {
    // The login PTY is a single shared singleton (loginSession.js) — this
    // connection could be a second tab merely observing an already-active
    // session, not its owner. Disposing outright on close killed a login
    // that had already succeeded (confirmed live: the CLI printed "Login
    // successful. Press Enter to continue…" and a transient disconnect —
    // a page reload, a second viewer closing, a network blip — tore it
    // down before credentials were ever written). detach() instead gives
    // loginSession.js's own bounded grace period a chance to see a
    // reconnect before actually tearing anything down.
    const ws = fakeWs()
    const loginSession = fakeLoginSession()
    const { onMessage, onClose } = wire(ws, fakeTurnSessions(), fakeEvents(), loginSession)
    await onMessage(JSON.stringify({ type: 'login:start' }))
    onClose()
    expect(loginSession.dispose).not.toHaveBeenCalled()
    expect(loginSession.detach).toHaveBeenCalledTimes(1)
    const detachedListener = loginSession.detach.mock.calls[0][0]
    expect(detachedListener).toBe(loginSession.start.mock.calls[0][0])
  })

  it('does not call detach on close if this connection never started a login', () => {
    const ws = fakeWs()
    const loginSession = fakeLoginSession()
    const { onClose } = wire(ws, fakeTurnSessions(), fakeEvents(), loginSession)
    onClose()
    expect(loginSession.detach).not.toHaveBeenCalled()
  })

  it('unsubscribes from the event bus on close', () => {
    const ws = fakeWs()
    const events = fakeEvents()
    const unsubscribe = vi.fn()
    events.subscribe = vi.fn(() => unsubscribe)
    const { onClose } = wire(ws, fakeTurnSessions(), events, fakeLoginSession())
    onClose()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
