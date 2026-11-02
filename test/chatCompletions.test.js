import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createChatCompletionsRouter } from '../src/routes/chatCompletions.js'
import { createSessionManager } from '../src/sessionManager.js'

function doneChunk(reply) {
  return `● ${reply}\r\n✻ Brewed for 1s · done 6:15 PM\r\n`
}

// Each request against a brand-new session now triggers TWO sequential
// pty.onData() registrations: sessionManager's internal readiness-wait
// listener (registered first, resolves on its own small fallback timeout
// since this fake never emits the real readiness marker), then
// chatCompletions' own reply listener (registered once getOrCreate
// resolves). `box.cb` always holds the latest registration; tests wait
// for `box.registrations >= 2` so they interact with the reply listener,
// not the readiness one. `disposeSpy` (returned here) tracks only the
// reply listener's own disposable, not the readiness listener's.
function appWithFakePty(onDataHandlerBox, { timeoutMs = 1000 } = {}) {
  const writeSpy = vi.fn()
  const replyDisposeSpy = vi.fn()
  onDataHandlerBox.registrations = 0
  const spawnFn = vi.fn(() => ({
    write: writeSpy,
    onData: (cb) => {
      onDataHandlerBox.registrations += 1
      onDataHandlerBox.cb = cb
      const isReadinessListener = onDataHandlerBox.registrations === 1
      return { dispose: isReadinessListener ? vi.fn() : replyDisposeSpy }
    },
    onExit: vi.fn(),
    kill: vi.fn(),
  }))
  const sessionManager = createSessionManager(spawnFn)
  const app = express()
  app.use(express.json())
  app.use(createChatCompletionsRouter(sessionManager, { timeoutMs }))
  return { app, disposeSpy: replyDisposeSpy, writeSpy }
}

function waitForReplyListener(box, opts) {
  return vi.waitUntil(() => box.registrations >= 2, opts)
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
      waitForReplyListener(box).then(() => box.cb(doneChunk('Hi there!'))),
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
      waitForReplyListener(box).then(() => box.cb(doneChunk('hi'))),
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
      waitForReplyListener(box).then(() => box.cb(doneChunk('ok'))),
    ])
    expect(disposeSpy).toHaveBeenCalledTimes(1)
  })

  it('disposes the PTY data listener after a timeout', async () => {
    // Fake timers interact badly with the readiness-wait's own setTimeout
    // plus real socket I/O (request delivery itself needs the real event
    // loop), so this uses a small real timeoutMs instead of faking time —
    // same tradeoff already used successfully elsewhere in this suite.
    const box = {}
    const { app, disposeSpy } = appWithFakePty(box, { timeoutMs: 50 })
    const req = request(app).post('/v1/chat/completions').send({
      sessionId: 's1', projectPath: '/app/workspace/proj', messages: [{ role: 'user', content: 'hi' }],
    })
    await req
    expect(disposeSpy).toHaveBeenCalledTimes(1)
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
    await waitForReplyListener(box)
    const second = await request(app).post('/v1/chat/completions').send({
      sessionId: 's1', projectPath: '/app/workspace/proj', messages: [{ role: 'user', content: 'again' }],
    })
    expect(second.status).toBe(503)
    expect(second.body.error.type).toBe('session_busy')
    box.cb(doneChunk('ok'))
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
      waitForReplyListener(box).then(() => box.cb(doneChunk('ok'))),
    ])
    const res = await request(app).post('/v1/chat/completions').send({
      sessionId: 's1', projectPath: '/b', messages: [{ role: 'user', content: 'hi' }],
    })
    expect(res.status).toBe(409)
    expect(res.body.error.type).toBe('session_conflict')
  })

  it('leaves the session usable for a later request after a timeout', async () => {
    // Real (small) timeoutMs throughout — see the previous test's comment
    // on why fake timers don't mix well with the readiness-wait step.
    const box = {}
    const { app } = appWithFakePty(box, { timeoutMs: 50 })
    const timedOut = request(app).post('/v1/chat/completions').send({
      sessionId: 's1', projectPath: '/app/workspace/proj', messages: [{ role: 'user', content: 'hi' }],
    })
    const timeoutRes = await timedOut
    expect(timeoutRes.status).toBe(504)

    // 's1' already exists now, so this retry reuses it: no readiness wait,
    // just the one reply-listener registration.
    box.registrations = 0
    box.cb = undefined
    const retry = request(app).post('/v1/chat/completions').send({
      sessionId: 's1', projectPath: '/app/workspace/proj', messages: [{ role: 'user', content: 'hi again' }],
    })
    const [res] = await Promise.all([
      retry,
      vi.waitUntil(() => box.registrations >= 1, { timeout: 2000 }).then(() => box.cb(doneChunk('Hi again!'))),
    ])
    expect(res.status).toBe(200)
    expect(res.body.choices[0].message.content).toBe('Hi again!')
  })
})
