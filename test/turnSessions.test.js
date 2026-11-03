import { describe, it, expect, vi } from 'vitest'
import { createTurnSessions, SessionConflictError, InvalidProjectPathError } from '../src/turnSessions.js'
import { createTurnEvents } from '../src/turnEvents.js'

function fakeStatFn(isDirectory = true) {
  return () => ({ isDirectory: () => isDirectory })
}

describe('createTurnSessions', () => {
  it('returns undefined for a sessionId that has never been seen', () => {
    const sessions = createTurnSessions(fakeStatFn())
    expect(sessions.get('unknown')).toBeUndefined()
  })

  it('ensure() creates a new session record with no claudeSessionId yet, idle, with no request/result history', () => {
    const sessions = createTurnSessions(fakeStatFn())
    const session = sessions.ensure('s1', '/app/workspace/proj')
    expect(session).toEqual({
      sessionId: 's1',
      projectPath: '/app/workspace/proj',
      claudeSessionId: null,
      status: 'idle',
      lastRequest: null,
      lastResult: null,
      lastError: null,
      updatedAt: expect.any(Number),
    })
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

  it('list() returns every known session', () => {
    const sessions = createTurnSessions(fakeStatFn())
    sessions.ensure('s1', '/app/workspace/a')
    sessions.ensure('s2', '/app/workspace/b')
    expect(sessions.list().map((s) => s.sessionId).sort()).toEqual(['s1', 's2'])
  })

  it('recordRequestStart() marks the session running and stores the request summary', () => {
    const sessions = createTurnSessions(fakeStatFn())
    sessions.ensure('s1', '/app/workspace/proj')
    sessions.recordRequestStart('s1', { model: 'opus', messageCount: 2, lastUserMessage: 'hi' })
    const session = sessions.get('s1')
    expect(session.status).toBe('running')
    expect(session.lastRequest).toEqual({ model: 'opus', messageCount: 2, lastUserMessage: 'hi' })
  })

  it('recordResult() marks the session idle, stores the result, and clears any previous error', () => {
    const sessions = createTurnSessions(fakeStatFn())
    sessions.ensure('s1', '/app/workspace/proj')
    sessions.recordError('s1', { message: 'boom' })
    sessions.recordResult('s1', { content: 'done', finishReason: 'stop', usage: { total_tokens: 5 } })
    const session = sessions.get('s1')
    expect(session.status).toBe('idle')
    expect(session.lastResult).toEqual({ content: 'done', finishReason: 'stop', usage: { total_tokens: 5 } })
    expect(session.lastError).toBeNull()
  })

  it('recordError() marks the session errored and stores the error', () => {
    const sessions = createTurnSessions(fakeStatFn())
    sessions.ensure('s1', '/app/workspace/proj')
    sessions.recordError('s1', { message: 'boom' })
    const session = sessions.get('s1')
    expect(session.status).toBe('error')
    expect(session.lastError).toEqual({ message: 'boom' })
  })

  it('publishes a session:update event on ensure(), recordRequestStart(), recordResult(), and recordError()', () => {
    const events = createTurnEvents()
    const listener = vi.fn()
    events.subscribe(listener)
    const sessions = createTurnSessions(fakeStatFn(), events)

    sessions.ensure('s1', '/app/workspace/proj')
    sessions.recordRequestStart('s1', { model: 'opus', messageCount: 1, lastUserMessage: 'hi' })
    sessions.recordResult('s1', { content: 'ok', finishReason: 'stop', usage: {} })
    sessions.recordError('s1', { message: 'boom' })

    expect(listener).toHaveBeenCalledTimes(4)
    for (const call of listener.mock.calls) {
      expect(call[0]).toEqual({ type: 'session:update', session: expect.objectContaining({ sessionId: 's1' }) })
    }
  })

  it('does not publish on a repeat ensure() call for an already-known session', () => {
    const events = createTurnEvents()
    const listener = vi.fn()
    const sessions = createTurnSessions(fakeStatFn(), events)
    sessions.ensure('s1', '/app/workspace/proj')
    events.subscribe(listener)
    sessions.ensure('s1', '/app/workspace/proj')
    expect(listener).not.toHaveBeenCalled()
  })
})
