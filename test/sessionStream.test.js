import { describe, it, expect, vi } from 'vitest'
import { createSessionStreamHandler } from '../src/ws/sessionStream.js'
import { createSessionManager } from '../src/sessionManager.js'

function fakeWs() { return { send: vi.fn(), on: vi.fn() } }

describe('createSessionStreamHandler', () => {
  it('writes inbound input data to the matching session PTY', () => {
    let dataCb
    const spawnFn = vi.fn(() => ({ write: vi.fn(), onData: (cb) => { dataCb = cb }, kill: vi.fn() }))
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
    let dataCb
    const spawnFn = vi.fn(() => ({ write: vi.fn(), onData: (cb) => { dataCb = cb }, kill: vi.fn() }))
    const sessionManager = createSessionManager(spawnFn)
    sessionManager.getOrCreate('s1', '/app/workspace/proj')
    const ws = fakeWs()
    const handler = createSessionStreamHandler(sessionManager)
    handler(ws, {})
    const onMessage = ws.on.mock.calls.find(([event]) => event === 'message')[1]
    onMessage(JSON.stringify({ type: 'input', sessionId: 's1', data: 'x' }))
    dataCb('some terminal output')
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
})
