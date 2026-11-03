# DevBridge

DevBridge is a local-only developer tool that wraps the official
`@anthropic-ai/claude-code` CLI and exposes it as an OpenAI-compatible HTTP
chat-completions endpoint, a WebSocket terminal stream, and a minimal admin
dashboard — all in a single Docker container.

## Why this exists

The Claude Code CLI already gives you a capable coding agent from the
terminal, backed by a Claude Pro/Team **subscription** rather than a
usage-priced API key. DevBridge's job is to make that same agent reachable
the way any other LLM backend is reachable: a standard HTTP endpoint that
takes OpenAI-style chat-completions requests, so local tools, scripts, and
OpenAI-SDK-based applications under active development can point at it like
they would point at `api.openai.com`, without paying per-token API rates on
top of a subscription you already have.

### Core philosophy

- **Local-only, single-user.** This is a development convenience, not a
  multi-tenant service. It binds to loopback by default and assumes one
  person, one machine, one CLI session at a time per `sessionId`.
- **No credential handling of its own.** DevBridge never asks for, stores,
  or transmits an Anthropic API key. Authentication is the CLI's own
  `/login` device-code flow, running exactly as it would in a real
  terminal; DevBridge only gives you a browser window to drive it from.
- **The CLI is the source of truth.** DevBridge translates wire formats and
  manages process lifecycles; it never second-guesses what the CLI itself
  decided (what tools ran, what a turn's stop reason was, what it actually
  cost).

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
  - Multi-turn continuity uses the CLI's own `--session-id` on a fresh
    turn and `--resume <id>` on later ones — there's no long-lived process
    kept around between requests; each turn is a fresh `spawn()` that exits
    when it's done.
- **The dashboard's debug terminal** (`WS /api/session/stream`) still
  drives a real interactive session through `node-pty`, because that's
  genuinely a different job: a human watching and typing into the actual
  CLI UI (most importantly, to complete the `/login` device-code flow,
  which the non-interactive path above can't do — it denies prompts rather
  than showing them). It's created via `POST /api/sessions` and is
  unrelated to chat-completions' own sessions — the two don't share
  `sessionId`s, don't share state, and a `sessionId` used with one means
  nothing to the other.

### Project layout

```
src/
  server.js            Express app wiring: same-origin/DNS-rebinding guard,
                        mounts both routers, sets up the WS upgrade handler.
  config.js             Reads PORT/HOST/CLAUDE_CONFIG_DIR/timeout env vars.
  claudeCliRunner.js     Non-PTY path: spawns `claude -p --output-format
                        stream-json`, parses NDJSON events, exposes
                        runTurn({content, projectPath, ...}) -> {promise, kill}.
  turnSessions.js        In-memory sessionId -> {projectPath, claudeSessionId}
                        store for the chat-completions path.
  sessionManager.js      PTY path: spawns/reuses node-pty sessions for the
                        debug terminal, waits for the CLI to be ready.
  sessionErrors.js       Shared SessionConflictError / InvalidProjectPathError.
  routes/
    chatCompletions.js   POST /v1/chat/completions — validation, streaming,
                        usage mapping, error-type mapping.
    models.js            GET /v1/models.
  ws/
    sessionStream.js      WS /api/session/stream handler for the debug terminal.
  timeoutGuard.js         withTimeout(promise, onTimeout, timeoutMs) helper.
public/
  index.html, app.js,     Minimal admin dashboard: session list, debug
  style.css               terminal (xterm.js), sign-in flow.
test/                     vitest + supertest; one file per src module above.
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
| `READINESS_TIMEOUT_MS` | `5000` | Max time to wait for a fresh PTY session (debug terminal) to become ready. |
| `READINESS_SETTLE_MS` | `250` | Quiet period used to decide the PTY has finished its startup banner. |
| `TRUSTED_HOSTS` | *(empty)* | Comma-separated hostnames (no port — ports are ignored, same as the loopback check) explicitly trusted in addition to `127.0.0.1`/`localhost`/`::1`. For a gateway (LiteLLM, Open WebUI, ...) running in its own container on a private network — see [Using with LiteLLM and other gateways](#using-with-litellm-and-other-openai-compatible-gateways). Never set this to a wildcard or to a hostname you don't control. |

## Running tests

```bash
npm test
```

120+ tests across one file per `src/` module (`vitest` + `supertest`), no
network access and no real CLI invocation — the CLI process is always
injected (`spawnFn`) and faked.

## Building and running the Docker image

```bash
docker build -t devbridge .

docker run -d --name devbridge \
  -p 127.0.0.1:3000:3000 \
  -v devbridge-claude-config:/data/.claude \
  -v /host/path/to/project:/app/workspace/project \
  devbridge
```

- `devbridge-claude-config` is a named Docker volume that persists auth
  tokens, device configuration, and session history across container
  restarts (`CLAUDE_CONFIG_DIR=/data/.claude` inside the container).
- Mount each project you want to work on under `/app/workspace/...` and
  pass that container path as `projectPath` (or `X-Project-Path`) in API
  requests.
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

1. Open the dashboard at `http://127.0.0.1:3000/`.
2. Add a session: enter a `sessionId` and the `projectPath` you mounted
   into the container (e.g. `/app/workspace/project`), then click **Add
   session**.
