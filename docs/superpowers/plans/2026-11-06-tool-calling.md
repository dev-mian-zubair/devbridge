# OpenAI Tool Calling via MCP Bridge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/v1/chat/completions` support real OpenAI-style `tools`/`tool_choice`, with the client executing its own tools, by bridging client-declared tools through a per-request stub MCP server and intercepting the CLI's tool-call proposal before it ever reaches that stub's handler — while switching every chat-completions request (tool-calling or not) to full-history replay and dropping `--resume`/`--session-id` entirely.

**Architecture:** A new `historySerializer.js` renders the full OpenAI `messages` array (including `tool_calls`/`tool` results) into the `-p` call's stdin prompt. A new `mcpBridge.js` + `mcpStubServer.mjs` generate a per-request MCP server (via `--mcp-config`) that reports the client's real tool schemas but whose handler is never meant to run. `claudeCliRunner.js` watches the CLI's own `stream-json` events for a tool_use block whose name is MCP-prefixed, accumulates its arguments, and kills the process the instant the model's turn stops for a tool call — before the CLI would ever dispatch to that stub. `chatCompletions.js` wires it all into OpenAI-shaped `tool_calls` responses, streaming and non-streaming.

**Tech Stack:** Node.js, Express, `child_process.spawn`, `@modelcontextprotocol/sdk` (new dependency, low-level `Server`/`StdioServerTransport`), Vitest.

**Spec:** `docs/superpowers/specs/2026-11-06-tool-calling-design.md`

## Global Constraints

