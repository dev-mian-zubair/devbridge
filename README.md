# DevBridge

A local-only developer tool that wraps the `@anthropic-ai/claude-code` CLI and
exposes it as an OpenAI-compatible HTTP chat-completions endpoint, a
WebSocket terminal stream, and a minimal admin dashboard. See
[`docs/PRD.md`](docs/PRD.md) for the original requirements.

Two independent execution paths share the CLI, each suited to what it does:

- **`POST /v1/chat/completions`** drives the CLI through its own
  non-interactive interface (`claude -p --output-format stream-json`), not a
  pseudo-terminal. This is the CLI's documented scriptable mode: it returns
  structured JSON events with real per-token streaming and exact token
  usage. `--permission-prompts none` turns any prompt that would otherwise
  block on a live human into a denial instead of a hang (there's no attached
  terminal to approve it in this mode) — it does not change what the
  permission *mode* itself allows: a tool already allow-listed by your own
  Claude Code settings (`~/.claude/settings.json`, a project's
  `.claude/settings.json`) still runs unattended here exactly as it would in
  an interactive session, and a stuck tool invocation (not a permission
  prompt) is only bounded by `EXEC_TIMEOUT_MS`, same as anything else.
  Multi-turn continuity uses the CLI's own `--session-id`/`--resume`, not a
  long-lived process.
- **The dashboard's debug terminal** (`WS /api/session/stream`) still drives
  a real interactive session through `node-pty`, because that's genuinely a
  different job: a human watching and typing into the actual CLI UI. It's
  created via `POST /api/sessions` and is unrelated to chat-completions'
  own sessions — the two don't share sessionIds.

## Local development

```bash
npm install
npm start
```

The server binds to `127.0.0.1:3000` by default (override with `PORT`/`HOST`
env vars — see `.env.example`). Open `http://127.0.0.1:3000/` for the
dashboard.

## Running tests

```bash
npm test
```

## Building and running the Docker image

```bash
docker build -t devbridge .

docker run \
  -p 127.0.0.1:3000:3000 \
  -v claude-config:/data/.claude \
  -v /host/path/to/project:/app/workspace/project \
  devbridge
```

- `claude-config` is a named Docker volume that persists auth tokens, device
  configuration, and session history across container restarts
  (`CLAUDE_CONFIG_DIR=/data/.claude` inside the container).
- Mount each project you want to work on under `/app/workspace/...` and pass
  that container path as `projectPath` in API requests.
- The image binds the server to `0.0.0.0` *inside* the container — the
  `-p 127.0.0.1:3000:3000` above is what keeps it off the network, same as
  local dev's own `127.0.0.1` default (PRD §5.2). Don't publish the port
  without the `127.0.0.1:` prefix.

## Signing in (`/login` flow)

1. Open the dashboard at `http://127.0.0.1:3000/`.
2. Add a session: enter a `sessionId` and the `projectPath` you mounted into
   the container (e.g. `/app/workspace/project`), then click **Add session**.
3. Select that session in the navigator, then click **Sign In**.
4. The CLI's login URL and confirmation code appear as a clickable link in
   the dashboard — open it and complete sign-in in your browser.

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
    { "index": 0, "message": { "role": "assistant", "content": "OK" }, "finish_reason": "stop" }
  ],
  "usage": { "prompt_tokens": 11382, "completion_tokens": 4, "total_tokens": 11386 }
}
```

- `sessionId`/`projectPath` are required, as the `X-Session-Id` /
  `X-Project-Path` headers (preferred — keeps the JSON body pure OpenAI wire
  format, so an off-the-shelf OpenAI SDK with default headers configured
  needs no payload changes) or as `sessionId`/`projectPath` body fields
  (still supported; a header takes precedence if both are given). The same
  `sessionId` must always be paired with the same `projectPath` (409
  `session_conflict` otherwise). `projectPath` must be an absolute path
  mounted into the container.
- `model` is optional and passed straight through to `--model` (accepts the
  CLI's own aliases, e.g. `opus`/`sonnet`/`haiku`, or a full model name),
  restricted to a safe charset (letters, numbers, `. - _ :`). The
  non-streaming response always reports the model that actually served the
  request; in a streaming response only the *last* chunk does — the first
  (role) chunk is sent immediately, before the CLI has reported which model
  picked up the turn, so it echoes back whatever alias you requested.
- Any `role: "system"` messages are joined and sent as `--append-system-prompt`.
  Only the *last* message's `content` becomes the new turn's prompt — earlier
  `user`/`assistant` messages aren't replayed, because the CLI session itself
  (resumed via `--session-id`/`--resume`) already has that history. Send the
  full OpenAI-style running transcript if you like; only its last entry and
  any `system` entries are used.
- `usage` reflects the CLI's real token accounting: `prompt_tokens` is
  `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`
  (everything the turn paid to read as context), `completion_tokens` is
  `output_tokens`.
- Set `"stream": true` for Server-Sent Events of `chat.completion.chunk`
  objects (OpenAI wire format), terminated by `data: [DONE]`. Add
  `"stream_options": {"include_usage": true}` for a trailing usage-only
  chunk before `[DONE]`, matching the real OpenAI API's own convention.
- A turn that the assistant itself ends in an error (denied tool call it
  can't recover from, etc.) comes back as `500 { "error": { "type":
  "assistant_error" } }` rather than a 200 with made-up content. A turn that
  doesn't finish within `EXEC_TIMEOUT_MS` comes back as `504 { "error": {
  "type": "timeout" } }` and the CLI process is killed.
- `GET /v1/models` lists the model aliases the CLI itself exposes
  (`--model <alias>`), for clients that probe this before use.
- Error responses use OpenAI's generic type names where one exists
  (`invalid_request_error`, `server_error`) and proxy-specific ones where it
  doesn't (`invalid_project_path`, `session_conflict`, `session_busy`,
  `timeout`, `assistant_error`). `invalid_request_error`, `invalid_project_path`,
  `session_conflict`, and `assistant_error` responses set
  `x-should-retry: false`; `session_busy` sets `Retry-After`.

### Known limitations

- The `sessionId -> claudeSessionId` mapping lives in memory only. Restart
  the container (or crash before a session's very first turn completes) and
  that `sessionId` starts a brand-new CLI conversation on its next request —
  this is a deliberate choice over optimistically guessing at a CLI session
  id that might not actually exist yet to `--resume`, which would turn a
  recoverable "starts fresh" outcome into a permanent "every future request
  for this sessionId fails" one.
- A long-running turn that's actively streaming is still bounded by the
  same flat `EXEC_TIMEOUT_MS` as everything else, not an idle timer reset on
  each token — a legitimately long agentic turn can hit it.

### `WS /api/session/stream`

Raw bidirectional terminal stream for the dashboard's debug console and the
`/login` flow, backed by a PTY session created with `POST /api/sessions`
(`{ "sessionId", "projectPath" }`). See `docs/PRD.md` §4.2 for the frame
shapes.
