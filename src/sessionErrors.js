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
