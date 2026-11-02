import { describe, it, expect, vi } from 'vitest'
import { createSessionManager, SessionConflictError } from '../src/sessionManager.js'

function fakePty() { return { onData: vi.fn(), write: vi.fn(), kill: vi.fn() } }

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
})
