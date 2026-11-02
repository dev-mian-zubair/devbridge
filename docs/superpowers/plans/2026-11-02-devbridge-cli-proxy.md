# DevBridge CLI Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local-only Node.js proxy that wraps the interactive `@anthropic-ai/claude-code` CLI in a `node-pty` pseudo-terminal and exposes it as an HTTP chat-completions endpoint and a WebSocket terminal stream, with a minimal static dashboard, all in one Docker container.

**Architecture:** A single Express app (ESM) binds to `127.0.0.1`, serves the static dashboard from `public/`, and owns an in-memory `activeSessions` registry keyed by `sessionId`. Each session wraps one `node-pty` process (the `claude` CLI) pinned to a `cwd` (`projectPath`). `POST /v1/chat/completions` writes a message into a session's PTY, buffers and ANSI-strips the output, detects end-of-turn via prompt-marker scanning, and returns a mocked OpenAI-style response; a 120s watchdog force-injects Ctrl+C and fails the request if no marker appears. `WS /api/session/stream` is a thin bidirectional proxy between the browser and the same PTY, used for raw terminal viewing, `/login` auth, and manual intervention. The real `node-pty` module is only ever imported in `server.js`; every other module receives its `spawn` function by dependency injection, so the whole backend is unit-testable without compiling or invoking a real PTY.

**Tech Stack:** Node.js 20 (ESM), `express`, `node-pty`, `ws`, `strip-ansi`, `vitest` + `supertest` for tests, `xterm.js` (via CDN) for the terminal canvas, Docker (`node:20-bookworm-slim`).

**Spec:** `docs/PRD.md` (Product Requirement Document: DevBridge CLI Proxy)

## Global Constraints

- PTY must be created with `node-pty.spawn()`, never `child_process` (PRD §3, Req 1).
- PTY emulation settings: `cols: 120`, `rows: 40`, `name: 'xterm-256color'` (PRD §3, Req 1).
- New session's PTY `cwd` must be the absolute `projectPath` from the request (PRD §3, Req 2).
- EOT detection scans for the `❯` cursor marker or a trailing `?` input cue, then strips ANSI via `strip-ansi` before returning (PRD §3, Req 3).
- Server must never request, store, or transmit an Anthropic API key (PRD §5.1).
- Server must bind to `127.0.0.1` only (or an unexposed internal Docker network) (PRD §5.2).
- If a chat turn runs >120s without an EOT marker, force-inject SIGINT (`\x03`) to free the session (PRD §5.3).
- Container must set `CLAUDE_CONFIG_DIR=/data/.claude` and persist it via a named Docker volume (PRD §3, Component C).
- HTTP contract is exactly PRD §4.1 (`POST /v1/chat/completions`, request/response shapes shown there); WS contract is exactly PRD §4.2's inbound/outbound JSON shapes.

## Design Decisions Not Fixed by the Spec

