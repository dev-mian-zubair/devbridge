import { describe, it, expect } from 'vitest'
import { createTurnSessions, SessionConflictError, InvalidProjectPathError } from '../src/turnSessions.js'

function fakeStatFn(isDirectory = true) {
  return () => ({ isDirectory: () => isDirectory })
}

describe('createTurnSessions', () => {
  it('returns undefined for a sessionId that has never been seen', () => {
    const sessions = createTurnSessions(fakeStatFn())
    expect(sessions.get('unknown')).toBeUndefined()
  })

  it('ensure() creates a new session record with no claudeSessionId yet', () => {
    const sessions = createTurnSessions(fakeStatFn())
    const session = sessions.ensure('s1', '/app/workspace/proj')
    expect(session).toEqual({ sessionId: 's1', projectPath: '/app/workspace/proj', claudeSessionId: null })
  })

  it('ensure() returns the same record on a later call with the same projectPath', () => {
    const sessions = createTurnSessions(fakeStatFn())
    sessions.ensure('s1', '/app/workspace/proj')
    sessions.setClaudeSessionId('s1', 'claude-uuid-1')
    const session = sessions.ensure('s1', '/app/workspace/proj')
    expect(session.claudeSessionId).toBe('claude-uuid-1')
  })

  it('ensure() throws SessionConflictError when the same sessionId is reused with a different projectPath', () => {
    const sessions = createTurnSessions(fakeStatFn())
    sessions.ensure('s1', '/a')
    expect(() => sessions.ensure('s1', '/b')).toThrow(SessionConflictError)
  })

  it('ensure() throws InvalidProjectPathError for a relative or missing projectPath', () => {
    const sessions = createTurnSessions(fakeStatFn())
    expect(() => sessions.ensure('s1', 'relative/path')).toThrow(InvalidProjectPathError)
    expect(() => sessions.ensure('s1', '')).toThrow(InvalidProjectPathError)
    expect(() => sessions.ensure('s1', undefined)).toThrow(InvalidProjectPathError)
  })

  it('ensure() throws InvalidProjectPathError when the path does not exist on disk', () => {
    const statFn = () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }
    const sessions = createTurnSessions(statFn)
    expect(() => sessions.ensure('s1', '/app/workspace/does-not-exist')).toThrow(InvalidProjectPathError)
  })

  it('ensure() throws InvalidProjectPathError when the path exists but is not a directory', () => {
    const sessions = createTurnSessions(fakeStatFn(false))
    expect(() => sessions.ensure('s1', '/app/workspace/a-file.txt')).toThrow(InvalidProjectPathError)
  })

  it('setClaudeSessionId() updates the claudeSessionId for an existing session', () => {
    const sessions = createTurnSessions(fakeStatFn())
    sessions.ensure('s1', '/app/workspace/proj')
    sessions.setClaudeSessionId('s1', 'claude-uuid-1')
    expect(sessions.get('s1').claudeSessionId).toBe('claude-uuid-1')
  })
})
