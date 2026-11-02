import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createClaudeCliRunner } from '../src/claudeCliRunner.js'

function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new PassThrough()
  vi.spyOn(child.stdin, 'write')
  vi.spyOn(child.stdin, 'end')
  child.kill = vi.fn()
  return child
}

function resultLine(overrides = {}) {
  return (
    JSON.stringify({
      type: 'result',
      result: 'Hi there!',
      usage: { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      session_id: 'session-uuid-1',
      is_error: false,
      stop_reason: 'end_turn',
      subtype: 'success',
      total_cost_usd: 0.01,
      ...overrides,
    }) + '\n'
  )
}

function deltaLine(text) {
  return (
    JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    }) + '\n'
  )
}

function messageStartLine(model) {
  return (
    JSON.stringify({
      type: 'stream_event',
      event: { type: 'message_start', message: { model, role: 'assistant', content: [] } },
    }) + '\n'
  )
}

describe('createClaudeCliRunner', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('spawns claude in print/stream-json mode with a fresh --session-id when none is given', () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => child)
    const runner = createClaudeCliRunner(spawnFn)

    runner.runTurn({ content: 'hello', projectPath: '/app/workspace/proj' })

    expect(spawnFn).toHaveBeenCalledTimes(1)
    const [cmd, args, opts] = spawnFn.mock.calls[0]
    expect(cmd).toBe('claude')
    expect(args).toEqual(
      expect.arrayContaining([
        '-p',
        '--output-format',
        'stream-json',
        '--include-partial-messages',
        '--verbose',
        '--permission-prompts',
        'none',
        '--session-id',
      ])
    )
    expect(args).not.toContain('--resume')
    const sessionIdIndex = args.indexOf('--session-id') + 1
    expect(args[sessionIdIndex]).toMatch(/^[0-9a-f-]{36}$/)
    expect(opts.cwd).toBe('/app/workspace/proj')
  })

  it('returns the --session-id it generated synchronously, before the turn settles', () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => child)
    const runner = createClaudeCliRunner(spawnFn)

    const { claudeSessionId } = runner.runTurn({ content: 'hello', projectPath: '/app/workspace/proj' })
    expect(claudeSessionId).toMatch(/^[0-9a-f-]{36}$/)

    const [, args] = spawnFn.mock.calls[0]
    expect(args[args.indexOf('--session-id') + 1]).toBe(claudeSessionId)
  })

  it('writes the content to stdin and closes it', () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => child)
    const runner = createClaudeCliRunner(spawnFn)

    runner.runTurn({ content: 'hello there', projectPath: '/app/workspace/proj' })

    expect(child.stdin.write).toHaveBeenCalledWith('hello there')
    expect(child.stdin.end).toHaveBeenCalled()
  })

  it('resumes an existing claude session with --resume instead of --session-id', () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => child)
    const runner = createClaudeCliRunner(spawnFn)

    runner.runTurn({ content: 'again', projectPath: '/app/workspace/proj', claudeSessionId: 'existing-uuid' })

    const [, args] = spawnFn.mock.calls[0]
    expect(args).not.toContain('--session-id')
    const resumeIndex = args.indexOf('--resume')
    expect(resumeIndex).toBeGreaterThan(-1)
    expect(args[resumeIndex + 1]).toBe('existing-uuid')
  })

  it('passes --model when a model is given', () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => child)
    const runner = createClaudeCliRunner(spawnFn)

    runner.runTurn({ content: 'hi', projectPath: '/app/workspace/proj', model: 'opus' })

    const [, args] = spawnFn.mock.calls[0]
    const modelIndex = args.indexOf('--model')
    expect(modelIndex).toBeGreaterThan(-1)
    expect(args[modelIndex + 1]).toBe('opus')
  })

  it('passes --append-system-prompt when a systemPrompt is given', () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => child)
    const runner = createClaudeCliRunner(spawnFn)

    runner.runTurn({ content: 'hi', projectPath: '/app/workspace/proj', systemPrompt: 'Be terse.' })

    const [, args] = spawnFn.mock.calls[0]
    const index = args.indexOf('--append-system-prompt')
    expect(index).toBeGreaterThan(-1)
    expect(args[index + 1]).toBe('Be terse.')
  })

  it('emits each text_delta to onDelta, in order', async () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => child)
    const runner = createClaudeCliRunner(spawnFn)
    const onDelta = vi.fn()

    const { promise } = runner.runTurn({ content: 'hi', projectPath: '/app/workspace/proj', onDelta })
    child.stdout.emit('data', deltaLine('Hi ') + deltaLine('there!'))
    child.stdout.emit('data', resultLine())
    await promise

    expect(onDelta.mock.calls).toEqual([['Hi '], ['there!']])
  })

  it('buffers a stdout line that arrives split across two data events', async () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => child)
    const runner = createClaudeCliRunner(spawnFn)
    const onDelta = vi.fn()

    const { promise } = runner.runTurn({ content: 'hi', projectPath: '/app/workspace/proj', onDelta })
    const line = deltaLine('split chunk')
    child.stdout.emit('data', line.slice(0, 10))
    child.stdout.emit('data', line.slice(10))
    child.stdout.emit('data', resultLine())
    await promise

    expect(onDelta).toHaveBeenCalledWith('split chunk')
  })

  it('decodes a multi-byte UTF-8 character correctly even when split across chunk boundaries', async () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => child)
    const runner = createClaudeCliRunner(spawnFn)
    const onDelta = vi.fn()

    const { promise } = runner.runTurn({ content: 'hi', projectPath: '/app/workspace/proj', onDelta })
    const lineBuf = Buffer.from(deltaLine('🎉🎉'), 'utf8')
    // Split mid-way through the multi-byte emoji sequence, not on a line boundary.
    const splitAt = Math.floor(lineBuf.length / 2)
    child.stdout.write(lineBuf.subarray(0, splitAt))
    child.stdout.write(lineBuf.subarray(splitAt))
    child.stdout.write(Buffer.from(resultLine(), 'utf8'))
    await promise

    expect(onDelta).toHaveBeenCalledWith('🎉🎉')
  })

  it('resolves with text, usage, claudeSessionId, stopReason once the result line arrives', async () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => child)
    const runner = createClaudeCliRunner(spawnFn)

    const { promise } = runner.runTurn({ content: 'hi', projectPath: '/app/workspace/proj' })
    child.stdout.emit('data', resultLine())
    const outcome = await promise

    expect(outcome).toEqual({
      text: 'Hi there!',
      usage: { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      totalCostUsd: 0.01,
      claudeSessionId: 'session-uuid-1',
      isError: false,
      stopReason: 'end_turn',
      subtype: 'success',
      model: null,
    })
  })

  it('resolves with the real serving model captured from a message_start event', async () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => child)
    const runner = createClaudeCliRunner(spawnFn)

    const { promise } = runner.runTurn({ content: 'hi', projectPath: '/app/workspace/proj' })
    child.stdout.emit('data', messageStartLine('claude-opus-5-5'))
    child.stdout.emit('data', resultLine())
    const outcome = await promise

    expect(outcome.model).toBe('claude-opus-5-5')
  })

  it('resolves with isError true when the result line reports an error', async () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => child)
    const runner = createClaudeCliRunner(spawnFn)

    const { promise } = runner.runTurn({ content: 'hi', projectPath: '/app/workspace/proj' })
    child.stdout.emit('data', resultLine({ is_error: true, subtype: 'error_during_execution', result: 'boom' }))
    const outcome = await promise

    expect(outcome.isError).toBe(true)
    expect(outcome.subtype).toBe('error_during_execution')
  })

  it('rejects when the child process errors before producing a result', async () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => child)
    const runner = createClaudeCliRunner(spawnFn)

    const { promise } = runner.runTurn({ content: 'hi', projectPath: '/app/workspace/proj' })
    const assertion = expect(promise).rejects.toThrow('spawn failed')
    child.emit('error', new Error('spawn failed'))
    await assertion
  })

  it('rejects when the process exits non-zero without ever producing a result', async () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => child)
    const runner = createClaudeCliRunner(spawnFn)

    const { promise } = runner.runTurn({ content: 'hi', projectPath: '/app/workspace/proj' })
    const assertion = expect(promise).rejects.toThrow(/exited with code 1/)
    child.stderr.emit('data', 'No conversation found with session ID: bogus')
    child.emit('close', 1)
    await assertion
  })

  it('resolves from a final result line that has no trailing newline', async () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => child)
    const runner = createClaudeCliRunner(spawnFn)

    const { promise } = runner.runTurn({ content: 'hi', projectPath: '/app/workspace/proj' })
    // No '\n' after this line — it stays in the internal buffer until 'close'.
    child.stdout.emit('data', JSON.stringify({ type: 'result', result: 'OK', session_id: 's1', is_error: false }))
    child.emit('close', 0)
    const outcome = await promise

    expect(outcome.text).toBe('OK')
  })

  it('ignores a close event that arrives after the result line already settled the promise', async () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => child)
    const runner = createClaudeCliRunner(spawnFn)

    const { promise } = runner.runTurn({ content: 'hi', projectPath: '/app/workspace/proj' })
    child.stdout.emit('data', resultLine())
    await promise
    expect(() => child.emit('close', 0)).not.toThrow()
  })

  it('does not throw when spawnFn itself throws synchronously, and the promise rejects instead', async () => {
    const spawnFn = vi.fn(() => {
      throw new Error('spawn ENOENT')
    })
    const runner = createClaudeCliRunner(spawnFn)

    let outcome
    expect(() => {
      outcome = runner.runTurn({ content: 'hi', projectPath: '/app/workspace/proj' })
    }).not.toThrow()
    await expect(outcome.promise).rejects.toThrow('spawn ENOENT')
    expect(outcome.kill).toBeTypeOf('function')
    expect(() => outcome.kill()).not.toThrow()
  })

  it('does not crash when the stdin write fails with EPIPE after the child has already died', async () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => child)
    const runner = createClaudeCliRunner(spawnFn)

    const { promise } = runner.runTurn({ content: 'hi', projectPath: '/app/workspace/proj' })
    const epipe = new Error('write EPIPE')
    epipe.code = 'EPIPE'
    expect(() => child.stdin.emit('error', epipe)).not.toThrow()

    child.emit('close', 1)
    await expect(promise).rejects.toThrow(/exited with code 1/)
  })

  it('kill() kills the underlying child process when it has no real pid (test double)', () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => child)
    const runner = createClaudeCliRunner(spawnFn)

    const { kill } = runner.runTurn({ content: 'hi', projectPath: '/app/workspace/proj' })
    kill()

    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('kill() signals the whole process group when the child has a real pid', () => {
    const child = fakeChild()
    child.pid = 4242
    const spawnFn = vi.fn(() => child)
    const runner = createClaudeCliRunner(spawnFn)
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)

    const { kill } = runner.runTurn({ content: 'hi', projectPath: '/app/workspace/proj' })
    kill()

    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM')
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('escalates to SIGKILL if the process has not exited after the grace period', async () => {
    const child = fakeChild()
    child.pid = 4242
    const spawnFn = vi.fn(() => child)
    const runner = createClaudeCliRunner(spawnFn, { killGraceMs: 20 })
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)

    const { kill } = runner.runTurn({ content: 'hi', projectPath: '/app/workspace/proj' })
    kill()
    await new Promise((resolve) => setTimeout(resolve, 60))

    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM')
    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGKILL')
  })

  it('does not escalate to SIGKILL if the process already exited before the grace period', async () => {
    const child = fakeChild()
    child.pid = 4242
    const spawnFn = vi.fn(() => child)
    const runner = createClaudeCliRunner(spawnFn, { killGraceMs: 20 })
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)

    const { promise, kill } = runner.runTurn({ content: 'hi', projectPath: '/app/workspace/proj' })
    promise.catch(() => {})
    kill()
    child.emit('close', 0)
    await new Promise((resolve) => setTimeout(resolve, 60))

    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM')
    expect(killSpy).not.toHaveBeenCalledWith(-4242, 'SIGKILL')
  })
})