- PRD §3 Req 2 names the endpoint `POST /api/chat`; PRD §4.1 gives the full contract for `POST /v1/chat/completions`. Treated as the same endpoint; implemented at the §4.1 path, since that section is the one with a fully specified contract.
- Frontend: vanilla HTML/JS (no build step), confirmed with the user over React.
- Session registry: in-memory only, confirmed with the user — no extra persistence beyond what `CLAUDE_CONFIG_DIR` already gives Claude Code.
- Project layout: single app serving both API and static dashboard, confirmed with the user over a backend/frontend monorepo split.
- Reusing an existing `sessionId` with a different `projectPath` than it was created with is a conflict: the server responds `409 Conflict` rather than silently switching directories (PRD is silent on this; switching directories mid-session on an already-running PTY isn't possible without restarting it).
- Auth URL/code extraction (PRD §3, Component B, "Auth Overlay Button") is done client-side in the dashboard by regex-scanning the same raw `{type:"output"}` WS stream the debug console already renders, rather than adding a second backend extraction path — keeps the WS proxy a dumb pipe and avoids guessing the CLI's exact device-code output format in the backend contract.
- Timeout response shape (not specified by the PRD): `504` with `{ "error": { "message": "...", "type": "timeout" } }`.

## Review Focus

- Reusing a `sessionId` whose stored `projectPath` doesn't match the request's `projectPath` — expect `409`, not a silent directory switch or crash.
- The EOT scanner must only look at output produced *after* the current write, not match leftover shell-banner text already sitting in the buffer from session startup.
- After a 120s timeout forces a SIGINT, the session must stay usable for the next request, not be torn down or left locked.
- A WS `{type:"input"}` frame for a `sessionId` with no active session must return an error frame, not throw/crash the server.
- ANSI escape sequences split across two separate `pty.onData` chunks must still be stripped correctly — the parser buffers raw chunks before stripping, never strips chunk-by-chunk independently.

---

## File Structure

```
devbridge/
  package.json
  .gitignore
  .env.example
  Dockerfile
  .dockerignore
  README.md
  src/
    config.js                  # env-driven config (PORT, HOST, CLAUDE_CONFIG_DIR, EXEC_TIMEOUT_MS)
    streamParser.js            # EOT detection + ANSI stripping, pure functions
    sessionManager.js          # activeSessions registry, DI'd PTY spawn
    timeoutGuard.js            # wraps a pending turn with the 120s SIGINT watchdog
    routes/
      chatCompletions.js       # POST /v1/chat/completions handler factory
    ws/
      sessionStream.js         # WS /api/session/stream proxy handler factory
    server.js                  # wires everything, binds 127.0.0.1, only place node-pty is imported
  public/
    index.html                 # dashboard shell
    app.js                     # status bar, session navigator, auth overlay, xterm.js debug console
    style.css
  test/
    streamParser.test.js
    sessionManager.test.js
    timeoutGuard.test.js
    chatCompletions.test.js
    sessionStream.test.js
    server.test.js
```

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `src/config.js`
- Test: `test/config.test.js`

**Interfaces:**
- Produces: `export function loadConfig(env = process.env)` returning `{ port: number, host: string, claudeConfigDir: string, execTimeoutMs: number }` with defaults `port=3000`, `host='127.0.0.1'`, `claudeConfigDir='/data/.claude'`, `execTimeoutMs=120000`, each overridable by `PORT`, `HOST`, `CLAUDE_CONFIG_DIR`, `EXEC_TIMEOUT_MS`.

- [ ] **Step 1: Write `package.json`**

`"type": "module"`, `"engines": { "node": ">=20" }`, scripts `"start": "node src/server.js"` and `"test": "vitest run"`, dependencies `express`, `ws`, `node-pty`, `strip-ansi`, devDependencies `vitest`, `supertest`.

- [ ] **Step 2: Write `.gitignore`** (`node_modules/`, `.env`, `*.log`) and `.env.example` listing `PORT`, `HOST`, `CLAUDE_CONFIG_DIR`, `EXEC_TIMEOUT_MS` with the defaults above as comments.

- [ ] **Step 3: Write the failing test**

```js
// test/config.test.js
import { describe, it, expect } from 'vitest'
import { loadConfig } from '../src/config.js'

describe('loadConfig', () => {
  it('applies defaults when env vars are absent', () => {
    const cfg = loadConfig({})
    expect(cfg).toEqual({ port: 3000, host: '127.0.0.1', claudeConfigDir: '/data/.claude', execTimeoutMs: 120000 })
  })

  it('overrides defaults from the given env object', () => {
    const cfg = loadConfig({ PORT: '4000', HOST: '0.0.0.0', CLAUDE_CONFIG_DIR: '/x', EXEC_TIMEOUT_MS: '5000' })
    expect(cfg).toEqual({ port: 4000, host: '0.0.0.0', claudeConfigDir: '/x', execTimeoutMs: 5000 })
  })
})
```

- [ ] **Step 4: Run `npm install` then `npx vitest run test/config.test.js`**

Expected: FAIL (`src/config.js` does not exist).

- [ ] **Step 5: Implement `loadConfig` in `src/config.js`**

- [ ] **Step 6: Run `npx vitest run test/config.test.js`**

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add package.json .gitignore .env.example src/config.js test/config.test.js package-lock.json
git commit -m "chore: scaffold project and config loader"
```

---

### Task 2: Stream Parser (EOT Detection + ANSI Stripping)

**Files:**
- Create: `src/streamParser.js`
- Test: `test/streamParser.test.js`

**Interfaces:**
- Produces:
  - `export function createTurnBuffer()` → `{ push(rawChunk: string): void, isReady(): boolean, getReply(): string }`. `push` appends a raw (possibly ANSI-laden, possibly partial-escape-sequence) chunk. `isReady()` returns `true` once the ANSI-stripped accumulated text ends with a prompt marker: a line ending in `❯` or a line ending in `?` (trailing whitespace ignored). `getReply()` returns the ANSI-stripped accumulated text with the trailing prompt-marker line removed and leading/trailing whitespace trimmed.
  - A fresh `createTurnBuffer()` must be used per turn (per write), so pre-existing banner text never leaks in — callers (Task 5) create one right before writing, not once per session.

- [ ] **Step 1: Write the failing tests**

```js
// test/streamParser.test.js
import { describe, it, expect } from 'vitest'
import { createTurnBuffer } from '../src/streamParser.js'

describe('createTurnBuffer', () => {
  it('is not ready until a prompt marker line appears', () => {
    const buf = createTurnBuffer()
    buf.push('Here is the analysis...\n')
    expect(buf.isReady()).toBe(false)
  })

  it('is ready once a line ends with the ❯ cursor marker', () => {
    const buf = createTurnBuffer()
    buf.push('Done.\n❯ ')
    expect(buf.isReady()).toBe(true)
  })

  it('is ready once a line ends with a trailing ? cue', () => {
    const buf = createTurnBuffer()
    buf.push('Proceed with the change?')
    expect(buf.isReady()).toBe(true)
  })

  it('strips ANSI styling from the final reply', () => {
    const buf = createTurnBuffer()
    buf.push('\u001b[32mAll good\u001b[0m\n❯ ')
    expect(buf.getReply()).toBe('All good')
  })

  it('reassembles an ANSI escape sequence split across two chunks', () => {
    const buf = createTurnBuffer()
    buf.push('\u001b[32mAll good')
    buf.push('\u001b[0m\n❯ ')
    expect(buf.getReply()).toBe('All good')
  })
})
```

- [ ] **Step 2: Run `npx vitest run test/streamParser.test.js`**

Expected: FAIL (`src/streamParser.js` does not exist).

- [ ] **Step 3: Implement `createTurnBuffer` in `src/streamParser.js`**

Keep the raw concatenation in a single string (don't strip per-chunk — strip the whole accumulated string each time `isReady`/`getReply` is called) so a split escape sequence is always whole by the time it's stripped. Use `strip-ansi` for stripping and a regex like `/(❯|\?)\s*$/` against the stripped text, applied per trailing non-empty line, to decide readiness.

- [ ] **Step 4: Run `npx vitest run test/streamParser.test.js`**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/streamParser.js test/streamParser.test.js
git commit -m "feat: add turn buffer with EOT detection and ANSI stripping"
```

---

### Task 3: Session Manager (In-Memory Registry + DI'd PTY)

**Files:**
- Create: `src/sessionManager.js`
- Test: `test/sessionManager.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks (takes its PTY spawner as a parameter).
- Produces:
  - `export class SessionConflictError extends Error { constructor(sessionId, existingProjectPath, requestedProjectPath) }`
  - `export function createSessionManager(spawnFn)` → `{ getOrCreate(sessionId, projectPath): Session, get(sessionId): Session | undefined }`, where `spawnFn(cmd, args, options)` has the same signature as `node-pty.spawn` and `Session` is `{ sessionId, projectPath, pty }`.
  - `getOrCreate`: if no session exists for `sessionId`, calls `spawnFn('claude', [], { name: 'xterm-256color', cols: 120, rows: 40, cwd: projectPath, env: process.env })`, stores `{ sessionId, projectPath, pty }`, returns it. If a session exists and its stored `projectPath` matches, returns it unchanged. If a session exists with a **different** `projectPath`, throws `SessionConflictError`.

- [ ] **Step 1: Write the failing tests**

```js
// test/sessionManager.test.js
import { describe, it, expect, vi } from 'vitest'
import { createSessionManager, SessionConflictError } from '../src/sessionManager.js'

function fakePty() { return { onData: vi.fn(), write: vi.fn(), kill: vi.fn() } }

describe('createSessionManager', () => {
  it('spawns a new PTY with the required settings on first use', () => {
    const spawnFn = vi.fn(() => fakePty())
    const manager = createSessionManager(spawnFn)
    manager.getOrCreate('s1', '/app/workspace/proj')
    expect(spawnFn).toHaveBeenCalledWith('claude', [], expect.objectContaining({
      name: 'xterm-256color', cols: 120, rows: 40, cwd: '/app/workspace/proj',
    }))
  })

  it('reuses the existing session when projectPath matches', () => {
    const spawnFn = vi.fn(() => fakePty())
    const manager = createSessionManager(spawnFn)
    const first = manager.getOrCreate('s1', '/app/workspace/proj')
    const second = manager.getOrCreate('s1', '/app/workspace/proj')
    expect(second).toBe(first)
    expect(spawnFn).toHaveBeenCalledTimes(1)
  })

  it('throws SessionConflictError when projectPath differs for an existing sessionId', () => {
    const spawnFn = vi.fn(() => fakePty())
    const manager = createSessionManager(spawnFn)
    manager.getOrCreate('s1', '/app/workspace/proj-a')
    expect(() => manager.getOrCreate('s1', '/app/workspace/proj-b')).toThrow(SessionConflictError)
  })

  it('get returns undefined for an unknown sessionId', () => {
    const manager = createSessionManager(vi.fn())
    expect(manager.get('missing')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run `npx vitest run test/sessionManager.test.js`**

Expected: FAIL (`src/sessionManager.js` does not exist).

- [ ] **Step 3: Implement `SessionConflictError` and `createSessionManager` in `src/sessionManager.js`**

Backing store is a plain `Map<string, Session>` closed over by the returned object.

- [ ] **Step 4: Run `npx vitest run test/sessionManager.test.js`**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sessionManager.js test/sessionManager.test.js
git commit -m "feat: add in-memory session manager with DI'd PTY spawn"
```

---

### Task 4: Timeout Guard (120s SIGINT Watchdog)

**Files:**
- Create: `src/timeoutGuard.js`
- Test: `test/timeoutGuard.test.js`

**Interfaces:**
- Consumes: a `Session.pty` shaped like `{ write(data: string): void }` (from Task 3).
- Produces: `export function withTimeout(promise: Promise<T>, pty, timeoutMs): Promise<T>` — races `promise` against a timer of `timeoutMs`. If the timer fires first, calls `pty.write('\x03')` and rejects with `new Error('timeout')`. If `promise` settles first, the timer is cleared and `pty` is never touched.

- [ ] **Step 1: Write the failing tests**

```js
// test/timeoutGuard.test.js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { withTimeout } from '../src/timeoutGuard.js'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('withTimeout', () => {
  it('resolves with the inner promise value when it settles before the timeout', async () => {
    const pty = { write: vi.fn() }
    const result = withTimeout(Promise.resolve('reply'), pty, 120000)
    await expect(result).resolves.toBe('reply')
    expect(pty.write).not.toHaveBeenCalled()
  })

  it('force-injects SIGINT and rejects with a timeout error when the timer fires first', async () => {
    const pty = { write: vi.fn() }
    const neverSettles = new Promise(() => {})
    const result = withTimeout(neverSettles, pty, 120000)
    const assertion = expect(result).rejects.toThrow('timeout')
    await vi.advanceTimersByTimeAsync(120000)
    await assertion
    expect(pty.write).toHaveBeenCalledWith('\x03')
  })
})
```

- [ ] **Step 2: Run `npx vitest run test/timeoutGuard.test.js`**

Expected: FAIL (`src/timeoutGuard.js` does not exist).

- [ ] **Step 3: Implement `withTimeout` in `src/timeoutGuard.js`**

- [ ] **Step 4: Run `npx vitest run test/timeoutGuard.test.js`**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/timeoutGuard.js test/timeoutGuard.test.js
git commit -m "feat: add 120s SIGINT timeout guard for chat turns"
```

---

### Task 5: Chat Completions Route

**Files:**
- Create: `src/routes/chatCompletions.js`
- Test: `test/chatCompletions.test.js`

**Interfaces:**
- Consumes: `createSessionManager`/`SessionConflictError` (Task 3), `createTurnBuffer` (Task 2), `withTimeout` (Task 4).
- Produces: `export function createChatCompletionsRouter(sessionManager, { timeoutMs })` → an Express `Router` with `POST /v1/chat/completions` registered. Request body: `{ model, sessionId, projectPath, messages: [{ role, content }] }` per PRD §4.1 — uses the last message's `content` as the text written to the PTY. Success response: PRD §4.1's exact shape, with `choices[0].message.content` set to the detected reply and `id` set to `` `chatcmpl-local-${sessionId}` ``, `created` set to `Math.floor(Date.now() / 1000)`. On `SessionConflictError`, responds `409` with `{ error: { message, type: 'session_conflict' } }`. On timeout, responds `504` with `{ error: { message: 'timed out waiting for a response', type: 'timeout' } }`.

- [ ] **Step 1: Write the failing tests**

```js
// test/chatCompletions.test.js
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
    await vi.waitUntil(() => box.cb)
    box.cb('Hi there!\n❯ ')
    const res = await reqPromise
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
    await vi.waitUntil(() => box.cb, { timeout: 2000 })
    await vi.advanceTimersByTimeAsync(1000)
    const timeoutRes = await timedOut
    expect(timeoutRes.status).toBe(504)
    vi.useRealTimers()

    const retry = request(app).post('/v1/chat/completions').send({
      sessionId: 's1', projectPath: '/app/workspace/proj', messages: [{ role: 'user', content: 'hi again' }],
    })
    await vi.waitUntil(() => box.cb, { timeout: 2000 })
    box.cb('Hi again!\n❯ ')
    const res = await retry
    expect(res.status).toBe(200)
    expect(res.body.choices[0].message.content).toBe('Hi again!')
  })
})
```

- [ ] **Step 2: Run `npx vitest run test/chatCompletions.test.js`**

Expected: FAIL (`src/routes/chatCompletions.js` does not exist).

- [ ] **Step 3: Implement `createChatCompletionsRouter` in `src/routes/chatCompletions.js`**

Per request: `sessionManager.getOrCreate(sessionId, projectPath)`, create a fresh `createTurnBuffer()`, register a one-shot `pty.onData` handler that pushes into the buffer and resolves an internal promise once `buffer.isReady()`, then `pty.write(content + '\n')`, and `await withTimeout(thatPromise, session.pty, timeoutMs)`. Unregister the handler (or guard it with a resolved flag) once settled, per PRD §3 Req 3 ("unhook the event listener").

- [ ] **Step 4: Run `npx vitest run test/chatCompletions.test.js`**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/chatCompletions.js test/chatCompletions.test.js
git commit -m "feat: add POST /v1/chat/completions route"
```

---

### Task 6: WebSocket Session Stream

**Files:**
- Create: `src/ws/sessionStream.js`
- Test: `test/sessionStream.test.js`

**Interfaces:**
- Consumes: `createSessionManager` (Task 3).
- Produces: `export function createSessionStreamHandler(sessionManager)` → `(ws, request) => void` to be passed to a `WebSocketServer`'s `'connection'` event. On `ws.on('message', ...)`, parses JSON `{ type: 'input', sessionId, data }` (PRD §4.2 inbound) and calls `sessionManager.get(sessionId)?.pty.write(data)`; if no session exists for `sessionId`, sends back `{ type: 'error', sessionId, data: 'unknown session' }` instead of writing. For every session the handler has seen an `'input'` message for, it also registers `pty.onData(chunk => ws.send(JSON.stringify({ type: 'output', sessionId, data: chunk })))` (PRD §4.2 outbound) the first time that `sessionId` is used on this socket.

- [ ] **Step 1: Write the failing tests**

```js
// test/sessionStream.test.js
import { describe, it, expect, vi } from 'vitest'
import { createSessionStreamHandler } from '../src/ws/sessionStream.js'
import { createSessionManager } from '../src/sessionManager.js'

function fakeWs() { return { send: vi.fn(), on: vi.fn() } }

describe('createSessionStreamHandler', () => {
  it('writes inbound input data to the matching session PTY', () => {
    let dataCb
    const spawnFn = vi.fn(() => ({ write: vi.fn(), onData: (cb) => { dataCb = cb }, kill: vi.fn() }))
    const sessionManager = createSessionManager(spawnFn)
    const session = sessionManager.getOrCreate('s1', '/app/workspace/proj')
    const ws = fakeWs()
    const handler = createSessionStreamHandler(sessionManager)
    handler(ws, {})
    const onMessage = ws.on.mock.calls.find(([event]) => event === 'message')[1]
    onMessage(JSON.stringify({ type: 'input', sessionId: 's1', data: '/login\n' }))
    expect(session.pty.write).toHaveBeenCalledWith('/login\n')
  })

  it('forwards PTY output as an outbound output frame', () => {
    let dataCb
    const spawnFn = vi.fn(() => ({ write: vi.fn(), onData: (cb) => { dataCb = cb }, kill: vi.fn() }))
    const sessionManager = createSessionManager(spawnFn)
    sessionManager.getOrCreate('s1', '/app/workspace/proj')
    const ws = fakeWs()
    const handler = createSessionStreamHandler(sessionManager)
    handler(ws, {})
    const onMessage = ws.on.mock.calls.find(([event]) => event === 'message')[1]
    onMessage(JSON.stringify({ type: 'input', sessionId: 's1', data: 'x' }))
    dataCb('some terminal output')
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'output', sessionId: 's1', data: 'some terminal output' }))
  })

  it('sends an error frame for an unknown sessionId instead of throwing', () => {
    const sessionManager = createSessionManager(vi.fn())
    const ws = fakeWs()
    const handler = createSessionStreamHandler(sessionManager)
    handler(ws, {})
    const onMessage = ws.on.mock.calls.find(([event]) => event === 'message')[1]
    expect(() => onMessage(JSON.stringify({ type: 'input', sessionId: 'missing', data: 'x' }))).not.toThrow()
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'error', sessionId: 'missing', data: 'unknown session' }))
  })
})
```

- [ ] **Step 2: Run `npx vitest run test/sessionStream.test.js`**

Expected: FAIL (`src/ws/sessionStream.js` does not exist).

- [ ] **Step 3: Implement `createSessionStreamHandler` in `src/ws/sessionStream.js`**

Track which `sessionId`s already have an `onData` listener registered on this socket in a local `Set`, to satisfy "the first time that `sessionId` is used on this socket."

- [ ] **Step 4: Run `npx vitest run test/sessionStream.test.js`**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ws/sessionStream.js test/sessionStream.test.js
git commit -m "feat: add WS /api/session/stream proxy handler"
```

