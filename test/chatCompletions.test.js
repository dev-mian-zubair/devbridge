import { describe, it, expect, vi } from 'vitest'
import http from 'node:http'
import express from 'express'
import request from 'supertest'
import { createChatCompletionsRouter } from '../src/routes/chatCompletions.js'
import { createTurnSessions } from '../src/turnSessions.js'
import { createTurnEvents } from '../src/turnEvents.js'

// kill() here is a plain spy, not an auto-reject: a real killed process
// takes a moment to actually exit, and tests that care about that gap
// (the session lock isn't released until the raw promise settles) drive
// `reject` themselves to simulate the process's own 'close' event firing.
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
      const kill = vi.fn()
      const claudeSessionId = opts.claudeSessionId ?? 'generated-uuid'
      pending.push({ opts, resolve, reject, kill, claudeSessionId })
      return { promise, kill, claudeSessionId }
    },
  }
}

async function flushMicrotasks() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function parseSseEvents(text) {
  return text
    .split('\n\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice('data: '.length))
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

function appWith(runner, {
  timeoutMs = 1000,
  events = createTurnEvents(),
  sessions = createTurnSessions(() => ({ isDirectory: () => true }), events),
} = {}) {
  const app = express()
  app.use(express.json())
  app.use(createChatCompletionsRouter({ sessions, runner, timeoutMs, events }))
  return { app, sessions, events }
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
    expect(res.body.choices[0].message).toEqual({ role: 'assistant', content: 'Hi there!', refusal: null })
    expect(res.body.choices[0].finish_reason).toBe('stop')
  })

  it('a tool_use outcome produces a tool_calls response with finish_reason tool_calls', async () => {
    const runner = fakeRunner()
    const { app } = appWith(runner)
    const reqPromise = request(app).post('/v1/chat/completions').send({
      sessionId: 's1', projectPath: '/app/workspace/proj',
      messages: [{ role: 'user', content: 'weather in paris?' }],
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
    })
    const [res] = await Promise.all([
      reqPromise,
      waitForPending(runner).then(() => runner.pending[0].resolve(outcome({
        text: '', stopReason: 'tool_use', toolCalls: [{ index: 0, id: 'toolu_1', name: 'get_weather', arguments: '{"location":"Paris"}' }],
      }))),
    ])
    expect(res.status).toBe(200)
    expect(res.body.choices[0].finish_reason).toBe('tool_calls')
    expect(res.body.choices[0].message.tool_calls).toEqual([
      { id: 'toolu_1', type: 'function', function: { name: 'get_weather', arguments: '{"location":"Paris"}' } },
    ])
    expect(res.body.choices[0].message.content).toBeNull()
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
    expect(res.body.usage).toEqual({
      prompt_tokens: 12, completion_tokens: 4, total_tokens: 16,
      prompt_tokens_details: { cached_tokens: 10 },
    })
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

    expect(runner.pending[0].opts.content).toBe('User: first\n\nAssistant: ack\n\nUser: hello')
    expect(runner.pending[0].opts.projectPath).toBe('/app/workspace/proj')
    expect(runner.pending[0].opts.model).toBe('opus')
    expect(runner.pending[0].opts.systemPrompt).toBe('Be terse.')
  })

  describe('X-Session-Id / X-Project-Path headers', () => {
    it('accepts sessionId and projectPath via headers when the body omits them entirely', async () => {
      const runner = fakeRunner()
      const { app } = appWith(runner)
      const reqPromise = request(app).post('/v1/chat/completions')
        .set('X-Session-Id', 's1')
        .set('X-Project-Path', '/app/workspace/proj')
        .send({ messages: [{ role: 'user', content: 'hello' }] })
      reqPromise.catch(() => {})
      await waitForPending(runner)
      runner.pending[0].resolve(outcome())
      const res = await reqPromise
      expect(res.status).toBe(200)
      expect(runner.pending[0].opts.projectPath).toBe('/app/workspace/proj')
    })

    it('prefers header values over body fields when both are present', async () => {
      const runner = fakeRunner()
      const { app } = appWith(runner)
      // The body's projectPath is relative (would 400 on its own); the header's
      // absolute path should be the one actually used.
      const reqPromise = request(app).post('/v1/chat/completions')
        .set('X-Session-Id', 's1')
        .set('X-Project-Path', '/app/workspace/proj')
        .send({ sessionId: 's-from-body', projectPath: 'relative/path', messages: [{ role: 'user', content: 'hi' }] })
      reqPromise.catch(() => {})
      await waitForPending(runner)
      runner.pending[0].resolve(outcome())
      const res = await reqPromise
      expect(res.status).toBe(200)
      expect(runner.pending[0].opts.projectPath).toBe('/app/workspace/proj')
    })

    it('still returns 400 when sessionId/projectPath are missing from both headers and body', async () => {
      const runner = fakeRunner()
      const { app } = appWith(runner)
      const res = await request(app).post('/v1/chat/completions').send({
        messages: [{ role: 'user', content: 'hi' }],
      })
      expect(res.status).toBe(400)
      expect(res.body.error.type).toBe('invalid_request_error')
    })
  })

  it('returns 400 for a request missing a non-empty messages array', async () => {
    const runner = fakeRunner()
    const { app } = appWith(runner)
    const res = await request(app).post('/v1/chat/completions').send({
      sessionId: 's1', projectPath: '/app/workspace/proj', messages: [],
    })
    expect(res.status).toBe(400)
    expect(res.body.error.type).toBe('invalid_request_error')
    expect(res.headers['x-should-retry']).toBe('false')
  })

  it('returns 400 for a last message with empty string content', async () => {
    const runner = fakeRunner()
    const { app } = appWith(runner)
    const res = await request(app).post('/v1/chat/completions').send({
      sessionId: 's1', projectPath: '/app/workspace/proj', messages: [{ role: 'user', content: '' }],
    })
    expect(res.status).toBe(400)
    expect(res.body.error.type).toBe('invalid_request_error')
  })

  it('flattens an OpenAI-style content-part array into plain text', async () => {
    const runner = fakeRunner()
    const { app } = appWith(runner)
    const reqPromise = request(app).post('/v1/chat/completions').send({
      sessionId: 's1', projectPath: '/app/workspace/proj',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }] }],
    })
    reqPromise.catch(() => {})
    await waitForPending(runner)
    runner.pending[0].resolve(outcome())
    await reqPromise
    expect(runner.pending[0].opts.content).toBe('User: hello world')
  })

  it('rejects a model value with characters outside a safe alias charset', async () => {
    const runner = fakeRunner()
    const { app } = appWith(runner)
    const res = await request(app).post('/v1/chat/completions').send({
      sessionId: 's1', projectPath: '/app/workspace/proj', model: 'opus; rm -rf /',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(res.status).toBe(400)
    expect(res.body.error.type).toBe('invalid_request_error')
  })

  it('rejects a system message containing a NUL byte', async () => {
    const runner = fakeRunner()
    const { app } = appWith(runner)
    const res = await request(app).post('/v1/chat/completions').send({
      sessionId: 's1', projectPath: '/app/workspace/proj',
      messages: [{ role: 'system', content: 'be\u0000 terse' }, { role: 'user', content: 'hi' }],
    })
    expect(res.status).toBe(400)
    expect(res.body.error.type).toBe('invalid_request_error')
  })

  it('treats stream as streaming only when it is exactly boolean true', async () => {
    const runner = fakeRunner()
    const { app } = appWith(runner)
    const reqPromise = request(app).post('/v1/chat/completions').send({
      sessionId: 's1', projectPath: '/app/workspace/proj', stream: 'true',
      messages: [{ role: 'user', content: 'hi' }],
    })
    reqPromise.catch(() => {})
    await waitForPending(runner)
    runner.pending[0].resolve(outcome())
    const res = await reqPromise
    expect(res.headers['content-type']).toMatch(/json/)
    expect(res.body.object).toBe('chat.completion')
  })

  it('returns 400 for a relative or missing projectPath instead of crashing', async () => {
    const runner = fakeRunner()
    const { app } = appWith(runner)
    const res = await request(app).post('/v1/chat/completions').send({
      sessionId: 's1', projectPath: 'relative/path', messages: [{ role: 'user', content: 'hi' }],
    })
    expect(res.status).toBe(400)
    expect(res.body.error.type).toBe('invalid_project_path')
    expect(res.headers['x-should-retry']).toBe('false')
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
    expect(res.headers['x-should-retry']).toBe('false')
  })

  it('returns 503 with a Retry-After header when a second request for the same session arrives while a turn is in flight', async () => {
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
    expect(second.headers['retry-after']).toBeDefined()
    runner.pending[0].resolve(outcome())
    await first
  })

  it('returns 500 server_error with the real error message when the runner rejects unexpectedly', async () => {
    const runner = fakeRunner()
    const { app } = appWith(runner)
    const reqPromise = request(app).post('/v1/chat/completions').send({
      sessionId: 's1', projectPath: '/app/workspace/proj', messages: [{ role: 'user', content: 'hi' }],
    })
    reqPromise.catch(() => {})
    await waitForPending(runner)
    runner.pending[0].reject(new Error('claude CLI exited with code 127: command not found'))
    const res = await reqPromise
    expect(res.status).toBe(500)
    expect(res.body.error.type).toBe('server_error')
    expect(res.body.error.message).toMatch(/exited with code 127/)
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
    expect(res.headers['x-should-retry']).toBe('false')
  })

  it('returns 504 and kills the runner after a timeout; the session is usable again once the kill actually completes', async () => {
    const runner = fakeRunner()
    const { app } = appWith(runner, { timeoutMs: 50 })
    const res = await request(app).post('/v1/chat/completions').send({
      sessionId: 's1', projectPath: '/app/workspace/proj', messages: [{ role: 'user', content: 'hi' }],
    })
    expect(res.status).toBe(504)
    expect(res.headers['x-should-retry']).toBeUndefined()
    expect(runner.pending[0].kill).toHaveBeenCalled()

    // The killed process's own 'close' event firing — simulated here —
    // is what actually settles the raw promise and releases the lock.
    runner.pending[0].reject(new Error('process killed'))
    await flushMicrotasks()

    const retry = request(app).post('/v1/chat/completions').send({
      sessionId: 's1', projectPath: '/app/workspace/proj', messages: [{ role: 'user', content: 'hi again' }],
    })
    retry.catch(() => {})
    await waitForPending(runner, 2)
    runner.pending[1].resolve(outcome())
    const retryRes = await retry
    expect(retryRes.status).toBe(200)
  })

  it('keeps the session locked until the killed process actually exits, even though the client already got a 504', async () => {
    const runner = fakeRunner()
    const { app } = appWith(runner, { timeoutMs: 50 })
    const res = await request(app).post('/v1/chat/completions').send({
      sessionId: 's1', projectPath: '/app/workspace/proj', messages: [{ role: 'user', content: 'hi' }],
    })
    expect(res.status).toBe(504)

    // A retry sent before the underlying process has actually exited must
    // not be allowed to --resume the same CLI session concurrently.
    const tooSoon = await request(app).post('/v1/chat/completions').send({
      sessionId: 's1', projectPath: '/app/workspace/proj', messages: [{ role: 'user', content: 'too soon' }],
    })
    expect(tooSoon.status).toBe(503)

    runner.pending[0].reject(new Error('process killed'))
    await flushMicrotasks()

    const afterExit = request(app).post('/v1/chat/completions').send({
      sessionId: 's1', projectPath: '/app/workspace/proj', messages: [{ role: 'user', content: 'now' }],
    })
    afterExit.catch(() => {})
    await waitForPending(runner, 2)
    runner.pending[1].resolve(outcome())
    expect((await afterExit).status).toBe(200)
  })

  describe('OpenAI API compatibility', () => {
    it('includes refusal: null on the message and logprobs: null on the choice', async () => {
      const runner = fakeRunner()
      const { app } = appWith(runner)
      const reqPromise = request(app).post('/v1/chat/completions').send({
        sessionId: 's1', projectPath: '/app/workspace/proj', messages: [{ role: 'user', content: 'hi' }],
      })
      reqPromise.catch(() => {})
      await waitForPending(runner)
      runner.pending[0].resolve(outcome())
      const res = await reqPromise
      expect(res.body.choices[0].message).toEqual({ role: 'assistant', content: 'Hi there!', refusal: null })
      expect(res.body.choices[0].logprobs).toBeNull()
    })

    it('includes usage.prompt_tokens_details.cached_tokens from cache_read_input_tokens', async () => {
      const runner = fakeRunner()
      const { app } = appWith(runner)
      const reqPromise = request(app).post('/v1/chat/completions').send({
        sessionId: 's1', projectPath: '/app/workspace/proj', messages: [{ role: 'user', content: 'hi' }],
      })
      reqPromise.catch(() => {})
      await waitForPending(runner)
      runner.pending[0].resolve(outcome())
      const res = await reqPromise
      expect(res.body.usage.prompt_tokens_details).toEqual({ cached_tokens: 10 })
    })

    it('treats a developer-role message the same as system for the prompt', async () => {
      const runner = fakeRunner()
      const { app } = appWith(runner)
      const reqPromise = request(app).post('/v1/chat/completions').send({
        sessionId: 's1', projectPath: '/app/workspace/proj',
        messages: [{ role: 'developer', content: 'Be terse.' }, { role: 'user', content: 'hi' }],
      })
      reqPromise.catch(() => {})
      await waitForPending(runner)
      runner.pending[0].resolve(outcome())
      await reqPromise
      expect(runner.pending[0].opts.systemPrompt).toBe('Be terse.')
    })

    it('rejects a request with a non-empty functions array (deprecated alias of tools)', async () => {
      const runner = fakeRunner()
      const { app } = appWith(runner)
      const res = await request(app).post('/v1/chat/completions').send({
        sessionId: 's1', projectPath: '/app/workspace/proj', functions: [{ name: 'f' }],
        messages: [{ role: 'user', content: 'hi' }],
      })
      expect(res.status).toBe(400)
      expect(res.body.error.type).toBe('invalid_request_error')
    })

    it('accepts a request with tools and tool_choice auto', async () => {
      const runner = fakeRunner()
      const { app } = appWith(runner)
      const reqPromise = request(app).post('/v1/chat/completions').send({
        sessionId: 's1', projectPath: '/app/workspace/proj',
        messages: [{ role: 'user', content: 'weather in paris?' }],
        tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
        tool_choice: 'auto',
      })
      reqPromise.catch(() => {})
      await waitForPending(runner)
      expect(runner.pending[0].opts.tools).toEqual([{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }])
    })

    it('rejects tool_choice: "required" with 400', async () => {
      const runner = fakeRunner()
      const { app } = appWith(runner)
      const res = await request(app).post('/v1/chat/completions').send({
        sessionId: 's1', projectPath: '/app/workspace/proj',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ type: 'function', function: { name: 'get_weather' } }],
        tool_choice: 'required',
      })
      expect(res.status).toBe(400)
    })

    it('rejects a tool with a NUL byte in its name with 400 (Review Focus)', async () => {
      const runner = fakeRunner()
      const { app } = appWith(runner)
      const res = await request(app).post('/v1/chat/completions').send({
        sessionId: 's1', projectPath: '/app/workspace/proj',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ type: 'function', function: { name: 'bad\0name' } }],
      })
      expect(res.status).toBe(400)
      expect(runner.pending).toHaveLength(0)
    })

    it('tool_choice "none" does not pass tools through to the runner, even if tools is non-empty', async () => {
      const runner = fakeRunner()
      const { app } = appWith(runner)
      const reqPromise = request(app).post('/v1/chat/completions').send({
        sessionId: 's1', projectPath: '/app/workspace/proj',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ type: 'function', function: { name: 'get_weather' } }],
        tool_choice: 'none',
      })
      reqPromise.catch(() => {})
      await waitForPending(runner)
      expect(runner.pending[0].opts.tools).toBeFalsy()
    })

    it('passes the full serialized history, not just the last message, to the runner', async () => {
      const runner = fakeRunner()
      const { app } = appWith(runner)
      const reqPromise = request(app).post('/v1/chat/completions').send({
        sessionId: 's1', projectPath: '/app/workspace/proj',
        messages: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'ack' },
          { role: 'user', content: 'second' },
        ],
      })
      reqPromise.catch(() => {})
      await waitForPending(runner)
      expect(runner.pending[0].opts.content).toBe('User: first\n\nAssistant: ack\n\nUser: second')
    })

    it('accepts a request whose last message is a tool result (Review Focus: no longer requires text as the last message)', async () => {
      const runner = fakeRunner()
      const { app } = appWith(runner)
      const reqPromise = request(app).post('/v1/chat/completions').send({
        sessionId: 's1', projectPath: '/app/workspace/proj',
        messages: [
          { role: 'user', content: 'weather?' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 'call_1', content: 'sunny' },
        ],
      })
      reqPromise.catch(() => {})
      await waitForPending(runner)
      expect(runner.pending).toHaveLength(1)
    })

    it('rejects a request with n greater than 1', async () => {
      const runner = fakeRunner()
      const { app } = appWith(runner)
      const res = await request(app).post('/v1/chat/completions').send({
        sessionId: 's1', projectPath: '/app/workspace/proj', n: 2, messages: [{ role: 'user', content: 'hi' }],
      })
      expect(res.status).toBe(400)
      expect(res.body.error.type).toBe('invalid_request_error')
    })

    it('accepts n === 1 and sampling/other unsupported fields without error, ignoring them', async () => {
      const runner = fakeRunner()
      const { app } = appWith(runner)
      const reqPromise = request(app).post('/v1/chat/completions').send({
        sessionId: 's1', projectPath: '/app/workspace/proj', n: 1,
        temperature: 0.7, top_p: 0.9, frequency_penalty: 0.1, presence_penalty: 0.1,
        max_tokens: 100, max_completion_tokens: 100, seed: 42, user: 'u1', logit_bias: { 123: 1 },
        messages: [{ role: 'user', content: 'hi' }],
      })
      reqPromise.catch(() => {})
      await waitForPending(runner)
      runner.pending[0].resolve(outcome())
      const res = await reqPromise
      expect(res.status).toBe(200)
    })

    it('maps reasoning_effort to the runner as effort when it is a CLI-supported level', async () => {
      const runner = fakeRunner()
      const { app } = appWith(runner)
      const reqPromise = request(app).post('/v1/chat/completions').send({
        sessionId: 's1', projectPath: '/app/workspace/proj', reasoning_effort: 'high',
        messages: [{ role: 'user', content: 'hi' }],
      })
      reqPromise.catch(() => {})
      await waitForPending(runner)
      runner.pending[0].resolve(outcome())
      await reqPromise
      expect(runner.pending[0].opts.effort).toBe('high')
    })

    it('rejects reasoning_effort values the CLI does not support (e.g. "none")', async () => {
      const runner = fakeRunner()
      const { app } = appWith(runner)
      const res = await request(app).post('/v1/chat/completions').send({
        sessionId: 's1', projectPath: '/app/workspace/proj', reasoning_effort: 'none',
        messages: [{ role: 'user', content: 'hi' }],
      })
      expect(res.status).toBe(400)
      expect(res.body.error.type).toBe('invalid_request_error')
    })

    it('maps response_format json_schema to the runner as jsonSchema', async () => {
      const runner = fakeRunner()
      const { app } = appWith(runner)
      const schema = { type: 'object', properties: { ok: { type: 'boolean' } } }
      const reqPromise = request(app).post('/v1/chat/completions').send({
        sessionId: 's1', projectPath: '/app/workspace/proj',
        response_format: { type: 'json_schema', json_schema: { name: 'result', schema } },
        messages: [{ role: 'user', content: 'hi' }],
      })
      reqPromise.catch(() => {})
      await waitForPending(runner)
      runner.pending[0].resolve(outcome())
      await reqPromise
      expect(runner.pending[0].opts.jsonSchema).toEqual(schema)
    })

    it('rejects response_format json_schema without a schema', async () => {
      const runner = fakeRunner()
      const { app } = appWith(runner)
      const res = await request(app).post('/v1/chat/completions').send({
        sessionId: 's1', projectPath: '/app/workspace/proj',
        response_format: { type: 'json_schema', json_schema: { name: 'result' } },
        messages: [{ role: 'user', content: 'hi' }],
      })
      expect(res.status).toBe(400)
      expect(res.body.error.type).toBe('invalid_request_error')
    })

    it('ignores response_format type text/json_object as a no-op', async () => {
      const runner = fakeRunner()
      const { app } = appWith(runner)
      const reqPromise = request(app).post('/v1/chat/completions').send({
        sessionId: 's1', projectPath: '/app/workspace/proj', response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: 'hi' }],
      })
      reqPromise.catch(() => {})
      await waitForPending(runner)
      runner.pending[0].resolve(outcome())
      await reqPromise
      expect(runner.pending[0].opts.jsonSchema).toBeUndefined()
    })

    it('rejects a request with logprobs: true (the CLI has no logprob data to return)', async () => {
      const runner = fakeRunner()
      const { app } = appWith(runner)
      const res = await request(app).post('/v1/chat/completions').send({
        sessionId: 's1', projectPath: '/app/workspace/proj', logprobs: true,
        messages: [{ role: 'user', content: 'hi' }],
      })
      expect(res.status).toBe(400)
      expect(res.body.error.type).toBe('invalid_request_error')
    })

    it('accepts logprobs: false as a no-op', async () => {
      const runner = fakeRunner()
      const { app } = appWith(runner)
      const reqPromise = request(app).post('/v1/chat/completions').send({
        sessionId: 's1', projectPath: '/app/workspace/proj', logprobs: false,
        messages: [{ role: 'user', content: 'hi' }],
      })
      reqPromise.catch(() => {})
      await waitForPending(runner)
      runner.pending[0].resolve(outcome())
      const res = await reqPromise
      expect(res.status).toBe(200)
    })

    it('rejects a request with a non-text modality (e.g. audio)', async () => {
      const runner = fakeRunner()
      const { app } = appWith(runner)
      const res = await request(app).post('/v1/chat/completions').send({
        sessionId: 's1', projectPath: '/app/workspace/proj', modalities: ['text', 'audio'],
        messages: [{ role: 'user', content: 'hi' }],
      })
      expect(res.status).toBe(400)
      expect(res.body.error.type).toBe('invalid_request_error')
    })

    it('accepts modalities: ["text"] as a no-op', async () => {
      const runner = fakeRunner()
      const { app } = appWith(runner)
      const reqPromise = request(app).post('/v1/chat/completions').send({
        sessionId: 's1', projectPath: '/app/workspace/proj', modalities: ['text'],
        messages: [{ role: 'user', content: 'hi' }],
      })
      reqPromise.catch(() => {})
      await waitForPending(runner)
      runner.pending[0].resolve(outcome())
      const res = await reqPromise
      expect(res.status).toBe(200)
    })
  })

  describe('observability: turnSessions status and turnEvents', () => {
    it('records a running status and request summary on turnSessions once a turn starts', async () => {
      const runner = fakeRunner()
      const { app, sessions } = appWith(runner)
      const reqPromise = request(app).post('/v1/chat/completions').send({
        sessionId: 's1', projectPath: '/app/workspace/proj', model: 'opus',
        messages: [{ role: 'user', content: 'hi' }],
      })
      reqPromise.catch(() => {})
      await waitForPending(runner)
      expect(sessions.get('s1').status).toBe('running')
      expect(sessions.get('s1').lastRequest).toEqual({ model: 'opus', messageCount: 1, lastUserMessage: 'User: hi' })
      runner.pending[0].resolve(outcome())
      await reqPromise
    })

    it('records the result on turnSessions once a turn completes successfully', async () => {
      const runner = fakeRunner()
      const { app, sessions } = appWith(runner)
      const reqPromise = request(app).post('/v1/chat/completions').send({
        sessionId: 's1', projectPath: '/app/workspace/proj', messages: [{ role: 'user', content: 'hi' }],
      })
      reqPromise.catch(() => {})
      await waitForPending(runner)
      runner.pending[0].resolve(outcome())
      await reqPromise
      const session = sessions.get('s1')
      expect(session.status).toBe('idle')
      expect(session.lastResult.content).toBe('Hi there!')
      expect(session.lastResult.finishReason).toBe('stop')
    })

    it('records an error on turnSessions when the turn ends in an assistant error', async () => {
      const runner = fakeRunner()
      const { app, sessions } = appWith(runner)
      const reqPromise = request(app).post('/v1/chat/completions').send({
        sessionId: 's1', projectPath: '/app/workspace/proj', messages: [{ role: 'user', content: 'hi' }],
      })
      reqPromise.catch(() => {})
      await waitForPending(runner)
      runner.pending[0].resolve(outcome({ isError: true, text: 'denied' }))
      await reqPromise
      const session = sessions.get('s1')
      expect(session.status).toBe('error')
      expect(session.lastError.message).toBe('denied')
    })

    it('publishes session:delta events as the turn streams, even for a non-streaming request', async () => {
      const runner = fakeRunner()
      const events = createTurnEvents()
      const listener = vi.fn()
      events.subscribe(listener)
      const { app } = appWith(runner, { events })
      const reqPromise = request(app).post('/v1/chat/completions').send({
        sessionId: 's1', projectPath: '/app/workspace/proj', messages: [{ role: 'user', content: 'hi' }],
      })
      reqPromise.catch(() => {})
      await waitForPending(runner)
      runner.pending[0].opts.onDelta('Hi ')
      runner.pending[0].resolve(outcome())
      await reqPromise
      expect(listener).toHaveBeenCalledWith({ type: 'session:delta', sessionId: 's1', text: 'Hi ' })
    })
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
      expect(chunks[0].choices[0].delta).toEqual({ role: 'assistant', content: '' })
      expect(chunks[0].object).toBe('chat.completion.chunk')
      const contentChunks = chunks.filter((c) => c.choices[0]?.delta?.content)
      expect(contentChunks.map((c) => c.choices[0].delta.content)).toEqual(['Hi ', 'there!'])
      const lastChunk = chunks[chunks.length - 1]
      expect(lastChunk.choices[0].finish_reason).toBe('stop')
    })

    it('streams tool_call deltas: first chunk carries id/type/function.name, later chunks carry only arguments fragments', async () => {
      const runner = fakeRunner()
      const { app } = appWith(runner)
      const reqPromise = request(app).post('/v1/chat/completions').send({
        sessionId: 's1', projectPath: '/app/workspace/proj', stream: true,
        messages: [{ role: 'user', content: 'weather in paris?' }],
        tools: [{ type: 'function', function: { name: 'get_weather' } }],
      })
      const [res] = await Promise.all([
        reqPromise,
        waitForPending(runner).then(async () => {
          const { opts, resolve } = runner.pending[0]
          opts.onToolCallDelta({ index: 0, id: 'toolu_1', name: 'get_weather', argumentsFragment: '' })
          opts.onToolCallDelta({ index: 0, argumentsFragment: '{"location":"Paris"}' })
          resolve(outcome({ text: '', stopReason: 'tool_use', toolCalls: [{ index: 0, id: 'toolu_1', name: 'get_weather', arguments: '{"location":"Paris"}' }] }))
        }),
      ])
      const events = parseSseEvents(res.text).filter((e) => e !== '[DONE]').map((e) => JSON.parse(e))
      const toolChunks = events.filter((e) => e.choices?.[0]?.delta?.tool_calls)
      expect(toolChunks[0].choices[0].delta.tool_calls).toEqual([
        { index: 0, id: 'toolu_1', type: 'function', function: { name: 'get_weather', arguments: '' } },
      ])
      expect(toolChunks[1].choices[0].delta.tool_calls).toEqual([{ index: 0, function: { arguments: '{"location":"Paris"}' } }])
      expect(events.at(-1).choices[0].finish_reason).toBe('tool_calls')
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
      expect(usageChunk.usage).toEqual({
        prompt_tokens: 12, completion_tokens: 4, total_tokens: 16,
        prompt_tokens_details: { cached_tokens: 10 },
      })
      expect(usageChunk.choices).toEqual([])
    })

    it('includes an explicit zeroed usage chunk when include_usage is true but the runner reports no usage', async () => {
      const runner = fakeRunner()
      const { app } = appWith(runner)
      const reqPromise = request(app).post('/v1/chat/completions').send({
        sessionId: 's1', projectPath: '/app/workspace/proj', stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: 'user', content: 'hello' }],
      })
      reqPromise.catch(() => {})
      await waitForPending(runner)
      runner.pending[0].resolve(outcome({ usage: null }))
      const res = await reqPromise

      const chunks = parseSseEvents(res.text).filter((l) => l !== '[DONE]').map((l) => JSON.parse(l))
      const usageChunk = chunks.find((c) => 'usage' in c)
      expect(usageChunk.usage).toEqual({
        prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
        prompt_tokens_details: { cached_tokens: 0 },
      })
    })

    it('still returns a plain JSON 400 for an invalid streaming request', async () => {
      const runner = fakeRunner()
      const { app } = appWith(runner)
      const res = await request(app).post('/v1/chat/completions').send({
        sessionId: 's1', projectPath: '/app/workspace/proj', stream: true, messages: [],
      })
      expect(res.status).toBe(400)
      expect(res.headers['content-type']).toMatch(/json/)
      expect(res.body.error.type).toBe('invalid_request_error')
    })

    it('writes an error chunk before [DONE] when the turn times out mid-stream', async () => {
      const runner = fakeRunner()
      const { app } = appWith(runner, { timeoutMs: 50 })
      const res = await request(app).post('/v1/chat/completions').send({
        sessionId: 's1', projectPath: '/app/workspace/proj', stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      })

      expect(res.headers['content-type']).toMatch(/text\/event-stream/)
      const events = parseSseEvents(res.text)
      expect(events[events.length - 1]).toBe('[DONE]')
      const errorChunk = events.slice(0, -1).map((e) => JSON.parse(e)).find((c) => c.error)
      expect(errorChunk.error.type).toBe('timeout')
      runner.pending[0].reject(new Error('process killed'))
    })

    it('writes an error chunk before [DONE] when the result reports isError, instead of a stop finish_reason', async () => {
      const runner = fakeRunner()
      const { app } = appWith(runner)
      const reqPromise = request(app).post('/v1/chat/completions').send({
        sessionId: 's1', projectPath: '/app/workspace/proj', stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      })
      reqPromise.catch(() => {})
      await waitForPending(runner)
      runner.pending[0].resolve(outcome({ isError: true, subtype: 'error_during_execution', text: 'boom' }))
      const res = await reqPromise

      const events = parseSseEvents(res.text)
      expect(events[events.length - 1]).toBe('[DONE]')
      const chunks = events.slice(0, -1).map((e) => JSON.parse(e))
      const errorChunk = chunks.find((c) => c.error)
      expect(errorChunk.error.type).toBe('assistant_error')
      expect(chunks.some((c) => c.choices?.[0]?.finish_reason === 'stop')).toBe(false)
    })
  })

  describe('client disconnect', () => {
    it('kills the runner when the client aborts a non-streaming request before it completes', async () => {
      const runner = fakeRunner()
      const { app } = appWith(runner)
      const httpServer = http.createServer(app)
      await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
      const { port } = httpServer.address()

      try {
        const body = JSON.stringify({
          sessionId: 's1', projectPath: '/app/workspace/proj', messages: [{ role: 'user', content: 'hi' }],
        })
        const req = http.request({
          host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        })
        req.on('error', () => {})
        req.end(body)

        await waitForPending(runner)
        req.destroy()
        await vi.waitUntil(() => runner.pending[0].kill.mock.calls.length > 0, { timeout: 2000 })
        expect(runner.pending[0].kill).toHaveBeenCalled()
      } finally {
        httpServer.close()
      }
    })
  })
})
