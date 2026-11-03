import { describe, it, expect, vi, afterEach } from 'vitest'
import os from 'node:os'
import { createLoginSession } from '../src/loginSession.js'

function fakePty() {
  const dataHandlers = []
  const exitHandlers = []
  return {
    write: vi.fn(),
    kill: vi.fn(),
    onData(cb) { dataHandlers.push(cb); return { dispose: vi.fn() } },
    onExit(cb) { exitHandlers.push(cb) },
    emitData(chunk) { for (const cb of dataHandlers) cb(chunk) },
    emitExit() { for (const cb of exitHandlers) cb() },
  }
}

function fakeSpawnFactory() {
  const ptys = []
  const spawnFn = vi.fn(() => {
    const pty = fakePty()
    ptys.push(pty)
    return pty
  })
  return { spawnFn, ptys }
}

// A fixed path (not a real mkdtemp call) keeps tests deterministic and
// free of real filesystem side effects, and lets two separately-created
// sessions in the same test agree on "the same directory" where needed.
// readFileSync/writeFileSync share one in-memory store so a later read
// sees an earlier write — real enough to test ensureCwdTrusted and
// removeCwdTrust acting on the same backing "file" in sequence.
function fakeFsFactory({ loginCwd = '/tmp/devbridge-login-test', initialConfig = { projects: {} } } = {}) {
  let stored = JSON.stringify(initialConfig)
  return {
    mkdtempSync: vi.fn(() => loginCwd),
    chmodSync: vi.fn(),
    rmSync: vi.fn(),
    readFileSync: vi.fn(() => stored),
    writeFileSync: vi.fn((_path, content) => { stored = content }),
  }
}

// start() resolves once the PTY signals readiness (the alt-screen marker)
// and a short settle window passes — drive both, then hand back the PTY
// that was just spawned for the test to inspect/drive further.
async function startAndSignalReady(session, ptys, onOutput = vi.fn()) {
  const startPromise = session.start(onOutput)
  const pty = ptys[ptys.length - 1]
  pty.emitData('\u001b[?1049h')
  await vi.advanceTimersByTimeAsync(50)
  await startPromise
  return pty
}