---

### Task 7: Server Wiring

**Files:**
- Create: `src/server.js`
- Test: `test/server.test.js`

**Interfaces:**
- Consumes: `loadConfig` (Task 1), `createSessionManager` (Task 3), `createChatCompletionsRouter` (Task 5), `createSessionStreamHandler` (Task 6).
- Produces: `export function createApp(sessionManager)` → a configured Express `app` (static `public/` + chat completions router mounted, no `.listen()` call) for testability; `export function createServer(config, spawnFn)` → `{ app, httpServer, wss }` that builds the session manager from `spawnFn`, calls `createApp`, creates an `http.Server`, attaches a `WebSocketServer` on `path: '/api/session/stream'` wired to `createSessionStreamHandler`, and does not call `.listen()`. The module's top-level script body (guarded by `if (import.meta.url === \`file://${process.argv[1]}\`)`) imports real `node-pty`, calls `createServer(loadConfig(), pty.spawn)`, and calls `httpServer.listen(config.port, config.host)` — this is the only place in the codebase that imports `node-pty`.

- [ ] **Step 1: Write the failing tests**

```js
// test/server.test.js
import { describe, it, expect, vi } from 'vitest'
import request from 'supertest'
import { createServer } from '../src/server.js'

describe('createServer', () => {
  it('serves the dashboard shell at /', async () => {
    const { app } = createServer({ port: 0, host: '127.0.0.1', execTimeoutMs: 1000 }, vi.fn())
    const res = await request(app).get('/')
    expect(res.status).toBe(200)
    expect(res.text).toContain('<html')
  })

  it('mounts the chat completions route', async () => {
    const spawnFn = vi.fn(() => ({ write: vi.fn(), onData: vi.fn(), kill: vi.fn() }))
    const { app } = createServer({ port: 0, host: '127.0.0.1', execTimeoutMs: 1000 }, spawnFn)
    const res = await request(app).post('/v1/chat/completions').send({
      sessionId: 's1', projectPath: '/app/workspace/proj', messages: [{ role: 'user', content: 'hi' }],
    })
    expect(res.status).not.toBe(404)
  })
})
```

