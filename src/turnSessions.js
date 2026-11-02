import path from 'node:path'
import fs from 'node:fs'
import { SessionConflictError, InvalidProjectPathError } from './sessionErrors.js'

export { SessionConflictError, InvalidProjectPathError }

// Unlike the PTY-backed sessionManager, a turn session has no live process
// to keep around between requests: each turn is one `claude -p` invocation,
// and continuity across turns comes from the CLI's own --resume, keyed on
// the claudeSessionId it hands back. This store only remembers that mapping
// and which projectPath a given API sessionId is bound to.
export function createTurnSessions(statFn = fs.statSync) {
  const sessions = new Map()

  return {
    get(sessionId) {
      return sessions.get(sessionId)
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

      const session = { sessionId, projectPath, claudeSessionId: null }
      sessions.set(sessionId, session)
      return session
    },
    setClaudeSessionId(sessionId, claudeSessionId) {
      const session = sessions.get(sessionId)
      if (session) session.claudeSessionId = claudeSessionId
    },
  }
}
