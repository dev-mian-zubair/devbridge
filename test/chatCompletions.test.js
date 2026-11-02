import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createChatCompletionsRouter } from '../src/routes/chatCompletions.js'
import { createTurnSessions } from '../src/turnSessions.js'

function fakeRunner() {
  const pending = []
  return {
    pending,
    runTurn(opts) {
      let resolve, reject
      const promise = new Promise((res, rej) => {
        resolve = res
        reject = rej
      })
      const kill = vi.fn(() => reject(new Error('killed')))
      pending.push({ opts, resolve, reject, kill })
      return { promise, kill }
    },
  }
}

function outcome(overrides = {}) {
  return {
    text: 'Hi there!',
    usage: { input_tokens: 2, cache_read_input_tokens: 10, cache_creation_input_tokens: 0, output_tokens: 4 },
    totalCostUsd: 0.01,
    claudeSessionId: 'claude-uuid-1',
    isError: false,
    stopReason: 'end_turn',
    subtype: 'success',
    model: 'claude-opus-5-5',
    ...overrides,
  }
}

function appWith(runner, { timeoutMs = 1000, sessions = createTurnSessions() } = {}) {
  const app = express()
  app.use(express.json())
  app.use(createChatCompletionsRouter({ sessions, runner, timeoutMs }))
  return { app, sessions }
}

async function waitForPending(runner, count = 1) {
  await vi.waitUntil(() => runner.pending.length >= count, { timeout: 2000 })
}

