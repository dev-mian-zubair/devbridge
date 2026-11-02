import { describe, it, expect, vi } from 'vitest'
import { createSessionManager, SessionConflictError, InvalidProjectPathError } from '../src/sessionManager.js'

// projectPath in these tests is a fixture string, not a real directory on
// this test host (unlike inside the container), so the real fs.statSync
// default is swapped for one that treats any path as valid.
const FAKE_STAT = { statFn: () => ({ isDirectory: () => true }) }

function fakePty() {
  let exitHandler
  let dataHandler
  return {
    onData: vi.fn((cb) => { dataHandler = cb; return { dispose: vi.fn() } }),
    write: vi.fn(),
    kill: vi.fn(),
    onExit: (cb) => { exitHandler = cb },
    triggerExit: () => exitHandler?.(),
    emit: (chunk) => dataHandler?.(chunk),
  }
}

describe('createSessionManager', () => {
  it('spawns a new PTY with the required settings on first use', async () => {
    const spawnFn = vi.fn(() => fakePty())
    const manager = createSessionManager(spawnFn, FAKE_STAT)
    await manager.getOrCreate('s1', '/app/workspace/proj')
    expect(spawnFn).toHaveBeenCalledWith('claude', [], expect.objectContaining({
      name: 'xterm-256color', cols: 120, rows: 40, cwd: '/app/workspace/proj',
    }))
  })

  it('reuses the existing session when projectPath matches', async () => {
    const spawnFn = vi.fn(() => fakePty())
    const manager = createSessionManager(spawnFn, FAKE_STAT)
    const first = await manager.getOrCreate('s1', '/app/workspace/proj')
    const second = await manager.getOrCreate('s1', '/app/workspace/proj')
    expect(second).toBe(first)
    expect(spawnFn).toHaveBeenCalledTimes(1)
  })

  it('throws SessionConflictError when projectPath differs for an existing sessionId', async () => {
    const spawnFn = vi.fn(() => fakePty())
    const manager = createSessionManager(spawnFn, FAKE_STAT)
    await manager.getOrCreate('s1', '/app/workspace/proj-a')
    await expect(manager.getOrCreate('s1', '/app/workspace/proj-b')).rejects.toThrow(SessionConflictError)
  })

  it('get returns undefined for an unknown sessionId', () => {
    const manager = createSessionManager(vi.fn())
    expect(manager.get('missing')).toBeUndefined()
  })

  it('throws InvalidProjectPathError instead of spawning when projectPath is missing or relative', async () => {
    const spawnFn = vi.fn(() => fakePty())
    const manager = createSessionManager(spawnFn)
    await expect(manager.getOrCreate('s1', undefined)).rejects.toThrow(InvalidProjectPathError)
    await expect(manager.getOrCreate('s2', 'relative/path')).rejects.toThrow(InvalidProjectPathError)
    expect(spawnFn).not.toHaveBeenCalled()
  })

  it('throws InvalidProjectPathError for a projectPath that does not exist on disk', async () => {
    const spawnFn = vi.fn(() => fakePty())
    const statFn = () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }
    const manager = createSessionManager(spawnFn, { statFn })
    await expect(manager.getOrCreate('s1', '/app/workspace/does-not-exist')).rejects.toThrow(InvalidProjectPathError)
    expect(spawnFn).not.toHaveBeenCalled()
  })

  it('does not forward ANTHROPIC_API_KEY from process.env into the spawned PTY', async () => {
    const original = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'sk-test-leak'
    try {
      const spawnFn = vi.fn(() => fakePty())
      const manager = createSessionManager(spawnFn, FAKE_STAT)
      await manager.getOrCreate('s1', '/app/workspace/proj')
      const [, , options] = spawnFn.mock.calls[0]
      expect(options.env.ANTHROPIC_API_KEY).toBeUndefined()
    } finally {
      if (original === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = original
    }
  })

  it('removes the session from the registry once its PTY exits', async () => {
    const pty = fakePty()
    const spawnFn = vi.fn(() => pty)
    const manager = createSessionManager(spawnFn, FAKE_STAT)
    await manager.getOrCreate('s1', '/app/workspace/proj')
    expect(manager.get('s1')).toBeDefined()
    pty.triggerExit()
    expect(manager.get('s1')).toBeUndefined()
  })

  it('waits for the alt-screen-buffer marker (plus a settle window) before resolving a new session', async () => {
    const pty = fakePty()
    const spawnFn = vi.fn(() => pty)
    const manager = createSessionManager(spawnFn, { ...FAKE_STAT, readinessTimeoutMs: 5000, readinessSettleMs: 20 })
    let resolved = false
    const promise = manager.getOrCreate('s1', '/app/workspace/proj').then(() => { resolved = true })

    await new Promise((r) => setTimeout(r, 10))
    expect(resolved).toBe(false)

    pty.emit('some startup noise\r\n\u001b[?1049h\u001b[2J more screen painting')
    await promise
    expect(resolved).toBe(true)
  })

  it('falls back to resolving after readinessTimeoutMs if the marker never appears', async () => {
    const spawnFn = vi.fn(() => fakePty())
    const manager = createSessionManager(spawnFn, { ...FAKE_STAT, readinessTimeoutMs: 30, readinessSettleMs: 1000 })
    const start = Date.now()
    await manager.getOrCreate('s1', '/app/workspace/proj')
    expect(Date.now() - start).toBeLessThan(1000)
  })
})