describe('createLoginSession', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('spawns the CLI and types /login once the PTY signals readiness', async () => {
    vi.useFakeTimers()
    const { spawnFn, ptys } = fakeSpawnFactory()
    const session = createLoginSession(spawnFn, { readinessTimeoutMs: 1000, readinessSettleMs: 10, ...fakeFsFactory() })
    const pty = await startAndSignalReady(session, ptys)
    expect(spawnFn).toHaveBeenCalledTimes(1)
    expect(pty.write).toHaveBeenCalledWith('/login\r')
  })

  it('spawns outside any real project directory (never the server process\'s own cwd)', async () => {
    vi.useFakeTimers()
    const { spawnFn, ptys } = fakeSpawnFactory()
    const session = createLoginSession(spawnFn, { readinessTimeoutMs: 1000, readinessSettleMs: 10, ...fakeFsFactory() })
    await startAndSignalReady(session, ptys)
    const [, , options] = spawnFn.mock.calls[0]
    expect(options.cwd).not.toBe(process.cwd())
  })

  describe('private login directory (never the shared, world-writable os.tmpdir())', () => {
    it('spawns in a freshly created directory under os.tmpdir(), not os.tmpdir() itself', async () => {
      vi.useFakeTimers()
      const { spawnFn, ptys } = fakeSpawnFactory()
      const fakeFs = fakeFsFactory()
      const session = createLoginSession(spawnFn, { readinessTimeoutMs: 1000, readinessSettleMs: 10, ...fakeFs })
      await startAndSignalReady(session, ptys)

      const [, , options] = spawnFn.mock.calls[0]
      expect(options.cwd).not.toBe(os.tmpdir())
      expect(fakeFs.mkdtempSync).toHaveBeenCalledTimes(1)
      expect(fakeFs.mkdtempSync.mock.calls[0][0]).toContain(os.tmpdir())
      expect(options.cwd).toBe(fakeFs.mkdtempSync.mock.results[0].value)
    })

    it('locks the login directory down to 0700', async () => {
      vi.useFakeTimers()
      const { spawnFn, ptys } = fakeSpawnFactory()
      const fakeFs = fakeFsFactory()
      const session = createLoginSession(spawnFn, { readinessTimeoutMs: 1000, readinessSettleMs: 10, ...fakeFs })
      await startAndSignalReady(session, ptys)
      expect(fakeFs.chmodSync).toHaveBeenCalledWith(fakeFs.mkdtempSync.mock.results[0].value, 0o700)
    })

    it('removes the login directory and its trust entry on dispose()', async () => {
      vi.useFakeTimers()
      const { spawnFn, ptys } = fakeSpawnFactory()
      const fakeFs = fakeFsFactory()
      const session = createLoginSession(spawnFn, {
        readinessTimeoutMs: 1000, readinessSettleMs: 10, claudeConfigDir: '/data/.claude', ...fakeFs,
      })
      await startAndSignalReady(session, ptys)
      const loginCwd = fakeFs.mkdtempSync.mock.results[0].value

      session.dispose()
      expect(fakeFs.rmSync).toHaveBeenCalledWith(loginCwd, { recursive: true, force: true })
      const lastWrite = fakeFs.writeFileSync.mock.calls.at(-1)
      expect(JSON.parse(lastWrite[1]).projects[loginCwd]).toBeUndefined()
    })

    it('removes the login directory and its trust entry when the PTY exits on its own', async () => {
      vi.useFakeTimers()
      const { spawnFn, ptys } = fakeSpawnFactory()
      const fakeFs = fakeFsFactory()
      const session = createLoginSession(spawnFn, {
        readinessTimeoutMs: 1000, readinessSettleMs: 10, claudeConfigDir: '/data/.claude', ...fakeFs,
      })
      const pty = await startAndSignalReady(session, ptys)
      const loginCwd = fakeFs.mkdtempSync.mock.results[0].value

      pty.emitExit()
      expect(fakeFs.rmSync).toHaveBeenCalledWith(loginCwd, { recursive: true, force: true })
      const lastWrite = fakeFs.writeFileSync.mock.calls.at(-1)
      expect(JSON.parse(lastWrite[1]).projects[loginCwd]).toBeUndefined()
    })
  })

  describe('pre-trusting the login cwd (skips the interactive workspace-trust dialog)', () => {
    // --dangerously-skip-permissions can't be used: the CLI refuses it
    // outright when running as root, which this container always does.
    // Pre-registering the login cwd as already-trusted in .claude.json
    // (the same field the CLI itself writes when a human accepts the
    // dialog) has the same effect without that restriction.
    it('marks the login cwd trusted in .claude.json before spawning', async () => {
      vi.useFakeTimers()
      const { spawnFn, ptys } = fakeSpawnFactory()
      const fakeFs = fakeFsFactory()
      const session = createLoginSession(spawnFn, {
        readinessTimeoutMs: 1000, readinessSettleMs: 10, claudeConfigDir: '/data/.claude', ...fakeFs,
      })
      await startAndSignalReady(session, ptys)

      const loginCwd = fakeFs.mkdtempSync.mock.results[0].value
      expect(fakeFs.writeFileSync).toHaveBeenCalledTimes(1)
      const [writtenPath, writtenContent] = fakeFs.writeFileSync.mock.calls[0]
      expect(writtenPath).toBe('/data/.claude/.claude.json')
      expect(JSON.parse(writtenContent).projects[loginCwd].hasTrustDialogAccepted).toBe(true)
    })

    it('does not rewrite the config when the login cwd is already trusted', async () => {
      vi.useFakeTimers()
      const { spawnFn, ptys } = fakeSpawnFactory()
      const loginCwd = '/tmp/devbridge-login-shared'
      const fakeFs = fakeFsFactory({ loginCwd, initialConfig: { projects: { [loginCwd]: { hasTrustDialogAccepted: true } } } })
      const session = createLoginSession(spawnFn, {
        readinessTimeoutMs: 1000, readinessSettleMs: 10, claudeConfigDir: '/data/.claude', ...fakeFs,
      })
      await startAndSignalReady(session, ptys)
      expect(fakeFs.writeFileSync).not.toHaveBeenCalled()
    })

    it('still spawns when the config file does not exist yet (a container that has never logged in)', async () => {
      vi.useFakeTimers()
      const { spawnFn, ptys } = fakeSpawnFactory()
      const fakeFs = fakeFsFactory()
      fakeFs.readFileSync = vi.fn(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) })
      const session = createLoginSession(spawnFn, {
        readinessTimeoutMs: 1000, readinessSettleMs: 10, claudeConfigDir: '/data/.claude', ...fakeFs,
      })
      await expect(startAndSignalReady(session, ptys)).resolves.toBeTruthy()
      expect(fakeFs.writeFileSync).not.toHaveBeenCalled()
    })

    it('still spawns without touching .claude.json when claudeConfigDir is not given', async () => {
      vi.useFakeTimers()
      const { spawnFn, ptys } = fakeSpawnFactory()
      const fakeFs = fakeFsFactory()
      const session = createLoginSession(spawnFn, { readinessTimeoutMs: 1000, readinessSettleMs: 10, ...fakeFs })
      await startAndSignalReady(session, ptys)
      expect(fakeFs.readFileSync).not.toHaveBeenCalled()
      expect(fakeFs.writeFileSync).not.toHaveBeenCalled()
      expect(spawnFn).toHaveBeenCalledTimes(1)
    })
  })

  it('forwards PTY output to the subscribed listener', async () => {
    vi.useFakeTimers()
    const { spawnFn, ptys } = fakeSpawnFactory()
    const session = createLoginSession(spawnFn, { readinessTimeoutMs: 1000, readinessSettleMs: 10, ...fakeFsFactory() })
    const onOutput = vi.fn()
    const pty = await startAndSignalReady(session, ptys, onOutput)
    pty.emitData('visit https://example.com code ABC123')
    expect(onOutput).toHaveBeenCalledWith('visit https://example.com code ABC123')
  })

  it('reuses the same PTY on a second start() call instead of spawning again', async () => {
    vi.useFakeTimers()
    const { spawnFn, ptys } = fakeSpawnFactory()
    const session = createLoginSession(spawnFn, { readinessTimeoutMs: 1000, readinessSettleMs: 10, ...fakeFsFactory() })
    await startAndSignalReady(session, ptys)
    await session.start(vi.fn())
    expect(spawnFn).toHaveBeenCalledTimes(1)
  })

  it('a second start() call also subscribes its listener to the existing PTY', async () => {
    vi.useFakeTimers()
    const { spawnFn, ptys } = fakeSpawnFactory()
    const session = createLoginSession(spawnFn, { readinessTimeoutMs: 1000, readinessSettleMs: 10, ...fakeFsFactory() })
    const first = vi.fn()
    const pty = await startAndSignalReady(session, ptys, first)
    const second = vi.fn()
    await session.start(second)
    pty.emitData('more output')
    expect(first).toHaveBeenCalledWith('more output')
    expect(second).toHaveBeenCalledWith('more output')
  })

  it('input() writes to the active PTY', async () => {
    vi.useFakeTimers()
    const { spawnFn, ptys } = fakeSpawnFactory()
    const session = createLoginSession(spawnFn, { readinessTimeoutMs: 1000, readinessSettleMs: 10, ...fakeFsFactory() })
    const pty = await startAndSignalReady(session, ptys)
    session.input('pasted-code\r')
    expect(pty.write).toHaveBeenCalledWith('pasted-code\r')
  })

  it('input() is a no-op when there is no active session', () => {
    const session = createLoginSession(vi.fn())
    expect(() => session.input('x')).not.toThrow()
  })

  it('dispose() kills the active PTY and allows a fresh start() to spawn a new one', async () => {
    vi.useFakeTimers()
    const { spawnFn, ptys } = fakeSpawnFactory()
    const session = createLoginSession(spawnFn, { readinessTimeoutMs: 1000, readinessSettleMs: 10, ...fakeFsFactory() })
    const pty = await startAndSignalReady(session, ptys)
    session.dispose()
    expect(pty.kill).toHaveBeenCalledTimes(1)
    expect(session.isActive()).toBe(false)

    await startAndSignalReady(session, ptys)
    expect(spawnFn).toHaveBeenCalledTimes(2)
  })

  it('isActive() reflects whether a login session is currently running', async () => {
    vi.useFakeTimers()
    const { spawnFn, ptys } = fakeSpawnFactory()
    const session = createLoginSession(spawnFn, { readinessTimeoutMs: 1000, readinessSettleMs: 10, ...fakeFsFactory() })
    expect(session.isActive()).toBe(false)
    await startAndSignalReady(session, ptys)
    expect(session.isActive()).toBe(true)
  })

  it('disposes itself automatically once the GC timeout elapses', async () => {
    vi.useFakeTimers()
    const { spawnFn, ptys } = fakeSpawnFactory()
    const session = createLoginSession(spawnFn, { readinessTimeoutMs: 1000, readinessSettleMs: 10, gcTimeoutMs: 1000, ...fakeFsFactory() })
    const pty = await startAndSignalReady(session, ptys)
    expect(session.isActive()).toBe(true)
    await vi.advanceTimersByTimeAsync(1001)
    expect(session.isActive()).toBe(false)
    expect(pty.kill).toHaveBeenCalledTimes(1)
  })

  it('clears the GC timer when the PTY exits on its own', async () => {
    vi.useFakeTimers()
    const { spawnFn, ptys } = fakeSpawnFactory()
    const session = createLoginSession(spawnFn, { readinessTimeoutMs: 1000, readinessSettleMs: 10, gcTimeoutMs: 1000, ...fakeFsFactory() })
    const pty = await startAndSignalReady(session, ptys)
    pty.emitExit()
    expect(session.isActive()).toBe(false)
    // No second kill() from the GC timer firing after the process already exited on its own.
    await vi.advanceTimersByTimeAsync(1001)
    expect(pty.kill).not.toHaveBeenCalled()
  })
})
