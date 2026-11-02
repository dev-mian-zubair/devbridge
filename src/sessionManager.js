export class SessionConflictError extends Error {
  constructor(sessionId, existingProjectPath, requestedProjectPath) {
    super(
      `Session "${sessionId}" is bound to "${existingProjectPath}", but was requested with "${requestedProjectPath}"`
    )
    this.name = 'SessionConflictError'
    this.sessionId = sessionId
    this.existingProjectPath = existingProjectPath
    this.requestedProjectPath = requestedProjectPath
  }
}

export function createSessionManager(spawnFn) {
  const sessions = new Map()

  return {
    getOrCreate(sessionId, projectPath) {
      const existing = sessions.get(sessionId)
      if (existing) {
        if (existing.projectPath !== projectPath) {
          throw new SessionConflictError(sessionId, existing.projectPath, projectPath)
        }
        return existing
      }

      const pty = spawnFn('claude', [], {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: projectPath,
        env: process.env,
      })
      const session = { sessionId, projectPath, pty }
      sessions.set(sessionId, session)
      return session
    },
    get(sessionId) {
      return sessions.get(sessionId)
    },
  }
}
