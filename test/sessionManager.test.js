import { describe, it, expect, vi } from 'vitest'
import { createSessionManager, SessionConflictError, InvalidProjectPathError } from '../src/sessionManager.js'

function fakePty() {
  let exitHandler
  return {
    onData: vi.fn(),
    write: vi.fn(),
    kill: vi.fn(),
    onExit: (cb) => { exitHandler = cb },
    triggerExit: () => exitHandler?.(),
  }
}

describe('createSessionManager', () => {
  it('spawns a new PTY with the required settings on first use', () => {
    const spawnFn = vi.fn(() => fakePty())
    const manager = createSessionManager(spawnFn)
    manager.getOrCreate('s1', '/app/workspace/proj')
    expect(spawnFn).toHaveBeenCalledWith('claude', [], expect.objectContaining({
      name: 'xterm-256color', cols: 120, rows: 40, cwd: '/app/workspace/proj',
    }))
  })

  it('reuses the existing session when projectPath matches', () => {
    const spawnFn = vi.fn(() => fakePty())
    const manager = createSessionManager(spawnFn)
    const first = manager.getOrCreate('s1', '/app/workspace/proj')
    const second = manager.getOrCreate('s1', '/app/workspace/proj')
    expect(second).toBe(first)
    expect(spawnFn).toHaveBeenCalledTimes(1)
  })

  it('throws SessionConflictError when projectPath differs for an existing sessionId', () => {
    const spawnFn = vi.fn(() => fakePty())
    const manager = createSessionManager(spawnFn)
    manager.getOrCreate('s1', '/app/workspace/proj-a')
    expect(() => manager.getOrCreate('s1', '/app/workspace/proj-b')).toThrow(SessionConflictError)
  })

  it('get returns undefined for an unknown sessionId', () => {
    const manager = createSessionManager(vi.fn())
    expect(manager.get('missing')).toBeUndefined()
  })

  it('throws InvalidProjectPathError instead of spawning when projectPath is missing or relative', () => {
    const spawnFn = vi.fn(() => fakePty())
    const manager = createSessionManager(spawnFn)
    expect(() => manager.getOrCreate('s1', undefined)).toThrow(InvalidProjectPathError)
    expect(() => manager.getOrCreate('s2', 'relative/path')).toThrow(InvalidProjectPathError)
    expect(spawnFn).not.toHaveBeenCalled()
  })

  it('does not forward ANTHROPIC_API_KEY from process.env into the spawned PTY', () => {
    const original = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'sk-test-leak'
    try {
      const spawnFn = vi.fn(() => fakePty())
      const manager = createSessionManager(spawnFn)
      manager.getOrCreate('s1', '/app/workspace/proj')
      const [, , options] = spawnFn.mock.calls[0]
      expect(options.env.ANTHROPIC_API_KEY).toBeUndefined()
    } finally {
      if (original === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = original
    }
  })

  it('removes the session from the registry once its PTY exits', () => {
    const pty = fakePty()
    const spawnFn = vi.fn(() => pty)
    const manager = createSessionManager(spawnFn)
    manager.getOrCreate('s1', '/app/workspace/proj')
    expect(manager.get('s1')).toBeDefined()
    pty.triggerExit()
    expect(manager.get('s1')).toBeUndefined()
  })
})
