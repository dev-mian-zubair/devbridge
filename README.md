# DevBridge

A local-only developer tool that wraps the interactive `@anthropic-ai/claude-code`
CLI in a `node-pty` pseudo-terminal and exposes it as an HTTP chat-completions
endpoint, a WebSocket terminal stream, and a minimal admin dashboard. See
[`docs/PRD.md`](docs/PRD.md) for the full requirements.

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

- `POST /v1/chat/completions` — send a message to a session's Claude Code
  CLI and get back its reply once the terminal shows a prompt again. See
  `docs/PRD.md` §4.1 for the exact request/response shape.
- `WS /api/session/stream` — raw bidirectional terminal stream for a
  session, used by the dashboard's debug console and the `/login` flow. See
  `docs/PRD.md` §4.2.
