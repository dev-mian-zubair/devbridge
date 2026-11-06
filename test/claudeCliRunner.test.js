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

function toolUseStartLine(index, id, name) {
  return JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } } }) + '\n'
}
function inputJsonDeltaLine(index, partialJson) {
  return JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: partialJson } } }) + '\n'
}
function toolUseMessageDeltaLine(usage) {
  return JSON.stringify({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage } }) + '\n'
}

describe('createClaudeCliRunner', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('spawns claude in print/stream-json mode', () => {
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
      ])
    )
    expect(opts.cwd).toBe('/app/workspace/proj')
  })

  it('never passes --session-id or --resume (continuity comes from full-history replay)', () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => child)
    const runner = createClaudeCliRunner(spawnFn)
    runner.runTurn({ content: 'hello', projectPath: '/app/workspace/proj' })
    const [, args] = spawnFn.mock.calls[0]
    expect(args).not.toContain('--session-id')
    expect(args).not.toContain('--resume')
  })

  it('passes --mcp-config/--strict-mcp-config/--allowedTools from the injected bridge when tools are given', () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => child)
    const fakeCreateMcpBridge = vi.fn(() => ({ mcpConfigPath: '/tmp/fake/mcp-config.json', allowedToolNames: ['mcp__client-tools__get_weather'], cleanup: vi.fn() }))
    const runner = createClaudeCliRunner(spawnFn, { createMcpBridge: fakeCreateMcpBridge })
    const tools = [{ type: 'function', function: { name: 'get_weather', parameters: {} } }]
    runner.runTurn({ content: 'hi', projectPath: '/app/workspace/proj', tools })
    const [, args] = spawnFn.mock.calls[0]
    expect(args).toContain('--strict-mcp-config')
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('/tmp/fake/mcp-config.json')
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('mcp__client-tools__get_weather')
  })

  it('does not pass mcp args when no tools are given', () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => child)
    const runner = createClaudeCliRunner(spawnFn)
    runner.runTurn({ content: 'hi', projectPath: '/app/workspace/proj' })
    const [, args] = spawnFn.mock.calls[0]
    expect(args).not.toContain('--mcp-config')
    expect(args).not.toContain('--strict-mcp-config')
    expect(args).not.toContain('--allowedTools')
  })

  it('builds the mcp config via the injected createMcpBridge and calls its cleanup once the process closes', async () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => child)
    const cleanup = vi.fn()
    const fakeCreateMcpBridge = vi.fn(() => ({ mcpConfigPath: '/tmp/fake/mcp-config.json', allowedToolNames: ['mcp__client-tools__get_weather'], cleanup }))
    const runner = createClaudeCliRunner(spawnFn, { createMcpBridge: fakeCreateMcpBridge })
    const tools = [{ type: 'function', function: { name: 'get_weather', parameters: {} } }]

    const { promise } = runner.runTurn({ content: 'hi', projectPath: '/app/workspace/proj', tools })
    promise.catch(() => {})

    expect(fakeCreateMcpBridge).toHaveBeenCalledWith(tools)
    const [, args] = spawnFn.mock.calls[0]
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('/tmp/fake/mcp-config.json')
    expect(cleanup).not.toHaveBeenCalled()

    child.emit('close', 0)
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('always disallows the entire built-in tool set, not just Task (coding mode no longer exists)', () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => child)
    const runner = createClaudeCliRunner(spawnFn)
    runner.runTurn({ content: 'hi', projectPath: '/app/workspace/proj' })
    const [, args] = spawnFn.mock.calls[0]
    const idx = args.indexOf('--disallowedTools')
    expect(idx).toBeGreaterThan(-1)
    const names = args.slice(idx + 1)
    const expected = [
      'Task', 'Bash', 'CronCreate', 'CronDelete', 'CronList', 'DesignSync', 'Edit',
      'EnterWorktree', 'ExitWorktree', 'ListAgents', 'Monitor', 'NotebookEdit',
      'PushNotification', 'Read', 'RemoteTrigger', 'ReportFindings', 'ScheduleWakeup',
      'SendMessage', 'Skill', 'TaskStop', 'ToolSearch', 'WebFetch', 'WebSearch', 'Workflow', 'Write',
    ]
    expect(new Set(names)).toEqual(new Set(expected))
  })

  it('passes the full disallow list even with no tools given', () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => child)
    const runner = createClaudeCliRunner(spawnFn)
    runner.runTurn({ content: 'hi', projectPath: '/app/workspace/proj' })
    const [, args] = spawnFn.mock.calls[0]
    expect(args).toContain('--disallowedTools')
    expect(args).toContain('Bash')
  })

  it('with tools given, the full disallow list already covers Task, no duplicate --disallowedTools flag', () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => child)
    const fakeCreateMcpBridge = vi.fn(() => ({ mcpConfigPath: '/tmp/fake/mcp-config.json', allowedToolNames: ['mcp__client-tools__get_weather'], cleanup: vi.fn() }))
    const runner = createClaudeCliRunner(spawnFn, { createMcpBridge: fakeCreateMcpBridge })
    const tools = [{ type: 'function', function: { name: 'get_weather', parameters: {} } }]
    runner.runTurn({ content: 'hi', projectPath: '/app/workspace/proj', tools })
    const [, args] = spawnFn.mock.calls[0]
    expect(args.filter((a) => a === '--disallowedTools')).toHaveLength(1)
    const idx = args.indexOf('--disallowedTools')
    expect(args.slice(idx + 1)).toContain('Task')
  })

  it('always injects the corrective system prompt, combined with a client-supplied one', () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => child)
    const runner = createClaudeCliRunner(spawnFn)
    runner.runTurn({ content: 'hi', projectPath: '/app/workspace/proj', systemPrompt: 'Be terse.' })
    const [, args] = spawnFn.mock.calls[0]
    const value = args[args.indexOf('--append-system-prompt') + 1]
    expect(value).toContain('not as Claude Code')
    expect(value).toContain('Be terse.')
  })

  it('ignores agentMode entirely, even "coding", if a caller passes it directly (guarantee holds at the runner level too)', () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => child)
    const runner = createClaudeCliRunner(spawnFn)
    runner.runTurn({ content: 'hi', projectPath: '/app/workspace/proj', systemPrompt: 'Be terse.', agentMode: 'coding' })
    const [, args] = spawnFn.mock.calls[0]
    expect(args).toContain('--disallowedTools')
    expect(args).toContain('Bash')
    const value = args[args.indexOf('--append-system-prompt') + 1]
    expect(value).toContain('not as Claude Code')
    expect(value).toContain('Be terse.')
  })

  it('injects the corrective system prompt alone when no client systemPrompt is given', () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => child)
    const runner = createClaudeCliRunner(spawnFn)
    runner.runTurn({ content: 'hi', projectPath: '/app/workspace/proj' })
    const [, args] = spawnFn.mock.calls[0]
    const value = args[args.indexOf('--append-system-prompt') + 1]
    expect(value).toContain('not as Claude Code')
  })

  it('requireToolUse appends a "must call a tool" instruction to the system prompt', () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => child)
    const fakeCreateMcpBridge = vi.fn(() => ({ mcpConfigPath: '/tmp/fake/mcp-config.json', allowedToolNames: ['mcp__client-tools__get_weather'], cleanup: vi.fn() }))
    const runner = createClaudeCliRunner(spawnFn, { createMcpBridge: fakeCreateMcpBridge })
    const tools = [{ type: 'function', function: { name: 'get_weather', parameters: {} } }]
    runner.runTurn({ content: 'hi', projectPath: '/app/workspace/proj', tools, requireToolUse: true })
    const [, args] = spawnFn.mock.calls[0]
    const value = args[args.indexOf('--append-system-prompt') + 1]
    expect(value).toContain('must call')
  })

  it('forcedToolName narrows --allowedTools to just that one tool', () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => child)
    const fakeCreateMcpBridge = vi.fn(() => ({
      mcpConfigPath: '/tmp/fake/mcp-config.json',
      allowedToolNames: ['mcp__client-tools__get_weather', 'mcp__client-tools__get_time'],
      cleanup: vi.fn(),
    }))
    const runner = createClaudeCliRunner(spawnFn, { createMcpBridge: fakeCreateMcpBridge })
    const tools = [
      { type: 'function', function: { name: 'get_weather', parameters: {} } },
      { type: 'function', function: { name: 'get_time', parameters: {} } },
    ]
    runner.runTurn({ content: 'hi', projectPath: '/app/workspace/proj', tools, requireToolUse: true, forcedToolName: 'get_time' })
    const [, args] = spawnFn.mock.calls[0]
    const idx = args.indexOf('--allowedTools')
    expect(args[idx + 1]).toBe('mcp__client-tools__get_time')
    expect(args[idx + 2]).not.toBe('mcp__client-tools__get_weather')
    const promptValue = args[args.indexOf('--append-system-prompt') + 1]
    expect(promptValue).toContain('get_time')
  })

  it('writes the content to stdin and closes it', () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => child)
    const runner = createClaudeCliRunner(spawnFn)

    runner.runTurn({ content: 'hello there', projectPath: '/app/workspace/proj' })

    expect(child.stdin.write).toHaveBeenCalledWith('hello there')
    expect(child.stdin.end).toHaveBeenCalled()
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

  it('passes --effort when an effort level is given', () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => child)
    const runner = createClaudeCliRunner(spawnFn)

    runner.runTurn({ content: 'hi', projectPath: '/app/workspace/proj', effort: 'high' })

    const [, args] = spawnFn.mock.calls[0]
    const index = args.indexOf('--effort')
    expect(index).toBeGreaterThan(-1)
    expect(args[index + 1]).toBe('high')
  })

  it('passes --json-schema as a JSON string when a jsonSchema is given', () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => child)
    const runner = createClaudeCliRunner(spawnFn)
    const schema = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }

    runner.runTurn({ content: 'hi', projectPath: '/app/workspace/proj', jsonSchema: schema })

    const [, args] = spawnFn.mock.calls[0]
    const index = args.indexOf('--json-schema')
    expect(index).toBeGreaterThan(-1)
    expect(JSON.parse(args[index + 1])).toEqual(schema)
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

  it('resolves with toolCalls accumulated from an MCP-prefixed tool_use block, and kills the process', async () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => child)
    const runner = createClaudeCliRunner(spawnFn)
    const { promise } = runner.runTurn({ content: 'hi', projectPath: '/app/workspace/proj' })

    child.stdout.emit('data', messageStartLine('claude-sonnet-5'))
    child.stdout.emit('data', toolUseStartLine(0, 'toolu_1', 'mcp__client-tools__get_weather'))
    child.stdout.emit('data', inputJsonDeltaLine(0, ''))
    child.stdout.emit('data', inputJsonDeltaLine(0, '{"location":"Paris"}'))
    const usage = { input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    child.stdout.emit('data', toolUseMessageDeltaLine(usage))
    const outcome = await promise

    expect(outcome.toolCalls).toEqual([{ index: 0, id: 'toolu_1', name: 'get_weather', arguments: '{"location":"Paris"}' }])
    expect(outcome.stopReason).toBe('tool_use')
    expect(outcome.usage).toEqual(usage)
    expect(outcome.isError).toBe(false)
  })

  it('preserves preamble text alongside tool_calls, not just in streaming (security review #6)', async () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => child)
    const runner = createClaudeCliRunner(spawnFn)
    const { promise } = runner.runTurn({ content: 'hi', projectPath: '/app/workspace/proj' })

    child.stdout.emit('data', messageStartLine('claude-sonnet-5'))
    child.stdout.emit('data', deltaLine('Let me check '))
    child.stdout.emit('data', deltaLine('the weather.'))
    child.stdout.emit('data', toolUseStartLine(1, 'toolu_1', 'mcp__client-tools__get_weather'))
    child.stdout.emit('data', inputJsonDeltaLine(1, '{"location":"Paris"}'))
    child.stdout.emit('data', toolUseMessageDeltaLine({}))
    const outcome = await promise

    expect(outcome.text).toBe('Let me check the weather.')
  })

  it('truncates text at the first stop sequence match, kills the process, and resolves with stopReason stop_sequence', async () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => child)
    const runner = createClaudeCliRunner(spawnFn)
    const { promise } = runner.runTurn({ content: 'hi', projectPath: '/app/workspace/proj', stopSequences: ['STOP'] })

    child.stdout.emit('data', deltaLine('Hello STOP world'))
    const outcome = await promise

    expect(outcome.text).toBe('Hello ')
    expect(outcome.stopReason).toBe('stop_sequence')
    expect(outcome.isError).toBe(false)
  })

  it('does not truncate or resolve early when no stop sequence matches', async () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => child)
    const runner = createClaudeCliRunner(spawnFn)
    const { promise } = runner.runTurn({ content: 'hi', projectPath: '/app/workspace/proj', stopSequences: ['STOP'] })

    child.stdout.emit('data', deltaLine('Hello world, no match here.'))
    child.stdout.emit('data', resultLine({ result: 'Hello world, no match here.' }))
    const outcome = await promise

    expect(outcome.text).toBe('Hello world, no match here.')
    expect(outcome.stopReason).toBe('end_turn')
  })

  it('detects a stop sequence that only completes across two chunks', async () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => child)
    const runner = createClaudeCliRunner(spawnFn)
    const onDelta = vi.fn()
    const { promise } = runner.runTurn({ content: 'hi', projectPath: '/app/workspace/proj', stopSequences: ['STOP'], onDelta })

    child.stdout.emit('data', deltaLine('Hello ST'))
    child.stdout.emit('data', deltaLine('OP world'))
    const outcome = await promise

    expect(outcome.text).toBe('Hello ')
    // Documented, accepted limitation: the "ST" fragment was already flushed
    // via onDelta before the match completed in the next chunk — a
    // streaming client sees it, even though the final (non-streaming)
    // outcome.text is correctly truncated.
    expect(onDelta.mock.calls[0]).toEqual(['Hello ST'])
    expect(onDelta).toHaveBeenCalledTimes(1)
  })

  it('resolves at the earliest-matching stop sequence when multiple are given', async () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => child)
    const runner = createClaudeCliRunner(spawnFn)
    const { promise } = runner.runTurn({ content: 'hi', projectPath: '/app/workspace/proj', stopSequences: ['BB', 'A'] })

    child.stdout.emit('data', deltaLine('xxAxxBByyy'))
    const outcome = await promise

    expect(outcome.text).toBe('xx')
  })

  it('reports tool_calls index as a 0-based ordinal among MCP blocks, not the raw Anthropic content-block index (security review #2)', async () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => child)
    const runner = createClaudeCliRunner(spawnFn)
    const onToolCallDelta = vi.fn()
    const { promise } = runner.runTurn({ content: 'hi', projectPath: '/app/workspace/proj', onToolCallDelta })

    // A text block occupies index 0 (model wrote "Let me check." before
    // calling tools); the two MCP tool calls land at raw indices 1 and 2.
    child.stdout.emit('data', toolUseStartLine(1, 'toolu_1', 'mcp__client-tools__get_weather'))
    child.stdout.emit('data', inputJsonDeltaLine(1, '{"location":"Paris"}'))
    child.stdout.emit('data', toolUseStartLine(2, 'toolu_2', 'mcp__client-tools__get_time'))
    child.stdout.emit('data', inputJsonDeltaLine(2, '{"tz":"UTC"}'))
    child.stdout.emit('data', toolUseMessageDeltaLine({}))
    const outcome = await promise

    expect(outcome.toolCalls).toEqual([
      { index: 0, id: 'toolu_1', name: 'get_weather', arguments: '{"location":"Paris"}' },
      { index: 1, id: 'toolu_2', name: 'get_time', arguments: '{"tz":"UTC"}' },
    ])
    expect(onToolCallDelta.mock.calls[0][0]).toMatchObject({ index: 0, id: 'toolu_1' })
    expect(onToolCallDelta.mock.calls[2][0]).toMatchObject({ index: 1, id: 'toolu_2' })
  })

  it('calls onToolCallDelta for each fragment, keyed by index, with id/name only on the first call', async () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => child)
    const runner = createClaudeCliRunner(spawnFn)
    const onToolCallDelta = vi.fn()
    const { promise } = runner.runTurn({ content: 'hi', projectPath: '/app/workspace/proj', onToolCallDelta })

    child.stdout.emit('data', toolUseStartLine(0, 'toolu_1', 'mcp__client-tools__get_weather'))
    child.stdout.emit('data', inputJsonDeltaLine(0, '{"location":"Paris"}'))
    child.stdout.emit('data', toolUseMessageDeltaLine({}))
    await promise

    expect(onToolCallDelta.mock.calls).toEqual([
      [{ index: 0, id: 'toolu_1', name: 'get_weather', argumentsFragment: '' }],
      [{ index: 0, argumentsFragment: '{"location":"Paris"}' }],
    ])
  })

  it('does not intercept a CLI-native tool_use block (no mcp__ prefix)', async () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => child)
    const runner = createClaudeCliRunner(spawnFn)
    const onToolCallDelta = vi.fn()
    const { promise } = runner.runTurn({ content: 'hi', projectPath: '/app/workspace/proj', onToolCallDelta })

    child.stdout.emit('data', toolUseStartLine(0, 'toolu_native', 'Bash'))
    child.stdout.emit('data', inputJsonDeltaLine(0, '{"command":"ls"}'))
    // A native call does not stop the turn for us; the CLI's own loop
    // continues and eventually produces a normal result.
    child.stdout.emit('data', resultLine())
    const outcome = await promise

    expect(onToolCallDelta).not.toHaveBeenCalled()
    expect(outcome.toolCalls).toBeFalsy()
  })

  it('resets accumulated blocks on message_start, so only the last message before the stop is reported (Review Focus)', async () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => child)
    const runner = createClaudeCliRunner(spawnFn)
    const { promise } = runner.runTurn({ content: 'hi', projectPath: '/app/workspace/proj' })

    // First message: a native call only — must not leak into the final toolCalls.
    child.stdout.emit('data', messageStartLine('claude-sonnet-5'))
    child.stdout.emit('data', toolUseStartLine(0, 'toolu_native', 'Bash'))
    child.stdout.emit('data', inputJsonDeltaLine(0, '{}'))
    // Second message: the client tool call that actually stops the turn.
    child.stdout.emit('data', messageStartLine('claude-sonnet-5'))
    child.stdout.emit('data', toolUseStartLine(0, 'toolu_mcp', 'mcp__client-tools__get_weather'))
    child.stdout.emit('data', inputJsonDeltaLine(0, '{"location":"Paris"}'))
    child.stdout.emit('data', toolUseMessageDeltaLine({}))
    const outcome = await promise

    expect(outcome.toolCalls).toEqual([{ index: 0, id: 'toolu_mcp', name: 'get_weather', arguments: '{"location":"Paris"}' }])
  })

  it('actually clears a dangling MCP block from a prior message on message_start (not just a native one — review found the above test a vacuous check of this)', async () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => child)
    const runner = createClaudeCliRunner(spawnFn)
    const { promise } = runner.runTurn({ content: 'hi', projectPath: '/app/workspace/proj' })

    // First message: a real MCP block is opened but this message never gets
    // its own tool_use stop (the exact case the reset must cover — a
    // leftover entry in currentBlocks from a message that's already done).
    child.stdout.emit('data', messageStartLine('claude-sonnet-5'))
    child.stdout.emit('data', toolUseStartLine(1, 'toolu_leftover', 'mcp__client-tools__stale_call'))
    child.stdout.emit('data', inputJsonDeltaLine(1, '{"x":1}'))
    // Second message: a different MCP block that does stop the turn. If the
    // reset didn't clear the first message's entry, this would resolve with
    // two tool calls instead of one.
    child.stdout.emit('data', messageStartLine('claude-sonnet-5'))
    child.stdout.emit('data', toolUseStartLine(0, 'toolu_mcp', 'mcp__client-tools__get_weather'))
    child.stdout.emit('data', inputJsonDeltaLine(0, '{"location":"Paris"}'))
    child.stdout.emit('data', toolUseMessageDeltaLine({}))
    const outcome = await promise

    expect(outcome.toolCalls).toEqual([{ index: 0, id: 'toolu_mcp', name: 'get_weather', arguments: '{"location":"Paris"}' }])
  })

  it('a message_delta tool_use stop with zero accumulated mcp blocks does not resolve the turn', async () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => child)
    const runner = createClaudeCliRunner(spawnFn)
    const { promise } = runner.runTurn({ content: 'hi', projectPath: '/app/workspace/proj' })

    child.stdout.emit('data', toolUseStartLine(0, 'toolu_native', 'Bash'))
    child.stdout.emit('data', inputJsonDeltaLine(0, '{}'))
    child.stdout.emit('data', toolUseMessageDeltaLine({})) // native-only stop — must not settle the promise
    child.stdout.emit('data', resultLine({ result: 'done after native tool' }))
    const outcome = await promise

    expect(outcome.text).toBe('done after native tool')
    expect(outcome.toolCalls).toBeFalsy()
  })
})
