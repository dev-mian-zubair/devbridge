import { describe, it, expect, vi } from 'vitest'
import { createSessionStreamHandler } from '../src/ws/sessionStream.js'
import { createSessionManager } from '../src/sessionManager.js'

function fakeWs() { return { send: vi.fn(), on: vi.fn() } }

// projectPath in these tests is a fixture string, not a real directory on
// this test host (unlike inside the container), so the real fs.statSync
// default is swapped for one that treats any path as valid.
const FAKE_STAT = { statFn: () => ({ isDirectory: () => true }) }

// getOrCreate() now does its own internal onData() registration (the
// readiness wait) before resolving, separate from any listener the WS
// handler itself registers afterward — each onData() call here gets its
// own disposable so a test can target the specific registration it cares
// about via lastDisposeSpy(), not conflate it with the readiness one.
function fakePtyFactory() {
  let dataCb
  const disposeSpies = []
  return {
    spawnFn: vi.fn(() => ({
      write: vi.fn(),
      resize: vi.fn(),
      onData: (cb) => {
        dataCb = cb
        const spy = vi.fn()
        disposeSpies.push(spy)
        return { dispose: spy }
      },
      onExit: vi.fn(),
      kill: vi.fn(),
    })),
    trigger: (chunk) => dataCb(chunk),
    lastDisposeSpy: () => disposeSpies[disposeSpies.length - 1],
  }
}

describe('createSessionStreamHandler', () => {
  it('writes inbound input data to the matching session PTY', async () => {
    const { spawnFn } = fakePtyFactory()
    const sessionManager = createSessionManager(spawnFn, FAKE_STAT)
    const session = await sessionManager.getOrCreate('s1', '/app/workspace/proj')
    const ws = fakeWs()
    const handler = createSessionStreamHandler(sessionManager)
    handler(ws, {})
    const onMessage = ws.on.mock.calls.find(([event]) => event === 'message')[1]
    onMessage(JSON.stringify({ type: 'input', sessionId: 's1', data: '/login\n' }))
    expect(session.pty.write).toHaveBeenCalledWith('/login\n')
  })

  it('forwards PTY output as an outbound output frame', async () => {
    const { spawnFn, trigger } = fakePtyFactory()
    const sessionManager = createSessionManager(spawnFn, FAKE_STAT)
    await sessionManager.getOrCreate('s1', '/app/workspace/proj')
    const ws = fakeWs()
    const handler = createSessionStreamHandler(sessionManager)
    handler(ws, {})
    const onMessage = ws.on.mock.calls.find(([event]) => event === 'message')[1]
    onMessage(JSON.stringify({ type: 'input', sessionId: 's1', data: 'x' }))
    trigger('some terminal output')
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'output', sessionId: 's1', data: 'some terminal output' }))
  })

  it('sends an error frame for an unknown sessionId instead of throwing', () => {
    const sessionManager = createSessionManager(vi.fn())
    const ws = fakeWs()
    const handler = createSessionStreamHandler(sessionManager)
    handler(ws, {})
    const onMessage = ws.on.mock.calls.find(([event]) => event === 'message')[1]
    expect(() => onMessage(JSON.stringify({ type: 'input', sessionId: 'missing', data: 'x' }))).not.toThrow()
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'error', sessionId: 'missing', data: 'unknown session' }))
  })

  it('sends an error frame for malformed JSON instead of throwing', () => {
    const sessionManager = createSessionManager(vi.fn())
    const ws = fakeWs()
    const handler = createSessionStreamHandler(sessionManager)
    handler(ws, {})
    const onMessage = ws.on.mock.calls.find(([event]) => event === 'message')[1]
    expect(() => onMessage('not json {')).not.toThrow()
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'error', sessionId: null, data: 'invalid frame' }))
  })

  it('sends an error frame for a frame with a non-string data field instead of throwing', async () => {
    const { spawnFn } = fakePtyFactory()
    const sessionManager = createSessionManager(spawnFn, FAKE_STAT)
    await sessionManager.getOrCreate('s1', '/app/workspace/proj')
    const ws = fakeWs()
    const handler = createSessionStreamHandler(sessionManager)
    handler(ws, {})
    const onMessage = ws.on.mock.calls.find(([event]) => event === 'message')[1]
    expect(() => onMessage(JSON.stringify({ type: 'input', sessionId: 's1', data: 42 }))).not.toThrow()
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'error', sessionId: 's1', data: 'invalid frame' }))
  })

  it('resizes the matching session PTY on a resize frame', async () => {
    const { spawnFn } = fakePtyFactory()
    const sessionManager = createSessionManager(spawnFn, FAKE_STAT)
    const session = await sessionManager.getOrCreate('s1', '/app/workspace/proj')
    const ws = fakeWs()
    const handler = createSessionStreamHandler(sessionManager)
    handler(ws, {})
    const onMessage = ws.on.mock.calls.find(([event]) => event === 'message')[1]
    onMessage(JSON.stringify({ type: 'resize', sessionId: 's1', cols: 100, rows: 30 }))
    expect(session.pty.resize).toHaveBeenCalledWith(100, 30)
  })

  it('sends an error frame for a resize frame with non-integer cols/rows instead of throwing', async () => {
    const { spawnFn } = fakePtyFactory()
    const sessionManager = createSessionManager(spawnFn, FAKE_STAT)
    await sessionManager.getOrCreate('s1', '/app/workspace/proj')
    const ws = fakeWs()
    const handler = createSessionStreamHandler(sessionManager)
    handler(ws, {})
    const onMessage = ws.on.mock.calls.find(([event]) => event === 'message')[1]
    expect(() => onMessage(JSON.stringify({ type: 'resize', sessionId: 's1', cols: 'wide', rows: 30 }))).not.toThrow()
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'error', sessionId: 's1', data: 'invalid frame' }))
  })

  it('sends an error frame for a resize frame targeting an unknown sessionId', () => {
    const sessionManager = createSessionManager(vi.fn())
    const ws = fakeWs()
    const handler = createSessionStreamHandler(sessionManager)
    handler(ws, {})
    const onMessage = ws.on.mock.calls.find(([event]) => event === 'message')[1]
    onMessage(JSON.stringify({ type: 'resize', sessionId: 'missing', cols: 100, rows: 30 }))
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'error', sessionId: 'missing', data: 'unknown session' }))
  })

  it('disposes all subscribed PTY data listeners when the socket closes', async () => {
    const { spawnFn, lastDisposeSpy } = fakePtyFactory()
    const sessionManager = createSessionManager(spawnFn, FAKE_STAT)
    await sessionManager.getOrCreate('s1', '/app/workspace/proj')
    const ws = fakeWs()
    const handler = createSessionStreamHandler(sessionManager)
    handler(ws, {})
    const onMessage = ws.on.mock.calls.find(([event]) => event === 'message')[1]
    onMessage(JSON.stringify({ type: 'input', sessionId: 's1', data: 'x' }))
    const wsListenerDisposeSpy = lastDisposeSpy()
    const onClose = ws.on.mock.calls.find(([event]) => event === 'close')[1]
    onClose()
    expect(wsListenerDisposeSpy).toHaveBeenCalledTimes(1)
  })
})