describe('POST /v1/chat/completions', () => {
  it('returns the reply, model, and finish_reason once the runner resolves', async () => {
    const runner = fakeRunner()
    const { app } = appWith(runner)
    const reqPromise = request(app).post('/v1/chat/completions').send({
      sessionId: 's1', projectPath: '/app/workspace/proj', messages: [{ role: 'user', content: 'hello' }],
    })
    const [res] = await Promise.all([
      reqPromise,
      waitForPending(runner).then(() => runner.pending[0].resolve(outcome())),
    ])
    expect(res.status).toBe(200)
    expect(res.body.object).toBe('chat.completion')
    expect(res.body.model).toBe('claude-opus-5-5')
    expect(res.body.choices[0].message).toEqual({ role: 'assistant', content: 'Hi there!' })
    expect(res.body.choices[0].finish_reason).toBe('stop')
  })

  it('maps usage into prompt_tokens/completion_tokens/total_tokens', async () => {
    const runner = fakeRunner()
    const { app } = appWith(runner)
    const reqPromise = request(app).post('/v1/chat/completions').send({
      sessionId: 's1', projectPath: '/app/workspace/proj', messages: [{ role: 'user', content: 'hello' }],
    })
    const [res] = await Promise.all([
      reqPromise,
      waitForPending(runner).then(() => runner.pending[0].resolve(outcome())),
    ])
    expect(res.body.usage).toEqual({ prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 })
  })

  it('passes the last message content, projectPath, model, and systemPrompt to the runner', async () => {
    const runner = fakeRunner()
    const { app } = appWith(runner)
    const reqPromise = request(app).post('/v1/chat/completions').send({
      sessionId: 's1',
      projectPath: '/app/workspace/proj',
      model: 'opus',
      messages: [
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'ack' },
        { role: 'user', content: 'hello' },
      ],
    })
    reqPromise.catch(() => {})
    await waitForPending(runner)
    runner.pending[0].resolve(outcome())
    await reqPromise

    expect(runner.pending[0].opts.content).toBe('hello')
    expect(runner.pending[0].opts.projectPath).toBe('/app/workspace/proj')
    expect(runner.pending[0].opts.model).toBe('opus')
    expect(runner.pending[0].opts.systemPrompt).toBe('Be terse.')
    expect(runner.pending[0].opts.claudeSessionId).toBeUndefined()
  })

  it('resumes with the claudeSessionId stored from the previous turn', async () => {
    const runner = fakeRunner()
    const { app } = appWith(runner)

    const first = request(app).post('/v1/chat/completions').send({
      sessionId: 's1', projectPath: '/app/workspace/proj', messages: [{ role: 'user', content: 'hello' }],
    })
    first.catch(() => {})
    await waitForPending(runner, 1)
    runner.pending[0].resolve(outcome({ claudeSessionId: 'claude-uuid-1' }))
    await first

    const second = request(app).post('/v1/chat/completions').send({
      sessionId: 's1', projectPath: '/app/workspace/proj', messages: [{ role: 'user', content: 'again' }],
    })
    second.catch(() => {})
    await waitForPending(runner, 2)
    runner.pending[1].resolve(outcome({ claudeSessionId: 'claude-uuid-1' }))
    await second

    expect(runner.pending[1].opts.claudeSessionId).toBe('claude-uuid-1')
  })

  it('returns 400 for a request missing a non-empty messages array', async () => {
    const runner = fakeRunner()
    const { app } = appWith(runner)
    const res = await request(app).post('/v1/chat/completions').send({
      sessionId: 's1', projectPath: '/app/workspace/proj', messages: [],
    })
    expect(res.status).toBe(400)
    expect(res.body.error.type).toBe('invalid_request')
  })

  it('returns 400 for a relative or missing projectPath instead of crashing', async () => {
    const runner = fakeRunner()
    const { app } = appWith(runner)
    const res = await request(app).post('/v1/chat/completions').send({
      sessionId: 's1', projectPath: 'relative/path', messages: [{ role: 'user', content: 'hi' }],
    })
    expect(res.status).toBe(400)
    expect(res.body.error.type).toBe('invalid_project_path')
  })

  it('returns 409 when sessionId is reused with a different projectPath', async () => {
    const runner = fakeRunner()
    const { app } = appWith(runner)
    const first = request(app).post('/v1/chat/completions').send({
      sessionId: 's1', projectPath: '/a', messages: [{ role: 'user', content: 'hi' }],
    })
    first.catch(() => {})
    await waitForPending(runner)
    runner.pending[0].resolve(outcome())
    await first

    const res = await request(app).post('/v1/chat/completions').send({
      sessionId: 's1', projectPath: '/b', messages: [{ role: 'user', content: 'hi' }],
    })
    expect(res.status).toBe(409)
    expect(res.body.error.type).toBe('session_conflict')
  })

  it('returns 503 when a second request for the same session arrives while a turn is in flight', async () => {
    const runner = fakeRunner()
    const { app } = appWith(runner)
    const first = request(app).post('/v1/chat/completions').send({
      sessionId: 's1', projectPath: '/app/workspace/proj', messages: [{ role: 'user', content: 'hi' }],
    })
    first.catch(() => {})
    await waitForPending(runner)
    const second = await request(app).post('/v1/chat/completions').send({
      sessionId: 's1', projectPath: '/app/workspace/proj', messages: [{ role: 'user', content: 'again' }],
    })
    expect(second.status).toBe(503)
    expect(second.body.error.type).toBe('session_busy')
    runner.pending[0].resolve(outcome())
    await first
  })

  it('returns 500 with type assistant_error when the turn itself reports an error', async () => {
    const runner = fakeRunner()
    const { app } = appWith(runner)
    const reqPromise = request(app).post('/v1/chat/completions').send({
      sessionId: 's1', projectPath: '/app/workspace/proj', messages: [{ role: 'user', content: 'hi' }],
    })
    reqPromise.catch(() => {})
    await waitForPending(runner)
    runner.pending[0].resolve(outcome({ isError: true, subtype: 'error_during_execution', text: 'boom' }))
    const res = await reqPromise
    expect(res.status).toBe(500)
    expect(res.body.error.type).toBe('assistant_error')
  })

  it('returns 504 and kills the runner after a timeout, leaving the session usable again', async () => {
    const runner = fakeRunner()
    const { app } = appWith(runner, { timeoutMs: 50 })
    const res = await request(app).post('/v1/chat/completions').send({
      sessionId: 's1', projectPath: '/app/workspace/proj', messages: [{ role: 'user', content: 'hi' }],
    })
    expect(res.status).toBe(504)
    expect(runner.pending[0].kill).toHaveBeenCalled()

    const retry = request(app).post('/v1/chat/completions').send({
      sessionId: 's1', projectPath: '/app/workspace/proj', messages: [{ role: 'user', content: 'hi again' }],
    })
    retry.catch(() => {})
    await waitForPending(runner, 2)
    runner.pending[1].resolve(outcome())
    const retryRes = await retry
    expect(retryRes.status).toBe(200)
  })

  describe('stream: true', () => {
    it('streams role, content deltas, and a final stop chunk terminated by [DONE]', async () => {
      const runner = fakeRunner()
      const { app } = appWith(runner)
      const reqPromise = request(app).post('/v1/chat/completions').send({
        sessionId: 's1', projectPath: '/app/workspace/proj', stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      })
      reqPromise.catch(() => {})
      await waitForPending(runner)
      runner.pending[0].opts.onDelta('Hi ')
      runner.pending[0].opts.onDelta('there!')
      runner.pending[0].resolve(outcome())
      const res = await reqPromise

      expect(res.headers['content-type']).toMatch(/text\/event-stream/)
      const events = res.text
        .split('\n\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice('data: '.length))

      expect(events[events.length - 1]).toBe('[DONE]')
      const chunks = events.slice(0, -1).map((e) => JSON.parse(e))
      expect(chunks[0].choices[0].delta).toEqual({ role: 'assistant' })
      expect(chunks[0].object).toBe('chat.completion.chunk')
      const contentChunks = chunks.filter((c) => c.choices[0]?.delta?.content)
      expect(contentChunks.map((c) => c.choices[0].delta.content)).toEqual(['Hi ', 'there!'])
      const lastChunk = chunks[chunks.length - 1]
      expect(lastChunk.choices[0].finish_reason).toBe('stop')
    })

    it('includes a trailing usage chunk when stream_options.include_usage is true', async () => {
      const runner = fakeRunner()
      const { app } = appWith(runner)
      const reqPromise = request(app).post('/v1/chat/completions').send({
        sessionId: 's1', projectPath: '/app/workspace/proj', stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: 'user', content: 'hello' }],
      })
      reqPromise.catch(() => {})
      await waitForPending(runner)
      runner.pending[0].resolve(outcome())
      const res = await reqPromise

      const chunks = res.text
        .split('\n\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice('data: '.length))
        .filter((line) => line !== '[DONE]')
        .map((line) => JSON.parse(line))

      const usageChunk = chunks.find((c) => c.usage)
      expect(usageChunk.usage).toEqual({ prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 })
      expect(usageChunk.choices).toEqual([])
    })

    it('still returns a plain JSON 400 for an invalid streaming request', async () => {
      const runner = fakeRunner()
      const { app } = appWith(runner)
      const res = await request(app).post('/v1/chat/completions').send({
        sessionId: 's1', projectPath: '/app/workspace/proj', stream: true, messages: [],
      })
      expect(res.status).toBe(400)
      expect(res.headers['content-type']).toMatch(/json/)
      expect(res.body.error.type).toBe('invalid_request')
    })
  })
})