- [ ] **Step 2: Run `npx vitest run test/server.test.js`**

Expected: FAIL (`src/server.js` does not exist).

- [ ] **Step 3: Implement `createApp` and `createServer` in `src/server.js`**

- [ ] **Step 4: Run `npx vitest run test/server.test.js`**

Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: all tests across Tasks 1–7 PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server.js test/server.test.js
git commit -m "feat: wire Express app, static dashboard, and WS server together"
```

---

### Task 8: Static Dashboard

**Files:**
- Create: `public/index.html`
- Create: `public/app.js`
- Create: `public/style.css`

**Interfaces:**
- Consumes: the running server's `POST /v1/chat/completions` and `WS /api/session/stream` (Tasks 5–7).
- Produces: a browser-loadable dashboard with no build step.

- [ ] **Step 1: Write `public/index.html`**

Loads `xterm.js` from a CDN `<script>` tag, its stylesheet, and `app.js` (`type="module"`). Layout per PRD §3 Component B: a status bar element (`#status-bar`), a session navigator list (`#session-list` + an "add session" form taking `sessionId` + `projectPath`), a "Sign In" button (`#auth-button`), an auth hyperlink area (`#auth-link`, hidden until a login URL is found), and a debug console container (`#terminal`) for the `xterm.js` instance.

