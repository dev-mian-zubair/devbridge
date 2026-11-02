import path from 'node:path'

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

export class InvalidProjectPathError extends Error {
  constructor(projectPath) {
    super(`projectPath must be a non-empty absolute path, got ${JSON.stringify(projectPath)}`)
    this.name = 'InvalidProjectPathError'
    this.projectPath = projectPath
  }
}

function spawnEnv() {
  const { ANTHROPIC_API_KEY, ...rest } = process.env
  return rest
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
      return session
    },
    get(sessionId) {
      return sessions.get(sessionId)
    },
  }
}