3. Select that session in the navigator, then click **Sign In**.
4. The CLI's login URL and confirmation code appear as a clickable link in
   the dashboard — open it and complete sign-in in your browser.

Once signed in, the `devbridge-claude-config` volume keeps you signed in
across container restarts — there's no separate credential step for the
`/v1/chat/completions` path; it uses the same CLI auth state.

## API

### `POST /v1/chat/completions`

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'X-Session-Id: s1' \
  -H 'X-Project-Path: /app/workspace/project' \
  -d '{
    "model": "opus",
    "messages": [{ "role": "user", "content": "say OK" }]
  }'
```

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

- `sessionId`/`projectPath` are required, as the `X-Session-Id` /
  `X-Project-Path` headers (preferred — this keeps the JSON body pure
  OpenAI wire format, so an off-the-shelf OpenAI SDK with default headers
  configured needs no payload changes at all) or as `sessionId`/
  `projectPath` body fields (still supported for backward compatibility; a
  header wins if both are given).
- The same `sessionId` must always be paired with the same `projectPath`
  (409 `session_conflict` otherwise — this catches accidentally reusing an
  id across two different projects).
- `projectPath` must be an absolute path that exists and is a directory
  inside the container (400 `invalid_project_path` otherwise, checked
  *before* anything is spawned).

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
- Only the *last* message's `content` becomes the new turn's prompt —
  earlier `user`/`assistant` messages aren't replayed, because the CLI
  session itself (resumed via `--session-id`/`--resume`) already has that
  history. Send the full OpenAI-style running transcript if you like; only
  its last entry and any `system` entries are used.
- `content` may be a plain string or an OpenAI-style array of
  `{"type": "text", "text": "..."}` parts, which are concatenated.
- `role: "developer"` messages are treated identically to `role: "system"`
  (OpenAI's newer name for the same thing).

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
| `model`, `messages`, `stream`, `stream_options.include_usage` | `temperature`, `top_p`, `frequency_penalty`, `presence_penalty`, `logit_bias`, `seed`, `user`/`prompt_cache_key`, `metadata`, `store`, `service_tier`, `prediction`, `moderation`, `parallel_tool_calls`, `safety_identifier`, `max_tokens`/`max_completion_tokens`, `modalities: ["text"]`, `logprobs: false` | `reasoning_effort` → `--effort`; `response_format` (`json_schema` variant) → `--json-schema` | `tools`, `tool_choice`, `functions`, `function_call`, `n > 1`, `logprobs: true`, `top_logprobs`, `modalities` containing anything other than `"text"`, `audio` |

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

**Why `tools`/`tool_choice`/`functions` are rejected outright, not
ignored**: OpenAI's tool calling is a *client-executes* contract — the
model proposes `tool_calls` with arguments, the caller runs the real
function and reports the result back in a follow-up request. The CLI's own
tools (Bash, Edit, Read, ...) are *agent-executes*: they run inline, inside
a single turn, the moment the agent decides to use them, with no point
where it pauses and waits for a caller-supplied result. There's no safe way
to no-op this: a client that expects `tool_calls` back and instead silently
gets an ordinary text reply could easily misread that as "the model chose
not to call anything," which is worse than a clear 400. (The CLI *can* load
MCP servers via `--mcp-config`, so a real bridge — the CLI calling out
mid-turn to a server that forwards to the HTTP client and waits for a
result — is possible in principle, but that's a standalone feature, not a
field mapping.)

**Streaming**

- Set `"stream": true` for Server-Sent Events of `chat.completion.chunk`
  objects (OpenAI wire format): a role-chunk first, then one delta chunk
  per token, a final chunk carrying `finish_reason`, all terminated by
  `data: [DONE]`.
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
  the CLI session itself can't run two turns concurrently.
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

- The `sessionId -> claudeSessionId` mapping lives in memory only.
  Restart the container (or crash before a session's very first turn
  completes) and that `sessionId` starts a brand-new CLI conversation on
  its next request — this is a deliberate choice over optimistically
  guessing at a CLI session id that might not actually exist yet to
  `--resume`, which would turn a recoverable "starts fresh" outcome into a
  permanent "every future request for this sessionId fails" one.
- A long-running turn that's actively streaming is still bounded by the
  same flat `EXEC_TIMEOUT_MS` as everything else, not an idle timer reset
  on each token — a legitimately long agentic turn can hit it.
- Single-process, single-container: there is no clustering, no shared
  session store across replicas, and no queueing beyond the one-turn-at-a-
  time-per-`sessionId` lock described above.

### `WS /api/session/stream`

Raw bidirectional terminal stream for the dashboard's debug console and
the `/login` flow, backed by a PTY session created with `POST
/api/sessions` (`{ "sessionId", "projectPath" }`).

Inbound (UI to server):

```json
{ "type": "input", "sessionId": "string", "data": "raw text/command string" }
```

Outbound (server to UI):

```json
{ "type": "output", "sessionId": "string", "data": "ansi escaped terminal screen text chunk" }
```

Only a `sessionId` already created via `POST /api/sessions` can be driven
this way; input for an unknown `sessionId` gets back a `{"type": "error"}`
frame instead.

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