- Node.js/Express, `child_process.spawn` (no PTY) for the chat-completions path — unchanged.
- CLI invocation stays `-p --output-format stream-json --include-partial-messages --verbose --permission-prompts none`, now **without** `--resume`/`--session-id` — continuity comes entirely from replaying full history.
- Any tools-bearing turn adds `--mcp-config <path> --strict-mcp-config --allowedTools <names...>`.
- A client-declared tool call is identified *only* by `content_block.name` starting with `mcp__client-tools__` (the fixed `MCP_SERVER_NAME` this project defines). Every other tool_use block (Bash, Edit, ToolSearch, ...) is CLI-native and must never be translated or intercepted.
- The SIGTERM-on-`stop_reason:"tool_use"` interception is spike-confirmed safe (5/5 trials, real margin over the CLI's own dispatch) — implement it as the first reaction to that event, with no added delay.
- `message_delta.usage` is the usage source for a tool_use-terminated turn; `result.usage` remains the source for a normal-completion turn. Both map through the existing `mapUsage()`.
- `parallel_tool_calls` stays silently ignored; `functions`/`function_call` stay rejected (400). Neither changes in this plan.
- `tools[].name`/`description`/`parameters` get the same NUL-byte discipline `validateRequest` already applies to `model`/`response_format.json_schema`.

## Review Focus

- `tool_choice: "required"` or a forced named-tool object (`{"type":"function","function":{"name":...}}`) must get a clean 400, not be silently ignored or crash the mapping logic. (Task 5)
- A `messages` history containing a `tool`-role result while the *current* request's `tools` is empty/absent (a client that dropped tool definitions on a later call) must still serialize losslessly — no crash, no silent drop. (Task 1)
- Tool calls proposed across two *separate* assistant messages within one turn (not just two blocks in one message) must report only the last message's accumulated blocks — an earlier message's native-tool round-trip must never resurface as a phantom tool call. (Task 4)
- A `tools[].name`/`description`/`parameters` containing a NUL byte must 400 before it's ever written into the generated MCP config file. (Task 5)
- `stream: true` combined with `tools`: the first SSE chunk for a given tool call must carry `id`/`type`/`function.name` with `arguments: ""`; later chunks for the same `index` carry only an `arguments` fragment — a client keying off the first chunk to learn the tool name must not be broken by a missing or duplicated `name`. (Task 5)

---

## File Structure

| File | Role |
|---|---|
| `src/historySerializer.js` (create) | Pure: OpenAI `messages[]` → the full stdin prompt text, including tool_calls/tool results. Also owns `extractText` (moved out of `chatCompletions.js`). |
| `src/mcpBridge.js` (create) | Per-request MCP server config + stub tool-list generation, and its cleanup. |
| `src/mcpStubServer.mjs` (create) | Static, permanent stdio MCP server process. Reports the client's real tool schemas; its call handler is never meant to run. |
| `src/claudeCliRunner.js` (modify) | Drop `--resume`/`--session-id`; wire `--mcp-config`/`--allowedTools`; intercept and accumulate MCP tool_use blocks; resolve-not-reject on a self-initiated kill. |
| `src/routes/chatCompletions.js` (modify) | Accept `tools`/`tool_choice`; full-history prompt; OpenAI `tool_calls` response shape, streaming and non-streaming. |
| `README.md` (modify) | Compatibility table, `tools`-rejection section, `--resume` continuity section. |
| `package.json` (modify) | Add `@modelcontextprotocol/sdk`. |

---

### Task 1: History serialization

**Files:**
- Create: `src/historySerializer.js`
- Test: `test/historySerializer.test.js`

**Interfaces:**
- Produces: `extractText(content: string | Array<{type, text}> | null | undefined): string | null` (same behavior as the function currently private to `chatCompletions.js`). `serializeHistory(messages: Array<{role, content, tool_calls?, tool_call_id?}>): string`.
- Consumes: nothing — pure, standalone.

**Format `serializeHistory` produces** (one call per message, `system`/`developer` messages skipped — those stay handled via `--append-system-prompt` elsewhere):
- `role: "user"` → `` `User: ${extractText(content)}\n\n` ``
- `role: "assistant"`, no `tool_calls` → `` `Assistant: ${extractText(content)}\n\n` ``
- `role: "assistant"` with `tool_calls` (array) → (if `extractText(content)` is non-empty) `` `Assistant: ${text}\n` ``, then for each entry in `tool_calls`: `` `Assistant called tool "${tc.function.name}" (call_id: ${tc.id}) with arguments: ${tc.function.arguments}\n` ``, then a trailing `\n`.
- `role: "tool"` → `` `Tool result (call_id: ${msg.tool_call_id}): ${extractText(content)}\n\n` ``
- Join all rendered pieces, then trim trailing whitespace from the result.

- [ ] **Step 1: Write the failing tests for `extractText`**

```js
test('extractText returns a plain string as-is', () => {
  expect(extractText('hello')).toBe('hello')
})
test('extractText joins text parts of a content array', () => {
  expect(extractText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('ab')
})
test('extractText returns null for non-string, non-array content', () => {
  expect(extractText(null)).toBeNull()
  expect(extractText(undefined)).toBeNull()
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/historySerializer.test.js`
Expected: FAIL — `historySerializer.js` (and `extractText`) don't exist yet.

- [ ] **Step 3: Implement `extractText` in `src/historySerializer.js`**

Transcribe the existing `extractText` from `src/routes/chatCompletions.js` verbatim (it is not changing behavior, only moving).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/historySerializer.test.js`
Expected: PASS (3/3)

- [ ] **Step 5: Write the failing tests for `serializeHistory`**

```js
test('renders a single user message', () => {
  expect(serializeHistory([{ role: 'user', content: 'hi' }])).toBe('User: hi')
})

test('renders a user/assistant/user exchange in order', () => {
  const messages = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'ack' },
    { role: 'user', content: 'second' },
  ]
  expect(serializeHistory(messages)).toBe('User: first\n\nAssistant: ack\n\nUser: second')
})

test('skips system and developer messages', () => {
  const messages = [
    { role: 'system', content: 'be terse' },
    { role: 'user', content: 'hi' },
  ]
  expect(serializeHistory(messages)).toBe('User: hi')
})

test('renders an assistant tool_calls message followed by its tool result', () => {
  const messages = [
    { role: 'user', content: 'weather in paris?' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"location":"Paris"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'sunny, 22C' },
  ]
  expect(serializeHistory(messages)).toBe(
    'User: weather in paris?\n\n' +
    'Assistant called tool "get_weather" (call_id: call_1) with arguments: {"location":"Paris"}\n\n' +
    'Tool result (call_id: call_1): sunny, 22C'
  )
})

