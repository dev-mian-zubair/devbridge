import path from 'node:path'

export { SessionConflictError, InvalidProjectPathError } from './sessionErrors.js'
import { SessionConflictError, InvalidProjectPathError } from './sessionErrors.js'

function spawnEnv() {
  const { ANTHROPIC_API_KEY, ...rest } = process.env
  return rest
}

// node-pty.write()ing a freshly-spawned claude CLI races its own startup:
// until the CLI finishes initializing and puts the PTY into raw mode, an
// early write (including the Enter keypress) can be swallowed by the
// kernel's line-discipline echo instead of being read as real input once
// the CLI's own input handler comes up — reproduced live against a real
// authenticated session (writing immediately: the request hung the full
// 120s; writing after the CLI signals readiness: it replied in ~3s).
// Entering the alternate screen buffer (`CSI ? 1049 h`) is the one escape
// sequence the CLI only emits once its full-screen UI has actually
// initialized, so readiness is "that sequence appeared, then output went
// quiet for a short settle window" (the initial screen is still painting
// for a few more chunks after entering the alt screen).
const READY_MARKER = '\u001b[?1049h'

function waitForReadiness(pty, { timeoutMs, settleMs }) {
  return new Promise((resolve) => {
    let disposable
    let settleTimer = null
    let timeoutTimer = null

    const finish = () => {
      clearTimeout(settleTimer)
      clearTimeout(timeoutTimer)
      disposable?.dispose?.()
      resolve()
    }

    timeoutTimer = setTimeout(finish, timeoutMs)
    disposable = pty.onData((chunk) => {
      if (chunk.includes(READY_MARKER)) {
        clearTimeout(settleTimer)
        settleTimer = setTimeout(finish, settleMs)
      }
    })
  })
}

export function createSessionManager(spawnFn, { readinessTimeoutMs = 50, readinessSettleMs = 10 } = {}) {
  const sessions = new Map()

  return {
    async getOrCreate(sessionId, projectPath) {
      const existing = sessions.get(sessionId)
      if (existing) {
        if (existing.projectPath !== projectPath) {
          throw new SessionConflictError(sessionId, existing.projectPath, projectPath)
        }
        return existing
      }

      if (typeof projectPath !== 'string' || projectPath.length === 0 || !path.isAbsolute(projectPath)) {
        throw new InvalidProjectPathError(projectPath)
      }

      const pty = spawnFn('claude', [], {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: projectPath,
        env: spawnEnv(),
      })
      const session = { sessionId, projectPath, pty }
      sessions.set(sessionId, session)
      pty.onExit(() => {
        if (sessions.get(sessionId) === session) {
          sessions.delete(sessionId)
        }
      })

      await waitForReadiness(pty, { timeoutMs: readinessTimeoutMs, settleMs: readinessSettleMs })
      return session
    },
    get(sessionId) {
      return sessions.get(sessionId)
    },
  }
}