- [ ] **Step 2: Write `public/app.js`**

- Opens one `WebSocket` to `/api/session/stream`.
- On selecting/adding a session in the navigator, sends `{ type: 'input', sessionId, data: '' }` only after the session has been created by an initial `POST /v1/chat/completions` call is **not** required — instead, track the selected session locally and write to the `#terminal` via `xterm.js` whenever an `{ type: 'output', sessionId, data }` frame arrives for it.
- `#auth-button` click sends `{ type: 'input', sessionId: currentSessionId, data: '/login\n' }` over the socket.
- Every incoming `{ type: 'output' }` frame's `data` is also scanned with `/https?:\/\/\S+/` and, if found, the nearest standalone `/\b[A-Za-z0-9-]{6,12}\b/` token near it; when both are found, populates `#auth-link` with an `<a>` to the URL showing the code, and flips `#status-bar` to "requires interaction" until the next normal reply is seen.
- Updates `#status-bar` to "authenticated" once an output frame arrives that doesn't match the URL/code pattern after an auth prompt was shown.

- [ ] **Step 3: Write `public/style.css`** with basic layout for the status bar, navigator, and terminal panel.

- [ ] **Step 4: Manually verify**

Run `npm start`, open `http://127.0.0.1:3000/` in a browser, confirm the dashboard loads with no console errors and the layout matches the description above. (No automated test — this is a static, build-free UI; covered by the Task 9 Docker smoke test and by manual browser check.)

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/app.js public/style.css
git commit -m "feat: add static admin dashboard"
```

---

### Task 9: Containerization + Docs

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `README.md`

**Interfaces:**
- Consumes: the finished app from Tasks 1–8.
- Produces: a buildable image satisfying PRD §3 Component C.

- [ ] **Step 1: Write `Dockerfile`**

`FROM node:20-bookworm-slim`; install `python3 make g++` (required to build `node-pty` from source); `WORKDIR /app`; copy `package*.json`, `npm ci --omit=dev`; copy the rest of the source; `ENV CLAUDE_CONFIG_DIR=/data/.claude`; `ENV HOST=127.0.0.1`; `VOLUME ["/data/.claude"]`; `CMD ["node", "src/server.js"]`.

- [ ] **Step 2: Write `.dockerignore`** (`node_modules`, `.git`, `*.md`, `docs/`).

- [ ] **Step 3: Write `README.md`**

Covers: local dev (`npm install && npm start`), running tests (`npm test`), building the image (`docker build -t devbridge .`), running it with the project mount and named volume (`docker run -p 127.0.0.1:3000:3000 -v claude-config:/data/.claude -v /host/path/to/project:/app/workspace/project devbridge`), and the `/login` flow (open the dashboard, add a session pointed at the mounted project path, click Sign In, follow the printed URL/code).

- [ ] **Step 4: Manually verify**

Run: `docker build -t devbridge .`
Expected: image builds successfully (confirms `node-pty` compiles against the Bookworm base and `npm ci` succeeds).

- [ ] **Step 5: Commit**

```bash
git add Dockerfile .dockerignore README.md
git commit -m "chore: containerize app and document usage"
```