test('renders an assistant message that has both text and a tool call', () => {
  const messages = [{
    role: 'assistant',
    content: 'Let me check.',
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }],
  }]
  expect(serializeHistory(messages)).toBe(
    'Assistant: Let me check.\nAssistant called tool "get_weather" (call_id: call_1) with arguments: {}'
  )
})

test('renders a tool result even when the current call has no tools declared (Review Focus)', () => {
  const messages = [
    { role: 'user', content: 'hi' },
    { role: 'tool', tool_call_id: 'call_orphan', content: 'some result' },
  ]
  expect(() => serializeHistory(messages)).not.toThrow()
  expect(serializeHistory(messages)).toContain('Tool result (call_id: call_orphan): some result')
})
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run test/historySerializer.test.js`
Expected: FAIL — `serializeHistory` not defined.

- [ ] **Step 7: Implement `serializeHistory` in `src/historySerializer.js`** per the format above.

- [ ] **Step 8: Run to verify it passes**

Run: `npx vitest run test/historySerializer.test.js`
Expected: PASS (9/9)

- [ ] **Step 9: Commit**

```bash
git add src/historySerializer.js test/historySerializer.test.js
git commit -m "feat: serialize full OpenAI message history into the CLI prompt"
```

---

### Task 2: MCP stub server + per-request bridge

**Files:**
- Create: `src/mcpStubServer.mjs`
- Create: `src/mcpBridge.js`
- Test: `test/mcpStubServer.test.js`
- Test: `test/mcpBridge.test.js`
- Modify: `package.json` (add `@modelcontextprotocol/sdk`)

**Interfaces:**
- Produces: `mcpStubServer.mjs` exports `loadToolsConfig(path: string): Array<{name, description, parameters}>` and `buildToolsListResponse(toolsConfig): { tools: Array<{name, description, inputSchema}> }` (pure helpers; the file also runs as a real stdio MCP server when executed directly — that wiring is not separately unit-tested, it is the part already confirmed by the design's spike). `mcpBridge.js` exports `MCP_SERVER_NAME = 'client-tools'` and `createMcpBridge(tools: Array<{type:'function', function:{name, description?, parameters?}}>, fsOverrides?): { mcpConfigPath: string, allowedToolNames: string[], cleanup(): void }`.
- Consumes: nothing from elsewhere in the codebase (tools array is already-validated OpenAI shape, validated by Task 5's caller).

- [ ] **Step 1: Add the dependency**

```bash
npm install @modelcontextprotocol/sdk
```

- [ ] **Step 2: Write the failing tests for `mcpStubServer.mjs`'s pure helpers**

```js
test('loadToolsConfig reads and parses the JSON file at the given path', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'mcp-stub-test-'))
  const file = path.join(tmp, 'tools.json')
  writeFileSync(file, JSON.stringify([{ name: 'get_weather', description: 'd', parameters: { type: 'object' } }]))
  expect(loadToolsConfig(file)).toEqual([{ name: 'get_weather', description: 'd', parameters: { type: 'object' } }])
})

test('buildToolsListResponse maps each tool to an MCP tool entry with its real schema', () => {
  const response = buildToolsListResponse([{ name: 'get_weather', description: 'd', parameters: { type: 'object', properties: { location: { type: 'string' } } } }])
  expect(response).toEqual({
    tools: [{ name: 'get_weather', description: 'd', inputSchema: { type: 'object', properties: { location: { type: 'string' } } } }],
  })
})

