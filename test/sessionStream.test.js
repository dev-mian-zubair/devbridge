import { describe, it, expect, vi } from 'vitest'
import { createSessionStreamHandler } from '../src/ws/sessionStream.js'
import { createSessionManager } from '../src/sessionManager.js'

function fakeWs() { return { send: vi.fn(), on: vi.fn() } }

function fakePtyFactory(disposeSpy) {
  let dataCb
  return {
    spawnFn: vi.fn(() => ({
      write: vi.fn(),
      onData: (cb) => { dataCb = cb; return { dispose: disposeSpy } },
      onExit: vi.fn(),
      kill: vi.fn(),
    })),
    trigger: (chunk) => dataCb(chunk),
  }
}

describe('createSessionStreamHandler', () => {
  it('writes inbound input data to the matching session PTY', () => {
    const { spawnFn } = fakePtyFactory(vi.fn())
    const sessionManager = createSessionManager(spawnFn)
    const session = sessionManager.getOrCreate('s1', '/app/workspace/proj')
    const ws = fakeWs()
    const handler = createSessionStreamHandler(sessionManager)
    handler(ws, {})
    const onMessage = ws.on.mock.calls.find(([event]) => event === 'message')[1]
    onMessage(JSON.stringify({ type: 'input', sessionId: 's1', data: '/login\n' }))
    expect(session.pty.write).toHaveBeenCalledWith('/login\n')
  })

  it('forwards PTY output as an outbound output frame', () => {
    const { spawnFn, trigger } = fakePtyFactory(vi.fn())
    const sessionManager = createSessionManager(spawnFn)
    sessionManager.getOrCreate('s1', '/app/workspace/proj')
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

  it('sends an error frame for a frame with a non-string data field instead of throwing', () => {
    const { spawnFn } = fakePtyFactory(vi.fn())
    const sessionManager = createSessionManager(spawnFn)
    sessionManager.getOrCreate('s1', '/app/workspace/proj')
    const ws = fakeWs()
    const handler = createSessionStreamHandler(sessionManager)
    handler(ws, {})
    const onMessage = ws.on.mock.calls.find(([event]) => event === 'message')[1]
    expect(() => onMessage(JSON.stringify({ type: 'input', sessionId: 's1', data: 42 }))).not.toThrow()
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'error', sessionId: 's1', data: 'invalid frame' }))
  })

  it('disposes all subscribed PTY data listeners when the socket closes', () => {
    const disposeSpy = vi.fn()
    const { spawnFn } = fakePtyFactory(disposeSpy)
    const sessionManager = createSessionManager(spawnFn)
    sessionManager.getOrCreate('s1', '/app/workspace/proj')
    const ws = fakeWs()
    const handler = createSessionStreamHandler(sessionManager)
    handler(ws, {})
    const onMessage = ws.on.mock.calls.find(([event]) => event === 'message')[1]
    onMessage(JSON.stringify({ type: 'input', sessionId: 's1', data: 'x' }))
    const onClose = ws.on.mock.calls.find(([event]) => event === 'close')[1]
    onClose()
    expect(disposeSpy).toHaveBeenCalledTimes(1)
  })
})
