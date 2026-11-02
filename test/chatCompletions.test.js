import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createChatCompletionsRouter } from '../src/routes/chatCompletions.js'
import { createSessionManager } from '../src/sessionManager.js'

function appWithFakePty(onDataHandlerBox) {
  const disposeSpy = vi.fn()
  const writeSpy = vi.fn()
  const spawnFn = vi.fn(() => ({
    write: writeSpy,
    onData: (cb) => { onDataHandlerBox.cb = cb; return { dispose: disposeSpy } },
    onExit: vi.fn(),
    kill: vi.fn(),
  }))
  const sessionManager = createSessionManager(spawnFn)
  const app = express()
  app.use(express.json())
  app.use(createChatCompletionsRouter(sessionManager, { timeoutMs: 1000 }))
  return { app, disposeSpy, writeSpy }
}

describe('POST /v1/chat/completions', () => {
  it('returns the detected reply once the PTY shows a prompt marker', async () => {
    const box = {}
    const { app } = appWithFakePty(box)
    const reqPromise = request(app).post('/v1/chat/completions').send({
      model: 'claude-code-local', sessionId: 's1', projectPath: '/app/workspace/proj',
      messages: [{ role: 'user', content: 'hello' }],
    })
    const [res] = await Promise.all([
      reqPromise,
      vi.waitUntil(() => box.cb).then(() => box.cb('Hi there!\n❯ ')),
    ])
    expect(res.status).toBe(200)
    expect(res.body.choices[0].message.content).toBe('Hi there!')
    expect(res.body.object).toBe('chat.completion')
  })

  it('writes the message to the PTY terminated with \\r, the terminal Enter key, not \\n', async () => {
    const box = {}
    const { app, writeSpy } = appWithFakePty(box)
    const reqPromise = request(app).post('/v1/chat/completions').send({
      sessionId: 's1', projectPath: '/app/workspace/proj',
      messages: [{ role: 'user', content: 'hello' }],
    })
    await Promise.all([
      reqPromise,
      vi.waitUntil(() => box.cb).then(() => box.cb('hi\n❯ ')),
    ])
    expect(writeSpy).toHaveBeenCalledWith('hello\r')
  })

  it('disposes the PTY data listener once a turn settles successfully', async () => {
    const box = {}
    const { app, disposeSpy } = appWithFakePty(box)
    const reqPromise = request(app).post('/v1/chat/completions').send({
      sessionId: 's1', projectPath: '/app/workspace/proj', messages: [{ role: 'user', content: 'hi' }],
    })
    await Promise.all([
      reqPromise,
      vi.waitUntil(() => box.cb).then(() => box.cb('ok\n❯ ')),
    ])
    expect(disposeSpy).toHaveBeenCalledTimes(1)
  })

  it('disposes the PTY data listener after a timeout', async () => {
    vi.useFakeTimers()
    const box = {}
    const { app, disposeSpy } = appWithFakePty(box)
    const req = request(app).post('/v1/chat/completions').send({
      sessionId: 's1', projectPath: '/app/workspace/proj', messages: [{ role: 'user', content: 'hi' }],
    })
    await Promise.all([
      req,
      vi.waitUntil(() => box.cb, { timeout: 2000 }).then(() => vi.advanceTimersByTimeAsync(1000)),
    ])
    expect(disposeSpy).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('returns 400 for a request missing a non-empty messages array', async () => {
    const box = {}
    const { app } = appWithFakePty(box)
    const res = await request(app).post('/v1/chat/completions').send({
      sessionId: 's1', projectPath: '/app/workspace/proj', messages: [],
    })
    expect(res.status).toBe(400)
    expect(res.body.error.type).toBe('invalid_request')
  })

  it('returns 400 for a relative or missing projectPath instead of crashing', async () => {
    const box = {}
    const { app } = appWithFakePty(box)
    const res = await request(app).post('/v1/chat/completions').send({
      sessionId: 's1', projectPath: 'relative/path', messages: [{ role: 'user', content: 'hi' }],
    })
    expect(res.status).toBe(400)
    expect(res.body.error.type).toBe('invalid_project_path')
  })

  it('returns 503 when a second request for the same session arrives while a turn is in flight', async () => {
    const box = {}
    const { app } = appWithFakePty(box)
    const first = request(app).post('/v1/chat/completions').send({
      sessionId: 's1', projectPath: '/app/workspace/proj', messages: [{ role: 'user', content: 'hi' }],
    })
    first.catch(() => {})
    await vi.waitUntil(() => box.cb)
    const second = await request(app).post('/v1/chat/completions').send({
      sessionId: 's1', projectPath: '/app/workspace/proj', messages: [{ role: 'user', content: 'again' }],
    })
    expect(second.status).toBe(503)
    expect(second.body.error.type).toBe('session_busy')
    box.cb('ok\n❯ ')
    await first
  })

  it('returns 409 when sessionId is reused with a different projectPath', async () => {
    const box = {}
    const { app } = appWithFakePty(box)
    const first = request(app).post('/v1/chat/completions').send({
      sessionId: 's1', projectPath: '/a', messages: [{ role: 'user', content: 'hi' }],
    })
    await Promise.all([
      first,
      vi.waitUntil(() => box.cb).then(() => box.cb('ok\n❯ ')),
    ])
    const res = await request(app).post('/v1/chat/completions').send({
      sessionId: 's1', projectPath: '/b', messages: [{ role: 'user', content: 'hi' }],
    })
    expect(res.status).toBe(409)
    expect(res.body.error.type).toBe('session_conflict')
  })

  it('leaves the session usable for a later request after a timeout', async () => {
    vi.useFakeTimers()
    const box = {}
    const { app } = appWithFakePty(box)
    const timedOut = request(app).post('/v1/chat/completions').send({
      sessionId: 's1', projectPath: '/app/workspace/proj', messages: [{ role: 'user', content: 'hi' }],
    })
    const [timeoutRes] = await Promise.all([
      timedOut,
      vi.waitUntil(() => box.cb, { timeout: 2000 }).then(() => vi.advanceTimersByTimeAsync(1000)),
    ])
    expect(timeoutRes.status).toBe(504)
    vi.useRealTimers()
    box.cb = undefined

    const retry = request(app).post('/v1/chat/completions').send({
      sessionId: 's1', projectPath: '/app/workspace/proj', messages: [{ role: 'user', content: 'hi again' }],
    })
    const [res] = await Promise.all([
      retry,
      vi.waitUntil(() => box.cb, { timeout: 2000 }).then(() => box.cb('Hi again!\n❯ ')),
    ])
    expect(res.status).toBe(200)
    expect(res.body.choices[0].message.content).toBe('Hi again!')
  })
})