test('buildToolsListResponse defaults a missing parameters to an empty object schema', () => {
  const response = buildToolsListResponse([{ name: 'ping', description: '' }])
  expect(response.tools[0].inputSchema).toEqual({ type: 'object', properties: {} })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run test/mcpStubServer.test.js`
Expected: FAIL — module/functions don't exist.

- [ ] **Step 4: Implement `src/mcpStubServer.mjs`**

```js
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import fs from 'node:fs'

export function loadToolsConfig(configPath) { /* JSON.parse(fs.readFileSync(configPath, 'utf8')) */ }
export function buildToolsListResponse(toolsConfig) { /* map to {tools:[{name,description,inputSchema}]} */ }

async function main() {
  const toolsConfig = loadToolsConfig(process.env.DEVBRIDGE_TOOLS_CONFIG_PATH)
  const server = new Server({ name: 'client-tools', version: '0.0.1' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => buildToolsListResponse(toolsConfig))
  // Anti-goal: this must never run for real. If interception ever fails to
  // fire, this must be a loud, visible error — never a fabricated result.
  server.setRequestHandler(CallToolRequestSchema, async () => {
    throw new Error('DevBridge interception failed: MCP stub tool handler executed for real')
  })
  await server.connect(new StdioServerTransport())
}

if (import.meta.url === `file://${process.argv[1]}`) main()
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run test/mcpStubServer.test.js`
Expected: PASS (3/3)

- [ ] **Step 6: Write the failing tests for `mcpBridge.js`**

```js
function fakeFs(overrides = {}) {
  const written = {}
  return {
    written,
    mkdtempSync: vi.fn(() => '/tmp/devbridge-tools-fake'),
    writeFileSync: vi.fn((p, content) => { written[p] = content }),
    rmSync: vi.fn(),
    ...overrides,
  }
}
const SAMPLE_TOOLS = [{ type: 'function', function: { name: 'get_weather', description: 'd', parameters: { type: 'object' } } }]

test('writes a tools.json with name/description/parameters for each tool', () => {
  const fs = fakeFs()
  const { mcpConfigPath } = createMcpBridge(SAMPLE_TOOLS, fs)
  const toolsJsonPath = Object.keys(fs.written).find((p) => p.endsWith('tools.json'))
  expect(JSON.parse(fs.written[toolsJsonPath])).toEqual([{ name: 'get_weather', description: 'd', parameters: { type: 'object' } }])
})

test('writes an mcp-config.json that points at mcpStubServer.mjs with the tools.json path in env', () => {
  const fs = fakeFs()
  const { mcpConfigPath } = createMcpBridge(SAMPLE_TOOLS, fs)
  const config = JSON.parse(fs.written[mcpConfigPath])
  expect(config.mcpServers['client-tools'].args[0]).toMatch(/mcpStubServer\.mjs$/)
  expect(config.mcpServers['client-tools'].env.DEVBRIDGE_TOOLS_CONFIG_PATH).toMatch(/tools\.json$/)
})

test('returns allowedToolNames prefixed with mcp__client-tools__', () => {
  const { allowedToolNames } = createMcpBridge(SAMPLE_TOOLS, fakeFs())
  expect(allowedToolNames).toEqual(['mcp__client-tools__get_weather'])
})

test('cleanup removes the temp directory it created', () => {
  const fs = fakeFs()
  const { cleanup } = createMcpBridge(SAMPLE_TOOLS, fs)
  cleanup()
  expect(fs.rmSync).toHaveBeenCalledWith('/tmp/devbridge-tools-fake', { recursive: true, force: true })
})

test('cleanup does not throw if rmSync itself throws', () => {
  const fs = fakeFs({ rmSync: vi.fn(() => { throw new Error('gone') }) })
  const { cleanup } = createMcpBridge(SAMPLE_TOOLS, fs)
  expect(() => cleanup()).not.toThrow()
})
```

- [ ] **Step 7: Run to verify it fails**

Run: `npx vitest run test/mcpBridge.test.js`
Expected: FAIL — module doesn't exist.

- [ ] **Step 8: Implement `src/mcpBridge.js`** per the Interfaces block above — resolve `mcpStubServer.mjs`'s path via `path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcpStubServer.mjs')`, `command: process.execPath`.

- [ ] **Step 9: Run to verify it passes**

Run: `npx vitest run test/mcpBridge.test.js`
Expected: PASS (5/5)

- [ ] **Step 10: Commit**

```bash
git add src/mcpStubServer.mjs src/mcpBridge.js test/mcpStubServer.test.js test/mcpBridge.test.js package.json package-lock.json
git commit -m "feat: generate a per-request stub MCP server for client-declared tools"
```

---

### Task 3: Drop `--resume`, wire MCP args into the CLI runner

**Files:**
- Modify: `src/claudeCliRunner.js`
- Modify: `test/claudeCliRunner.test.js`

**Interfaces:**
- Consumes: `createMcpBridge`, `MCP_SERVER_NAME` from `./mcpBridge.js` (Task 2) — imported as the default, but `createClaudeCliRunner`'s second options argument gains an injectable `createMcpBridge` (default: the real one), the same DI pattern `spawnFn`/`killGraceMs` already use, so tests can inject a fake without touching the filesystem.
- Produces: `runTurn({ content, projectPath, model, systemPrompt, effort, jsonSchema, tools, onDelta })` — `claudeSessionId` param removed entirely; return value is `{ promise, kill }` (no more synchronous `claudeSessionId`). `buildArgs` no longer emits `--resume`/`--session-id`; emits `--mcp-config <path> --strict-mcp-config --allowedTools <names...>` when `tools` is given.

- [ ] **Step 1: Write the failing tests**

```js
test('never passes --session-id or --resume (continuity comes from full-history replay)', () => {
  const child = fakeChild()
  const spawnFn = vi.fn(() => child)
  const runner = createClaudeCliRunner(spawnFn)
  runner.runTurn({ content: 'hello', projectPath: '/app/workspace/proj' })
  const [, args] = spawnFn.mock.calls[0]
  expect(args).not.toContain('--session-id')
  expect(args).not.toContain('--resume')
})

test('passes --mcp-config/--strict-mcp-config/--allowedTools from the injected bridge when tools are given', () => {
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

test('does not pass mcp args when no tools are given', () => {
  const child = fakeChild()
  const spawnFn = vi.fn(() => child)
  const runner = createClaudeCliRunner(spawnFn)
  runner.runTurn({ content: 'hi', projectPath: '/app/workspace/proj' })
  const [, args] = spawnFn.mock.calls[0]
  expect(args).not.toContain('--mcp-config')
  expect(args).not.toContain('--strict-mcp-config')
  expect(args).not.toContain('--allowedTools')
})

test('builds the mcp config via the injected createMcpBridge and calls its cleanup once the process closes', async () => {
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
```

Also **remove** these three now-obsolete tests (behavior they assert no longer exists): `'spawns claude in print/stream-json mode with a fresh --session-id when none is given'` (replace its `--session-id` assertions per the new test above, keep its other assertions about `-p`/`--output-format`/etc. by merging them into a renamed test), `'returns the --session-id it generated synchronously, before the turn settles'` (delete outright), `'resumes an existing claude session with --resume instead of --session-id'` (delete outright).

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run test/claudeCliRunner.test.js`
Expected: FAIL on the three new tests; the two deleted tests are gone so they can't fail.

- [ ] **Step 3: Implement.** Give `createClaudeCliRunner(spawnFn, { killGraceMs, createMcpBridge = realCreateMcpBridge } = {})` a new injectable third option, defaulting to the real `createMcpBridge` imported from `./mcpBridge.js`. In `buildArgs`, drop the `claudeSessionId`/`freshSessionId` parameter and branch entirely; add `mcpConfigPath`/`allowedToolNames` parameters, pushing `--mcp-config`, `mcpConfigPath`, `--strict-mcp-config` and `--allowedTools`, `...allowedToolNames` when `mcpConfigPath` is truthy. In `runTurn`, when `tools?.length`, call the injected `createMcpBridge(tools)` and destructure `{ mcpConfigPath, allowedToolNames, cleanup: cleanupMcpBridge }` (else all three are `null`/`[]`/`null`); pass the first two into `buildArgs`; in the existing `child.on('close', ...)` handler, call `cleanupMcpBridge?.()` alongside the existing `exited = true`. Remove `chosenSessionId`/the synchronous `claudeSessionId` return value and its use in the rejected-synchronous-spawn early return.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/claudeCliRunner.test.js`
Expected: PASS, full file green.

- [ ] **Step 5: Run the whole suite** (this file's changes affect nothing else yet, but confirm)

Run: `npm test`
Expected: all passing except nothing — `chatCompletions.test.js` does not yet reference `claudeSessionId` removal (Task 5 handles that file).

- [ ] **Step 6: Commit**

```bash
git add src/claudeCliRunner.js test/claudeCliRunner.test.js
git commit -m "feat: drop --resume/--session-id, wire MCP config into the CLI runner"
```

---

### Task 4: Intercept client tool-call proposals

**Files:**
- Modify: `src/claudeCliRunner.js`
- Modify: `test/claudeCliRunner.test.js`

**Interfaces:**
- Consumes: `MCP_SERVER_NAME` from `./mcpBridge.js` (to build the `mcp__client-tools__` prefix) — already imported in Task 3.
- Produces: `runTurn({ ..., onToolCallDelta })` — new optional callback, called as `onToolCallDelta({ index, id, name, argumentsFragment })` on the block's first fragment (with `id`/`name` populated) and `onToolCallDelta({ index, argumentsFragment })` on each subsequent fragment for the same `index`. The resolved outcome object gains two possible fields: `toolCalls: Array<{ index, id, name, arguments }> | null` and, when `toolCalls` is non-null, `stopReason: 'tool_use'` and `usage` taken from that `message_delta` (not from a `result` event, which never arrives on this path).

- [ ] **Step 1: Write the failing tests**

Add test-line builders alongside the file's existing `deltaLine`/`messageStartLine`:

```js
function toolUseStartLine(index, id, name) {
  return JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } } }) + '\n'
}
function inputJsonDeltaLine(index, partialJson) {
  return JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: partialJson } } }) + '\n'
}
function toolUseMessageDeltaLine(usage) {
  return JSON.stringify({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage } }) + '\n'
}
```

```js
test('resolves with toolCalls accumulated from an MCP-prefixed tool_use block, and kills the process', async () => {
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

test('calls onToolCallDelta for each fragment, keyed by index, with id/name only on the first call', async () => {
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

test('does not intercept a CLI-native tool_use block (no mcp__ prefix)', async () => {
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

test('resets accumulated blocks on message_start, so only the last message before the stop is reported (Review Focus)', async () => {
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

test('a message_delta tool_use stop with zero accumulated mcp blocks does not resolve the turn', async () => {
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/claudeCliRunner.test.js`
Expected: FAIL on all five new tests (no interception logic exists yet).

- [ ] **Step 3: Implement.** In `runTurn`, before `handleLine` is defined, compute `const MCP_PREFIX = \`mcp__${MCP_SERVER_NAME}__\``. Add `let currentBlocks = new Map()` (reset to a new `Map()` at the start of every `message_start` event, inside the existing `if (event.event?.type === 'message_start')` branch). In a new `content_block_start` branch: if `event.event.content_block?.type === 'tool_use'` and `event.event.content_block.name?.startsWith(MCP_PREFIX)`, `currentBlocks.set(event.event.index, { id: event.event.content_block.id, name: event.event.content_block.name.slice(MCP_PREFIX.length), argsBuf: '' })` and call `onToolCallDelta?.({ index: event.event.index, id: ..., name: ..., argumentsFragment: '' })`. In the existing `content_block_delta`/`input_json_delta` handling (extend the current `text_delta`-only branch, do not replace it): if `delta.type === 'input_json_delta'` and `currentBlocks.has(event.event.index)`, append `delta.partial_json` to that block's `argsBuf` and call `onToolCallDelta?.({ index: event.event.index, argumentsFragment: delta.partial_json })`. Add a new `message_delta` branch: if `event.event.delta?.stop_reason === 'tool_use'` and `currentBlocks.size > 0`, build `toolCalls` from `currentBlocks`, then call `settleResolve({ text: '', usage: event.event.usage ?? null, totalCostUsd: null, claudeSessionId: null, isError: false, stopReason: 'tool_use', subtype: null, model: capturedModel, toolCalls })` followed immediately by `killNow()` (see Step 3b). If `stop_reason === 'tool_use'` but `currentBlocks.size === 0`, do nothing (let the turn continue toward a real `result`).

- [ ] **Step 3b: Factor the kill logic into a `killNow()` function usable from both `handleLine` and the returned `kill`.** Move the body currently inside the returned `kill: () => {...}` closure into a named `function killNow() { ... }` declared before `const promise = new Promise(...)`, and have both the returned object's `kill: killNow` and the new `message_delta`/tool_use branch call `killNow()`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/claudeCliRunner.test.js`
Expected: PASS, full file green.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all passing.

- [ ] **Step 6: Commit**

```bash
git add src/claudeCliRunner.js test/claudeCliRunner.test.js
git commit -m "feat: intercept client tool-call proposals before the CLI dispatches them"
```

---

### Task 5: `/v1/chat/completions` — accept tools, respond with tool_calls

**Files:**
- Modify: `src/routes/chatCompletions.js`
- Modify: `test/chatCompletions.test.js`
- Modify: `README.md`

**Interfaces:**
- Consumes: `serializeHistory`, `extractText` from `../historySerializer.js` (Task 1); `runner.runTurn`'s `tools`/`onToolCallDelta` support and `toolCalls`/`stopReason: 'tool_use'` outcome shape (Task 3 + 4).
- Produces: `/v1/chat/completions` accepts `tools: [{type:'function', function:{name, description?, parameters?}}]` and `tool_choice: undefined | 'auto' | 'none'`; non-streaming responses may have `finish_reason: 'tool_calls'` and `message.tool_calls`; streaming responses may emit `delta.tool_calls[]` chunks.

- [ ] **Step 1: Write the failing tests for validation changes**

```js
test('accepts a request with tools and tool_choice auto', async () => {
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

test('rejects tool_choice: "required" with 400', async () => {
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

test('rejects a tool with a NUL byte in its name with 400 (Review Focus)', async () => {
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

test('tool_choice "none" does not pass tools through to the runner, even if tools is non-empty', async () => {
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

test('passes the full serialized history, not just the last message, to the runner', async () => {
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

test('accepts a request whose last message is a tool result (Review Focus: no longer requires text as the last message)', async () => {
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/chatCompletions.test.js`
Expected: FAIL — these behaviors don't exist yet (current code 400s on `tools`, uses last-message-only extraction). Also **remove** the existing test that asserts `tools` is rejected (its behavior is being replaced, not kept).

- [ ] **Step 3: Implement validation changes.** Remove the `tools`/`tool_choice` rejection block (keep `functions`/`function_call` rejection unchanged). Replace the `extractText` local definition with `import { extractText, serializeHistory } from '../historySerializer.js'`. Replace the last-message-only extraction and its "must have non-empty text" check with: `const content = serializeHistory(body.messages)`, erroring `{ error: 'the message history must serialize to non-empty content' }` if `content.length === 0`. Add tools validation: for each entry in `body.tools` (if present), require `type === 'function'` and `function?.name` a non-empty string; collect `JSON.stringify(body.tools).includes('\0')` as a single NUL-byte check across the whole array (mirroring the existing `jsonSchema` NUL check) and error before any per-field checks if found. Add `tool_choice` validation: accept `undefined`, `'auto'`, `'none'`; otherwise error `{ error: 'tool_choice must be one of auto, none — required/forced-tool selection is not supported' }`. Compute `activeTools = (tool_choice === 'none' || !Array.isArray(body.tools) || body.tools.length === 0) ? null : body.tools` and return it from `validateRequest`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/chatCompletions.test.js`
Expected: PASS for all tests written so far.

- [ ] **Step 5: Write the failing tests for the non-streaming tool_calls response shape**

```js
test('a tool_use outcome produces a tool_calls response with finish_reason tool_calls', async () => {
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
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run test/chatCompletions.test.js`
Expected: FAIL — `mapFinishReason` doesn't know `'tool_use'`, response always sets `message.content`.

- [ ] **Step 7: Implement.** Extend `mapFinishReason`: `if (stopReason === 'tool_use') return 'tool_calls'`. Add `function mapToolCalls(toolCalls) { return toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } })) }`. In the non-streaming success branch, when `result.toolCalls?.length`, respond with `message: { role: 'assistant', content: null, tool_calls: mapToolCalls(result.toolCalls), refusal: null }` instead of `message: { role:'assistant', content: result.text, refusal: null }`; `finish_reason` comes from the already-extended `mapFinishReason`.

- [ ] **Step 8: Run to verify it passes**

Run: `npx vitest run test/chatCompletions.test.js`
Expected: PASS.

- [ ] **Step 9: Write the failing tests for the streaming tool_calls response shape**

```js
test('streams tool_call deltas: first chunk carries id/type/function.name, later chunks carry only arguments fragments', async () => {
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
```

- [ ] **Step 10: Run to verify it fails**

Run: `npx vitest run test/chatCompletions.test.js`
Expected: FAIL — no `onToolCallDelta` is wired, no tool_call chunks emitted.

- [ ] **Step 11: Implement.** In the streaming branch's `runner.runTurn({...runTurnOpts, onDelta, onToolCallDelta: (d) => sseWrite(res, toolCallChunk(d))})` — add a `toolCallChunk({index, id, name, argumentsFragment})` helper building `{ id, object:'chat.completion.chunk', created, model: model ?? 'claude-code-local', choices: [{ index: 0, delta: { tool_calls: [ id !== undefined ? { index, id, type: 'function', function: { name, arguments: argumentsFragment } } : { index, function: { arguments: argumentsFragment } } ] }, finish_reason: null, logprobs: null }] }`. The final chunk's `finish_reason` already comes from the extended `mapFinishReason(result.stopReason)` in the existing success branch — no change needed there beyond what Step 7 already did.

- [ ] **Step 12: Run to verify it passes**

Run: `npx vitest run test/chatCompletions.test.js`
Expected: PASS, full file green.

- [ ] **Step 13: Run the whole suite**

Run: `npm test`
Expected: all passing.

- [ ] **Step 14: Update `README.md`.** In the compatibility table (~line 297), move `tools`/`tool_choice` out of the "Rejected" column into "Supported & mapped" (noting `tool_choice` supports only `auto`/`none`, not `required`/forced). Rewrite the "Why `tools`/`tool_choice`/`functions` are rejected outright" section (~line 332) to describe the MCP-bridge/interception design instead (what runs, what doesn't, and why `functions`/`function_call` still are rejected). Rewrite the `--session-id`/`--resume` continuity description (~lines 59–62, ~420–425) to describe full-history replay instead.

- [ ] **Step 15: Commit**

```bash
git add src/routes/chatCompletions.js test/chatCompletions.test.js README.md
git commit -m "feat: support OpenAI tool_calls on /v1/chat/completions via the MCP bridge"
```

---

## Self-Review

**Spec coverage:** Every "Goal" in the spec maps to a task — tool-calling with real clients (Task 5, end-to-end), parallel/mixed native+client calls (Task 4's reset-per-message logic), streaming argument deltas (Task 4's `onToolCallDelta` + Task 5's SSE chunks), full-history replay dropping `--resume` (Tasks 1 + 3). `deepagents` compatibility is a usage note in the spec, not a code change — no task needed; it's already satisfied once `tool_choice`/`tools` work against a standard `ChatOpenAI(base_url=...)` instance.

**Step scan:** Every test step has concrete assertions with real values; every implementation step names the exact function/file and the exact behavior change. No step says "handle edge cases" without naming the case.

**Type consistency:** `toolCalls` entries are consistently `{ index, id, name, arguments }` from Task 4's accumulation through Task 5's `mapToolCalls`. `onToolCallDelta`'s payload shape (`{index, id?, name?, argumentsFragment}`) is identical across Task 4 (producer) and Task 5 (consumer).

**Review Focus:** All five items have an owning task and an explicit test (tool_choice required → Task 5 Step 1; orphaned tool result → Task 1 Step 5; cross-message accumulation reset → Task 4 Step 1; NUL byte in tool name → Task 5 Step 1; first-chunk id/name shape → Task 5 Step 9).

**Proportion:** This plan is longer than the design spec because it is a plan for five separate files plus two rewritten ones, each with its own test suite — proportionate to that scope, not a transcription of the spec's prose.
