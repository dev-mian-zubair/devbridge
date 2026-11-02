import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createChatCompletionsRouter } from '../src/routes/chatCompletions.js'
import { createSessionManager } from '../src/sessionManager.js'

function appWithFakePty(onDataHandlerBox) {
  const spawnFn = vi.fn(() => ({
    write: vi.fn(),
    onData: (cb) => { onDataHandlerBox.cb = cb },
    kill: vi.fn(),
  }))
  const sessionManager = createSessionManager(spawnFn)
  const app = express()
  app.use(express.json())
  app.use(createChatCompletionsRouter(sessionManager, { timeoutMs: 1000 }))
  return app
}

describe('POST /v1/chat/completions', () => {
  it('returns the detected reply once the PTY shows a prompt marker', async () => {
    const box = {}
    const app = appWithFakePty(box)
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

  it('returns 409 when sessionId is reused with a different projectPath', async () => {
    const box = {}
    const app = appWithFakePty(box)
    await request(app).post('/v1/chat/completions').send({
      sessionId: 's1', projectPath: '/a', messages: [{ role: 'user', content: 'hi' }],
    }).then(() => box.cb('ok\n❯ '))
    const res = await request(app).post('/v1/chat/completions').send({
      sessionId: 's1', projectPath: '/b', messages: [{ role: 'user', content: 'hi' }],
    })
    expect(res.status).toBe(409)
    expect(res.body.error.type).toBe('session_conflict')
  })

  it('leaves the session usable for a later request after a timeout', async () => {
    vi.useFakeTimers()
    const box = {}
    const app = appWithFakePty(box)
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
