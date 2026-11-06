# DevBridge

DevBridge is a local-only developer tool that wraps the official
`@anthropic-ai/claude-code` CLI and exposes it as an OpenAI-compatible HTTP
chat-completions endpoint, a WebSocket terminal stream, and a minimal admin
dashboard — all in a single Docker container.

## Why this exists

The Claude Code CLI gives you Claude itself, backed by a Claude Pro/Team
**subscription** rather than a usage-priced API key. DevBridge's job is to
make the *model* reachable the way any other LLM backend is reachable — a
standard HTTP endpoint that takes OpenAI-style chat-completions requests,
so local tools, scripts, and OpenAI-SDK-based applications (LangChain,
LangGraph, the Vercel AI SDK, ...) can point at it like they would point at
`api.openai.com` (see [Examples](#examples) below), without paying
per-token API rates on top of a subscription you already have — while
deliberately *not* exposing the CLI's own agentic capabilities (file
access, shell execution) to do it.
Every request is sandboxed away from those by default, with no way to opt
back into them (see "Agent sandboxing" under
[`POST /v1/chat/completions`](#post-v1chatcompletions) below) — this is a
plain chat/reasoning model behind an OpenAI-shaped API, not a
remote-controllable coding agent.

### Core philosophy

- **Local-only, single-user.** This is a development convenience, not a
  multi-tenant service. It binds to loopback by default and assumes one
  person, one machine, one turn at a time per `sessionId`.
- **No credential handling of its own.** DevBridge never asks for, stores,
  or transmits an Anthropic API key. Authentication is the CLI's own
  `/login` device-code flow, running exactly as it would in a real
  terminal; DevBridge only gives you a browser window to drive it from.
- **The CLI is the source of truth** for everything it's still allowed to
  decide under the sandbox below (what a turn's stop reason was, what it
  actually cost) — DevBridge translates wire formats and manages process
  lifecycles, it doesn't second-guess those.
- **No agent capability, no exceptions.** File access and shell execution
  are disallowed on every request, unconditionally — there is no header,
  field, or configuration that restores them. This is treated as a
  correctness property of the server, not a client-chosen default.

## Architecture

### Two execution paths, one CLI

DevBridge drives the same underlying `claude` binary through two genuinely
different interfaces, because the two jobs it does are genuinely different:

- **`POST /v1/chat/completions`** drives the CLI through its own
  non-interactive scripting interface: `claude -p --output-format
  stream-json --include-partial-messages --verbose --permission-prompts
  none`, launched with plain `child_process.spawn` — no pseudo-terminal.
  This is the CLI's documented scriptable mode: it emits newline-delimited
  JSON events with real per-token streaming and exact token usage, and it
  exits cleanly when the turn is done. There is no terminal-prompt
  guessing — the CLI itself emits a final `result` event that says the turn
  is over, so there's nothing to scan for or time out waiting on in the
  happy path.
  - `--permission-prompts none` turns any tool-approval prompt that would
    otherwise block on a live human into a denial instead of a hang
    (there's no attached terminal to approve it in this mode). It does
    **not** change what the permission *mode* itself allows: a tool
    already allow-listed by your own Claude Code settings
    (`~/.claude/settings.json`, a project's `.claude/settings.json`) still
    runs unattended here exactly as it would in an interactive session. A
    tool invocation that just hangs (not a permission prompt) is bounded
    only by `EXEC_TIMEOUT_MS`, the same as everything else.
  - Multi-turn continuity comes from replaying the full `messages` array
    into every turn's prompt, not from CLI-side session state: there's no
    `--session-id`/`--resume`, and no long-lived process kept around
    between requests — each turn is a fresh `spawn()` that exits when it's
    done, with the whole conversation (including any prior tool calls and
    their results) serialized into that one turn's stdin. This matches the
    real OpenAI API's own statelessness — the client resends history, the
    server holds none of it — which is also what makes tool calling (below)
    possible at all: a tool's result only ever exists in the client's own
    message list.
- **The dashboard's login flow** (`WS /api/session/stream`, `login:*`
  frames) still drives a real interactive session through `node-pty`,
  because completing the `/login` device-code flow genuinely needs one —
  the non-interactive path above denies prompts rather than showing them,
  so it can't do this. Unlike every other PTY use this project has had,
  there is exactly **one** of these at a time, globally, independent of
  any project: it's spawned on demand when the dashboard asks to sign in,
  and garbage-collected (on completion, on the dashboard disconnecting, or
  after a timeout) rather than left running — see
  [`WS /api/session/stream`](#ws-apisessionstream). It has nothing to do
  with chat-completions' own sessions; the two don't share state.

### Project layout

```
src/
  server.js            Express app wiring: same-origin/DNS-rebinding guard,
                        mounts both routers, sets up the WS upgrade handler.
  config.js             Reads PORT/HOST/CLAUDE_CONFIG_DIR/timeout env vars.
  claudeCliRunner.js     Non-PTY path: spawns `claude -p --output-format
                        stream-json`, parses NDJSON events, intercepts
                        client tool-call proposals and stop-sequence
                        matches, always sandboxes the CLI's native
                        persona/tools (no opt-out), exposes
                        runTurn({content, projectPath, tools,
                        stopSequences, ...}) -> {promise, kill}.
  historySerializer.js   Renders the full OpenAI messages[] array (including
                        prior tool_calls/tool results) into the plain-text
                        prompt sent to the CLI's stdin — this is what makes
                        every turn stateless, full-history replay instead
                        of CLI-side session continuity.
  mcpBridge.js            Builds a per-request MCP server config + stub
                        tool-list file for a request's client-declared
                        `tools`, and its cleanup; exports MCP_SERVER_NAME.
  mcpStubServer.mjs       The actual stdio MCP server process mcpBridge.js
                        points the CLI at. Reports the client's real tool
                        schemas; its call handler is never meant to run —
                        claudeCliRunner.js kills the CLI process before it
                        would ever dispatch to it.
  turnSessions.js        In-memory sessionId -> {projectPath, claudeSessionId,
                        status, lastRequest, lastResult, lastError} store for
                        the chat-completions path; publishes session:update
                        on every mutation. claudeSessionId is observability
                        only now — it's never fed back into a later turn.
  turnEvents.js           Tiny pub/sub bus decoupling publishers
                        (chatCompletions, turnSessions) from the dashboard's
                        WS subscribers.
  loginSession.js         Single-slot PTY dedicated to the `/login` flow:
                        spawns on demand, reused while active, garbage
                        collected on completion/disconnect/timeout.
  sessionErrors.js       Shared SessionConflictError / InvalidProjectPathError.
  routes/
    chatCompletions.js   POST /v1/chat/completions — validation (including
                        tools/tool_choice/stop), streaming, usage mapping,
                        error-type mapping, turnSessions/turnEvents updates
                        for the dashboard.
    models.js            GET /v1/models.
  ws/
    sessionStream.js      WS /api/session/stream handler: session snapshot +
                        live events on connect, login:* frame handling.
  timeoutGuard.js         withTimeout(promise, onTimeout, timeoutMs) helper.
public/
  index.html, app.js,     Minimal admin dashboard: read-only project/session
  style.css               tree with live status, sign-in flow. Plain text
                        throughout — no terminal emulator, since neither the
                        login flow nor the observability view renders one.
test/                     vitest + supertest; one test file per src/ module
                        (plus one for public/terminalBuffer.js, the
                        dashboard's own minimal ANSI-handling virtual
                        terminal).
Dockerfile                node:20-bookworm-slim + globally installed CLI.
```

## Local development

```bash
npm install
npm start
```

The server binds to `127.0.0.1:3000` by default. Open
`http://127.0.0.1:3000/` for the dashboard. Configuration is read from
environment variables — see `.env.example`:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port. |
| `HOST` | `127.0.0.1` | Bind address. Keep this loopback outside Docker. |
| `CLAUDE_CONFIG_DIR` | CLI default (`~/.claude`) | Where the CLI persists auth/session data. |
| `EXEC_TIMEOUT_MS` | `120000` | Max time a single turn may run before it's killed. |
| `READINESS_TIMEOUT_MS` | `5000` | Max time to wait for the login PTY to become ready. |
| `READINESS_SETTLE_MS` | `250` | Quiet period used to decide the login PTY has finished its startup banner. |
| `TRUSTED_HOSTS` | *(empty)* | Comma-separated hostnames (no port — ports are ignored, same as the loopback check) explicitly trusted in addition to `127.0.0.1`/`localhost`/`::1`. For a gateway (LiteLLM, Open WebUI, ...) running in its own container on a private network — see [Using with LiteLLM and other gateways](#using-with-litellm-and-other-openai-compatible-gateways). Never set this to a wildcard or to a hostname you don't control. |

## Running tests

```bash
npm test
```

230+ tests across 14 files (`vitest` + `supertest`), no network access and
no real CLI invocation in the suite itself — the CLI process is always
injected (`spawnFn`) and faked. Every chat-completions behavior described
below (tool calling, `stop`, `tool_choice`, agent sandboxing, full-history
replay) was also exercised live against the real CLI during development;
this test suite is the one that runs in CI.

## Building and running the Docker image

```bash
docker build -t devbridge .

docker run -d --name devbridge \
  -p 127.0.0.1:3000:3000 \
  -v devbridge-claude-config:/data/.claude \
  devbridge
```

- `devbridge-claude-config` is a named Docker volume that persists auth
  tokens, device configuration, and session history across container
  restarts (`CLAUDE_CONFIG_DIR=/data/.claude` inside the container). This
  is the only volume the chat-completions path needs — there's no reason
  to mount a project directory into the container, since every request is
  sandboxed away from the filesystem by default with no opt-out (see
  "Agent sandboxing" under [`POST /v1/chat/completions`](#post-v1chatcompletions)
  below); `projectPath` defaults to a fixed temp directory on its own.
- The image binds the server to `0.0.0.0` *inside* the container — the
  `-p 127.0.0.1:3000:3000` above is what keeps it off the network, same as
  local dev's own `127.0.0.1` default. Docker's port-forward lands on the
  container's own network interface, not its loopback, so a server bound
  to `127.0.0.1` inside the container would be unreachable even with a
  published port — the host-side `127.0.0.1:` prefix is the thing actually
  enforcing network isolation here. **Don't publish the port without
  it.**
- The build needs `python3 make g++` (installed in the image) because
  `node-pty`'s native addon has to compile for the debug-terminal path; the
  chat-completions path has no native dependencies of its own.
- The CLI version is pinned in the `Dockerfile` deliberately: both
  execution paths depend on this exact version's event shapes/behavior.
  Bumping it means re-verifying both paths, not just updating a number.

## Signing in (`/login` flow)

1. Open the dashboard at `http://127.0.0.1:3000/` and click **Sign In**.
2. This spawns a dedicated login session (independent of any project) and
   types `/login` into it; the CLI's login URL and confirmation code
   appear as a clickable link once they show up in its output — open the
   link and authorize in your browser.
3. Click **Next**, then **Done** once you've authorized — the dashboard
   also auto-detects completion from the CLI's own output, so **Done** is
   a confirmation, not the only trigger. The login session is torn down
   once it's done (or if you close the tab, or after a timeout either way).

There's no "add session" step any more: sessions only ever appear once a
real request comes in through `/v1/chat/completions`, grouped by project in
the dashboard's navigator, purely for observability — you can't type into
them.

Once signed in, the `devbridge-claude-config` volume keeps you signed in
across container restarts — there's no separate credential step for the
`/v1/chat/completions` path; it uses the same CLI auth state.

## API

### `POST /v1/chat/completions`

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'X-Session-Id: s1' \
  -d '{
    "model": "opus",
    "messages": [{ "role": "user", "content": "say OK" }]
  }'
```

(`X-Session-Id` is the only thing you have to set — see "Session
identity" just below.)

```json
{
  "id": "chatcmpl-local-s1-1730000000000",
  "object": "chat.completion",
  "created": 1730000000,
  "model": "claude-opus-5-5",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "OK", "refusal": null },
      "finish_reason": "stop",
      "logprobs": null
    }
  ],
  "usage": {
    "prompt_tokens": 11382,
    "completion_tokens": 4,
    "total_tokens": 11386,
    "prompt_tokens_details": { "cached_tokens": 11200 }
  }
}
```

**Session identity**

- `sessionId` is required, as the `X-Session-Id` header (preferred — this
  keeps the JSON body pure OpenAI wire format, so an off-the-shelf OpenAI
  SDK with a default header configured needs no payload changes at all)
  or as a `sessionId` body field (still supported for backward
  compatibility; a header wins if both are given). This is the only field
  you have to set — see "Agent sandboxing" just below for why
  `projectPath` isn't required too.
- `projectPath` (`X-Project-Path` header or body field, same precedence
  rule) is optional. If given, it must be an absolute path that exists and
  is a directory inside the container (400 `invalid_project_path`
  otherwise, checked *before* anything is spawned). If omitted entirely —
  from both the header and the body — it defaults to a fixed system temp
  directory (`os.tmpdir()`), since nothing in the sandboxed default mode
  touches the filesystem anyway.
- The same `sessionId` must always be paired with the same `projectPath`
  (409 `session_conflict` otherwise — this catches accidentally reusing an
  id across two different projects). This still applies to the defaulted
  value: if you ever send an explicit `projectPath` for a `sessionId` that
  first ran without one, that's a conflict against the default it already
  got.

**Agent sandboxing — not Claude Code**

- Every request, unconditionally, gets a corrected system prompt (telling
  the model it's a plain chat/reasoning model via an OpenAI-compatible
  API, not Claude Code working in a project directory) and the CLI's
  entire built-in tool set disallowed via `--disallowedTools` — confirmed
  live against a fresh, plugin-free config directory, this exact list:
  `Task`, `Bash`, `CronCreate`, `CronDelete`, `CronList`, `DesignSync`,
  `Edit`, `EnterWorktree`, `ExitWorktree`, `ListAgents`, `Monitor`,
  `NotebookEdit`, `PushNotification`, `Read`, `RemoteTrigger`,
  `ReportFindings`, `ScheduleWakeup`, `SendMessage`, `Skill`, `TaskStop`,
  `ToolSearch`, `WebFetch`, `WebSearch`, `Workflow`, `Write`. This exists
  because the underlying CLI still defaults to its real persona and full
  tool surface — without correcting for that, a plain chat call (e.g.
  driving a non-coding LangGraph agent) can get coding-flavored answers,
  or have the model actually try to read files or run shell commands that
  have nothing to do with the request.
- **There is no opt-out.** No header, request field, or configuration
  restores the CLI's native tools or persona — this used to be
  configurable per request (an `X-Agent-Mode: coding` header), and that
  escape hatch was removed on purpose: any value sent for that header
  today is silently ignored, so a deployment behind a gateway other
  clients can reach has no way for any of them — intentionally or by
  accident — to get real file/shell access through this server.
- Client-declared `tools` (OpenAI-style function-calling, below) work
  independently of this — real function-calling always works, while the
  CLI's own native tools stay suppressed.
- Because nothing touches the filesystem, `projectPath` is optional: if
  omitted from both the header and the body, it defaults to a fixed
  system temp directory (Node's `os.tmpdir()`) — see "Session identity"
  just above. Only set it explicitly if you have some other reason to
  care what directory the process runs in.

**Request fields**

- `model` is optional and passed straight through to `--model` (accepts
  the CLI's own aliases, e.g. `opus`/`sonnet`/`haiku`, or a full model
  name), restricted to a safe charset (letters, numbers, `. - _ :`) so it
  can never become an unsafe `spawn()` argv element. The non-streaming
  response always reports the model that actually served the request; in
  a streaming response only the *last* chunk does — the first (role)
  chunk is sent immediately, before the CLI has reported which model
  picked up the turn, so it echoes back whatever alias you requested.
- Any `role: "system"` messages are joined (`\n\n`-separated) and sent as
  `--append-system-prompt`.
- The entire `messages` array (minus `system`/`developer` entries, handled
  separately above) is replayed into the new turn's prompt, every call —
  every prior `user`/`assistant` message, any `assistant` message's
  `tool_calls`, and any `tool`-role result. There's no CLI-side session to
  hold that history instead: send the full OpenAI-style running transcript
  every time, exactly as you would against the real API.
- `content` may be a plain string or an OpenAI-style array of
  `{"type": "text", "text": "..."}` parts, which are concatenated. A
  message with genuinely empty text content contributes nothing to the
  replayed prompt (not an empty role label).
- `role: "developer"` messages are treated identically to `role: "system"`
  (OpenAI's newer name for the same thing).
- `role: "tool"` messages (a `tool_call_id` plus the function's result)
  are replayed as part of the history — this is how a client's tool-call
  loop continues the conversation after executing a call itself.

**Response fields**

- `usage` reflects the CLI's real token accounting: `prompt_tokens` is
  `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`
  (everything the turn paid to read as context, including anything served
  from cache), `completion_tokens` is `output_tokens`.
- `usage.prompt_tokens_details.cached_tokens` reports `cache_read_input_tokens`
  specifically (OpenAI's own usage-details convention), for clients doing
  cache-aware cost math.
- `finish_reason` is `"length"` when the CLI's own stop reason was
  `max_tokens`, `"stop"` otherwise.
- `message.refusal` and `choices[].logprobs` are always `null` — present for
  shape compatibility with strict OpenAI clients, never populated (the CLI
  doesn't produce either).

### OpenAI API field compatibility

This proxy wraps an agentic CLI, not a raw sampling endpoint, so not every
OpenAI Chat Completions field has something to map onto. Each request field
falls into one of four buckets:

| Supported & mapped | Accepted, silently ignored | Mapped to a real CLI flag | Rejected (400) |
|---|---|---|---|
| `model`, `messages`, `stream`, `stream_options.include_usage`, `tools`, `tool_choice` (all four forms), `stop` | `temperature`, `top_p`, `frequency_penalty`, `presence_penalty`, `logit_bias`, `seed`, `user`/`prompt_cache_key`, `metadata`, `store`, `service_tier`, `prediction`, `moderation`, `parallel_tool_calls`, `safety_identifier`, `max_tokens`/`max_completion_tokens`, `modalities: ["text"]`, `logprobs: false` | `reasoning_effort` → `--effort`; `response_format` (`json_schema` variant) → `--json-schema`; `tools` → a per-request `--mcp-config` (see below); `tool_choice: "required"`/forced-name → a best-effort system-prompt instruction (see below); `stop` → runner-side text matching, no CLI flag | `functions`, `function_call`, `n > 1`, `logprobs: true`, `top_logprobs`, `modalities` containing anything other than `"text"`, `audio` |

**Why `logprobs`/`modalities` are conditionally rejected, not just ignored**:
both default to the CLI's actual behavior (no logprobs, text-only), so the
default value is a true no-op — but `logprobs: true` or `modalities:
["text", "audio"]` is the client asking for something the CLI cannot
produce. Silently returning the default (`logprobs: null`, text output)
instead of what was requested is the same "misrepresents what happened"
risk as the `tools` gap below, not a harmless default to ignore.

**Why the "accepted, silently ignored" fields aren't errors**: most real
OpenAI client SDKs send several of these with default values on every call
(e.g. `temperature: 1`) whether or not the caller set them explicitly —
rejecting their mere presence would break those clients for no benefit,
since there's nothing to enforce differently anyway. `max_tokens` falls
here too: there's no CLI flag that caps output length directly (only
`--max-budget-usd`, a dollar cap, not a token cap), so it's accepted and
ignored rather than rejected, to match how the other sampling knobs are
treated.

**`reasoning_effort` → `--effort`**: the CLI genuinely has an equivalent
(`--effort <low|medium|high|xhigh|max>`). Only those five values are
accepted; OpenAI's `"none"`/`"minimal"` have no CLI equivalent and are
rejected with 400 rather than silently clamped to the nearest supported
level.

**`response_format` → `--json-schema`**: only the `json_schema` variant
maps to anything real — the CLI's `--json-schema <schema>` flag is actually
enforced (verified live: a request with a schema requiring a specific field
gets back content that validates against it). `"text"` (the default) and
`"json_object"` are no-ops; OpenAI itself only weakly enforces
`json_object` too ("the model must be told to produce JSON in a system or
user message"), so nothing is lost by not enforcing it here either.
`response_format.json_schema` without a `schema` field is a 400.

**How `tools` actually works: an MCP bridge, not an agent-executes
shortcut**. OpenAI's tool calling is a *client-executes* contract — the
model proposes `tool_calls` with arguments, the caller runs the real
function and reports the result back in a follow-up request. The CLI's own
tools (Bash, Edit, Read, ...) are *agent-executes*: they run inline, inside
a single turn, the moment the agent decides to use them, with no point
where it pauses and waits for a caller-supplied result — that mismatch is
still real and is why `functions`/`function_call` (the deprecated OpenAI
aliases) stay rejected outright, rather than quietly mapped onto something
that behaves differently.

For `tools`/`tool_choice`, the gap is closed instead of worked around:
each `tools` entry is registered as a tool on a per-request stub MCP
server (`--mcp-config`/`--strict-mcp-config`/`--allowedTools`), reporting
the client's real JSON Schema so the model proposes correctly-shaped
arguments. That stub's own tool handler is never meant to actually run —
the moment the CLI's stream reports a client tool call fully formed
(`message_delta` with `stop_reason: "tool_use"`), the CLI process is
killed before it would ever dispatch to the stub, and the proposed
`tool_calls` (name + arguments, assembled from the same `input_json_delta`
events Claude's own native tool-use streaming uses) are returned to the
client with `finish_reason: "tool_calls"` — exactly where real OpenAI
stops, before any execution. The client executes the tool itself and
calls back with the result appended to `messages`, same as it would
against the real API. CLI-native tool use (Bash, Edit, ...) in the same
turn runs and completes normally — it was never represented in the OpenAI
response shape anyway — and only a client-declared call ever stops the
turn.

Each `tools[].function.name` is restricted to OpenAI's own function-name
charset (`^[A-Za-z0-9_-]{1,64}$`, 400 otherwise) and must be unique within
the request (400 on a duplicate). This isn't just strictness for its own
sake: a name becomes an `--allowedTools` argv entry the CLI itself parses
for scoped-permission syntax (e.g. `"Bash(git *)"`, comma/space-separated
lists), so an unrestricted name could otherwise smuggle in an extra
permission rule — this charset closes that off entirely.

**`tool_choice: "required"`/forced-name tool — best-effort, not a
guarantee.** There is no CLI flag that actually forces a tool call; the
only lever is a system-prompt instruction appended to the turn ("you must
call one of the client-declared tools" or, for a forced name, "you must
call `<name>`"). For a forced named tool, `--allowedTools` is also
narrowed to just that one tool — closer to deterministic than the generic
case, since the model has nothing else it's approved to call — but
neither is a hard guarantee the way real OpenAI's `required` is: the
model can still, occasionally, respond with plain text instead. Both
`tool_choice: "required"` and a forced name need at least one entry in
`tools` (400 otherwise); a forced name must actually appear in `tools`
(400 otherwise).

**`stop` — one string or an array of up to 4, matched against the
output text as it's generated**, not a CLI flag (none exists for this
either). The runner tracks the accumulated text per message and checks it
against every stop sequence on each chunk; on the earliest match, the CLI
process is killed immediately (the same early-termination pattern tool
calls use, so a stop match doesn't keep paying for tokens generated past
it) and the response is truncated right before the match, with
`finish_reason: "stop"`. One honestly-documented limitation: `usage` on a
stop-triggered turn is necessarily partial (the CLI's own final token
count arrives in an event this path never reaches, since the process is
killed before it would fire) — `prompt_tokens` is still accurate,
`completion_tokens` reflects only what had been reported at the moment of
the match, not a full count. In streaming mode, a stop sequence that
happens to split exactly across two delta chunks can leak a few
characters to the client before the match completes and truncation
catches up — real but rare given this CLI's chunking granularity;
non-streaming responses have no such risk, since the full text is
available before truncating.

**Streaming**

- Set `"stream": true` for Server-Sent Events of `chat.completion.chunk`
  objects (OpenAI wire format): a role-chunk first, then one delta chunk
  per token (`delta: {content}`) or tool-call argument fragment, a final
  chunk carrying `finish_reason`, all terminated by `data: [DONE]`.
- When `tools` are given, tool-call arguments stream incrementally too —
  real argument deltas (assembled from the same `input_json_delta` events
  Claude's own native tool-use streaming uses), not one batched chunk at
  the end. The first chunk for a given call carries `delta.tool_calls:
  [{index, id, type: "function", function: {name, arguments: ""}}]`;
  later chunks for the same `index` carry only
  `delta.tool_calls: [{index, function: {arguments: "<fragment>"}}]` —
  `index` is 0-based and gapless among tool calls only, never the raw
  position among any preceding text in the same message. The final chunk
  carries `finish_reason: "tool_calls"`.
- Add `"stream_options": {"include_usage": true}` for a trailing
  usage-only chunk (`choices: []`, `usage: {...}`) before `[DONE]`,
  matching the real OpenAI API's own convention.
- If a turn fails *after* streaming has already started (timeout, crash,
  an `isError` result), an error-shaped chunk (`{"error": {"message":
  ..., "type": ...}}`) is written before `[DONE]` instead of silently
  ending the stream as if it had succeeded — this is the shape OpenAI
  SDKs look for to raise an `APIError` out of a stream.

**Errors**

- A turn the assistant itself ends in an error (a denied tool call it
  can't recover from, etc.) comes back as `500 {"error": {"type":
  "assistant_error"}}` rather than a `200` with made-up content.
- A turn that doesn't finish within `EXEC_TIMEOUT_MS` comes back as `504
  {"error": {"type": "timeout"}}` and the CLI process is killed (SIGTERM,
  escalating to SIGKILL after a grace period if it doesn't exit).
- A second request for a `sessionId` that already has a turn in flight
  gets `503 {"error": {"type": "session_busy"}}` with `Retry-After: 1` —
  a given `sessionId`'s turns are serialized, one at a time; different
  `sessionId`s run fully concurrently (see
  [Known limitations](#known-limitations) for what bounds that).
- Error responses use OpenAI's generic type names where one exists
  (`invalid_request_error`, `server_error`) and proxy-specific ones where
  it doesn't (`invalid_project_path`, `session_conflict`, `session_busy`,
  `timeout`, `assistant_error`).
- `invalid_request_error`, `invalid_project_path`, `session_conflict`, and
  `assistant_error` responses set `x-should-retry: false` (retrying
  `assistant_error` in particular could re-run a turn that already
  executed side-effecting tools); `session_busy` sets `Retry-After`.

### `GET /v1/models`

Lists the model aliases the CLI itself exposes (`opus`, `sonnet`, `haiku`,
`fable`), for clients that probe this before use. Open WebUI and similar
tools call this to populate a model picker; the response shape
(`{"object": "list", "data": [{"id", "object": "model", "created",
"owned_by"}]}`) matches OpenAI's own `GET /v1/models`.

### Using with LiteLLM and other OpenAI-compatible gateways

`POST /v1/chat/completions`, `GET /v1/models`, SSE streaming, and the
error-object shape all follow OpenAI's wire format closely enough that
LiteLLM's `openai`/`openai_compatible` provider, Open WebUI, or any other
tool that treats an `api_base` as a drop-in OpenAI backend can point at
DevBridge directly. Two things to get right:

1. **`api_base` must be `http://<host>:<port>/v1`**, nothing after it —
   these clients append `/chat/completions`, `/models`, etc. themselves.
2. **Network reachability.** DevBridge enforces same-origin/DNS-rebinding
   protection (see [Non-functional / safety requirements](#non-functional--safety-requirements))
   by checking the `Host` and `Origin` headers against a fixed allowlist.
   - If the gateway runs **on the same host** and calls
     `http://127.0.0.1:3000/v1` or `http://localhost:3000/v1`, this just
     works — the `Host` header is already loopback, no configuration
     needed.
   - If the gateway runs in **its own container** (e.g. the same
     docker-compose network, reached by service name), its requests arrive
     with a non-loopback `Host` header and get a `403 forbidden host`
     until you explicitly trust that one hostname: set
     `TRUSTED_HOSTS=<gateway-service-name>` (comma-separate more than
     one). This is a named exception, not a wildcard — everything else is
     still denied by default.
   - An API key sent as `Authorization: Bearer <anything>` (LiteLLM always
     sends one) is accepted and ignored; DevBridge has no credentials of
     its own to check it against.

### Known limitations

- Full-history replay means there's no CLI-side session to resume — each
  call is a genuinely fresh process, with no server-held conversation
  state between requests, matching real OpenAI semantics (the client owns
  history, the server holds none of it). Anthropic's own prompt caching is
  prefix-based, so a call whose replayed history shares an unchanged
  prefix with an earlier call (the common case: a conversation that only
  grows by appending) may still see `cache_read` hits on that prefix —
  this hasn't been verified against a fresh `-p` process with no
  `--resume`, so don't assume it either way without checking
  `usage.prompt_tokens_details.cached_tokens` on your own calls.
- A long-running turn that's actively streaming is still bounded by the
  same flat `EXEC_TIMEOUT_MS` as everything else, not an idle timer reset
  on each token — a legitimately long agentic turn can hit it.
- Single-process, single-container: there is no clustering, no shared
  session store across replicas, and no queueing beyond the one-turn-at-a-
  time-per-`sessionId` lock described above.
- No built-in concurrency cap. Different `sessionId`s run fully
  concurrently — each spawns its own real `claude` process (plus a second
  one for the MCP stub, when `tools` are given) — so the practical ceiling
  is whatever's actually finite: host CPU/memory for however many
  concurrent processes that is, and the authenticated account's own
  Anthropic API rate limits (concurrent-request/tokens-per-minute caps
  tied to the subscription), neither of which DevBridge can see or raise.
  Scaling past one host means running more containers behind a load
  balancer that routes a given `sessionId` consistently to the same one —
  there's no shared state across replicas to make that automatic.
- `usage` on a `stop`-triggered turn is necessarily partial — see
  the `stop` field's own description above for why.

### `WS /api/session/stream`

Serves two unrelated purposes over the same connection: a read-only live
feed of chat-completions activity, and driving the one dedicated login
PTY. There is no write access to a chat-completions session from here —
observability only.

**On connect**, the server immediately sends a snapshot of every known
session:

```json
{ "type": "snapshot", "sessions": [{ "sessionId", "projectPath", "claudeSessionId", "status", "lastRequest", "lastResult", "lastError" }] }
```

**Outbound (server to UI), as activity happens:**

```json
{ "type": "session:update", "session": { "...same shape as above" } }
{ "type": "session:delta", "sessionId": "string", "text": "assistant text chunk" }
{ "type": "login:output", "data": "raw PTY output chunk" }
{ "type": "error", "data": "string" }
```

`status` is one of `idle` / `running` / `error`. `session:delta` fires
for every turn's streamed text, whether or not the original HTTP request
itself asked for `stream: true`.

**Inbound (UI to server), for the login flow only:**

```json
{ "type": "login:start" }
{ "type": "login:input", "data": "string" }
{ "type": "login:complete" }
```

`login:start` spawns the login PTY if one isn't already running (reused
otherwise) and types `/login` once it's ready. `login:input` forwards raw
text to it — used for whatever paste-back step, if any, the flow needs.
`login:complete` disposes it; so does the WS connection closing while a
login is pending, and so does a safety timeout if neither fires.

## Examples

[`examples/`](examples) has minimal, runnable examples pointing real
frameworks and SDKs at DevBridge: plain `curl` and the official `openai`
SDK, the Vercel AI SDK, LangChain (with a full tool-calling round trip),
and a Python deepagents agent. Each is self-contained with its own
`package.json`/`requirements.txt`, and documents the one or two gotchas
that framework has when pointed at a non-`api.openai.com` Chat Completions
backend (e.g. the Vercel AI SDK's bare `openai()` provider silently
targeting the Responses API, or deepagents' `"openai:..."` string
shorthand ignoring any custom `base_url`).

## Non-functional / safety requirements

These are the project's hard constraints, not just defaults someone could
reconfigure away:

1. **No external credentials.** DevBridge never requests, stores, or
   transmits an Anthropic developer API key. The CLI's own `/login`
   device-code flow is the only authentication path, and it runs exactly
   as it would in a real terminal.
2. **Network isolation.** The server binds to `127.0.0.1` by default, and
   the Docker instructions above exist specifically to preserve that
   outside a container too — the published port is deliberately prefixed
   with `127.0.0.1:` rather than left open on all interfaces.
3. **Same-origin / DNS-rebinding protection.** Every HTTP route and the WS
   upgrade both check `Host` *and* `Origin` independently against a fixed
   allowlist (`127.0.0.1`, `localhost`, `::1`, plus whatever hostnames
   `TRUSTED_HOSTS` explicitly names), because DNS rebinding can make an
   attacker-controlled hostname resolve to `127.0.0.1` — comparing `Host`
   and `Origin` to each other instead of to a fixed allowlist would prove
   nothing in that scenario. `TRUSTED_HOSTS` is an opt-in, named exception
   for a specific trusted peer (e.g. a gateway on a private docker-compose
   network — see [Using with LiteLLM and other gateways](#using-with-litellm-and-other-openai-compatible-gateways)),
   never a wildcard; the default allowlist is unchanged.
4. **Execution timeouts.** No turn runs unbounded: `EXEC_TIMEOUT_MS`
   bounds `/v1/chat/completions` turns (process killed on expiry); the PTY
   debug path has its own readiness/settle timeouts for startup.

## License

Private, unpublished project.
