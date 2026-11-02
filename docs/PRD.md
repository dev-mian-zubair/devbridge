# Product Requirement Document: DevBridge CLI Proxy (Local-Only Development Gateway)

> Source PRD, saved as provided on 2026-11-02. Requirements text is unchanged; only
> the chat framing around it was removed. Later decisions belong in separate docs.

## 1. Objective & Scope

The objective is to build a lightweight, local-only developer tool that acts as an API proxy gateway. It wraps the official interactive `@anthropic-ai/claude-code` CLI using a Pseudo-Terminal (PTY) runner and exposes it as a standard HTTP/Websocket API.

This tool allows local applications under active development to utilize the advanced agentic coding features of Claude Code for free, leveraging an active consumer Claude Pro/Team Web Subscription rather than commercial, usage-priced Anthropic API platform keys.

### Core Philosophy

- **Local Sandboxing Only:** Built strictly for development environments. It does not scale for production multi-tenancy.
- **Stateful-to-Stateless Bridging:** Adapts an interactive, long-lived terminal shell session into deterministic API endpoints.

## 2. System Architecture & Components

The application consists of a single Docker container containing three core layers:

1. **Administration Dashboard (Frontend UI):** A minimal browser-based dashboard to manage sessions, check terminal authentication health, initiate the `/login` workflow, and view terminal history.
2. **Proxy Gateway Controller (Backend Server):** A Node.js application driving the interactive CLI lifecycle over TTY layers and exposing HTTP REST and WebSocket interfaces.
3. **The Target Environment (Isolated CLI):** The globally installed `@anthropic-ai/claude-code` package running inside a real Unix pseudo-terminal emulator (`node-pty`).

## 3. Detailed Component Requirements

### Component A: Backend API & PTY Driver

- **Technology:** Node.js (ESModules), `express`, `node-pty`, `ws`, `strip-ansi`.
- **State Management:** Maintain an in-memory registry map (`activeSessions`) pairing unique strings (`sessionId`) to structural objects containing the `node-pty` instance, state configuration, and locked data listeners.

#### Requirement 1: Terminal Emulation

- The backend must initialize terminal processes using `node-pty.spawn()` to preserve real TTY environments. Standard `child_process` hooks are strictly prohibited due to buffering blocks.
- Emulation settings: `cols: 120`, `rows: 40`, `name: 'xterm-256color'`.

#### Requirement 2: Dynamic Workspace Switching

- The `POST /api/chat` request body must accept a `projectPath` parameter.
- If a session is spun up fresh, its PTY working directory (`cwd`) must be set directly to the absolute path of that mounted project folder inside the container.

#### Requirement 3: Stream Interception & EOT (End of Transmission) Detection

- Because the Claude CLI is an interactive loop, the backend must dynamically determine when the assistant has finished its reply.
- The system must scan incoming text stream buffers for Terminal prompt sequence flags (e.g., the standard `❯` cursor marker, or trailing user input cues like `?`).
- Once the marker is detected, it must instantly unhook the event listener, strip terminal ANSI styling characters (`strip-ansi`), and return the response.

### Component B: Frontend Admin UI

- **Technology:** Vanilla HTML5/JS or React, using `xterm.js` for the terminal canvas.
- **Layout Requirements:**
  - **Status Bar:** Displays whether the CLI is authenticated or requires interaction.
  - **Session Navigator:** Vertical list showing active workspace mappings.
  - **Auth Overlay Button:** A "Sign In" utility trigger. When pressed, it passes `/login\n` down the socket, captures the resulting Anthropic URL string and alphanumeric confirmation code from the stream, and displays it inside the browser window as an actionable hyperlink.
  - **Debug Console:** An interactive `xterm.js` display tracking the raw, un-redacted stdout/stdin of the underlying Claude Code process for manual intervention if the agent gets stuck.

### Component C: Containerization & State Persistence

- **Technology:** Docker, Linux Debian/Bookworm base image.
- **Environment Configuration:**
  - Must mount the host system's project source codes into the container dynamically.
  - Must force the environment variable `CLAUDE_CONFIG_DIR=/data/.claude` inside the container setup.
  - Must map the container directory `/data/.claude` to a named local Docker volume so auth tokens, device configurations, and SQLite session history databases survive container down/restart actions.

## 4. Interface Specifications (API Contract)

### 4.1 HTTP Endpoint: Chat Completion (Mocked Format)

- **URL:** `POST /v1/chat/completions`
- **Headers:** `Content-Type: application/json`
- **Request Payload Structure:**

```json
{
  "model": "claude-code-local",
  "sessionId": "e.g., backend-service-refactor",
  "projectPath": "/app/workspace/my-project",
  "messages": [
    {
      "role": "user",
      "content": "Analyze the index.js file and optimize the db connection loop"
    }
  ]
}
```

- **Response Payload Structure:**

```json
{
  "id": "chatcmpl-local-mock",
  "object": "chat.completion",
  "created": 1718000000,
  "model": "claude-code-local",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "I have reviewed index.js. The issue stems from re-instantiating the pool client inside the route block. Here is the optimized logic: ..."
      },
      "finish_reason": "stop"
    }
  ]
}
```

### 4.2 WebSocket Endpoint: Terminal Real-Time Sync

- **URL:** `WS /api/session/stream`
- **Inbound JSON Structure (From UI):**

```json
{ "type": "input", "sessionId": "string", "data": "raw text/command string" }
```

- **Outbound JSON Structure (To UI):**

```json
{ "type": "output", "sessionId": "string", "data": "ansi escaped terminal screen text chunk" }
```

## 5. Non-Functional & Safety Requirements

1. **No External Credentials:** The wrapper server configuration must not request, save, or transmit Anthropic developer API keys.
2. **Network Isolation:** The Express backend service must bind strictly to localhost (`127.0.0.1`) or run within an unexposed internal Docker user network to eliminate cross-network access risks to your subscription session.
3. **Execution Timeouts:** If the agentic loop processes command lines or tools for over 120 seconds without returning an input prompt cue, the backend must force-inject a SIGINT (Ctrl+C) command to release the connection lock safely.
