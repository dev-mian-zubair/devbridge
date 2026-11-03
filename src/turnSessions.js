import path from 'node:path'
import fs from 'node:fs'
import { SessionConflictError, InvalidProjectPathError } from './sessionErrors.js'
import { createTurnEvents } from './turnEvents.js'

export { SessionConflictError, InvalidProjectPathError }

// Unlike the PTY-backed login session, a turn session has no live process
// to keep around between requests: each turn is one `claude -p` invocation,
// and continuity across turns comes from the CLI's own --resume, keyed on
// the claudeSessionId it hands back. This store remembers that mapping,
// which projectPath a given API sessionId is bound to, and enough of each
// session's recent activity (status, last request, last result/error) for
// the dashboard's observability view — publishing a session:update event
// through `events` on every mutation so WS subscribers stay in sync.
export function createTurnSessions(statFn = fs.statSync, events = createTurnEvents()) {
  const sessions = new Map()

  function publishUpdate(session) {
    events.publish({ type: 'session:update', session })
  }

  return {
    get(sessionId) {
      return sessions.get(sessionId)
    },
    list() {
      return [...sessions.values()]
    },
    ensure(sessionId, projectPath) {
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

      // A path that doesn't exist (or isn't a directory) would otherwise
      // surface as an opaque spawn ENOENT, indistinguishable from the
      // `claude` binary itself being missing.
      let stat
      try {
        stat = statFn(projectPath)
      } catch {
        throw new InvalidProjectPathError(projectPath)
      }
      if (!stat.isDirectory()) {
        throw new InvalidProjectPathError(projectPath)
      }

      const session = {
        sessionId,
        projectPath,
        claudeSessionId: null,
        status: 'idle',
        lastRequest: null,
        lastResult: null,
        lastError: null,
        updatedAt: Date.now(),
      }
      sessions.set(sessionId, session)
      publishUpdate(session)
      return session
    },
    setClaudeSessionId(sessionId, claudeSessionId) {
      const session = sessions.get(sessionId)
      if (!session) return
      session.claudeSessionId = claudeSessionId
      session.updatedAt = Date.now()
      publishUpdate(session)
    },
    recordRequestStart(sessionId, requestSummary) {
      const session = sessions.get(sessionId)
      if (!session) return
      session.status = 'running'
      session.lastRequest = requestSummary
      session.updatedAt = Date.now()
      publishUpdate(session)
    },
    recordResult(sessionId, result) {
      const session = sessions.get(sessionId)
      if (!session) return
      session.status = 'idle'
      session.lastResult = result
      session.lastError = null
      session.updatedAt = Date.now()
      publishUpdate(session)
    },
    recordError(sessionId, error) {
      const session = sessions.get(sessionId)
      if (!session) return
      session.status = 'error'
      session.lastError = error
      session.updatedAt = Date.now()
      publishUpdate(session)
    },
  }
}
