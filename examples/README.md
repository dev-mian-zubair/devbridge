# DevBridge examples

Minimal, runnable examples showing how to point different frameworks and
SDKs at a running DevBridge server. Each subdirectory is self-contained
(its own `package.json`/`requirements.txt`) and independent of DevBridge's
own dependency tree.

| Example | What it shows |
|---|---|
| [`basic-http/`](basic-http) | Plain `curl` and the official `openai` SDK — no framework, the shortest path to "it works". |
| [`vercel-ai-sdk/`](vercel-ai-sdk) | Vercel AI SDK via `createOpenAICompatible()`, including the gotcha that the bare `openai('model-id')` provider does **not** work. |
| [`langchain/`](langchain) | LangChain's `ChatOpenAI`, with a full client-executes tool-calling round trip and streaming. |
| [`deepagents/`](deepagents) | A deepagents agent (Python), including the gotcha that the `"openai:..."` model-string shorthand does **not** work. |

## Before running any of them

1. **Start DevBridge** (from the repo root):
   ```bash
   npm install
   npm start
   ```
   It binds to `http://127.0.0.1:3000` by default.
2. **Sign in once**, if you haven't already: open `http://127.0.0.1:3000/`
   in a browser and click **Sign In** (see "Signing in" in the main
   [README](../README.md#signing-in-login-flow)). This is the CLI's own
   `/login` flow — DevBridge has no credentials of its own.
3. Each example defaults to `http://127.0.0.1:3000`. Point it elsewhere with
   the `DEVBRIDGE_URL` environment variable, e.g.
   `DEVBRIDGE_URL=http://127.0.0.1:3002 npm start`.

Every example sends a fixed `X-Session-Id` — the only header DevBridge
actually requires (see "Session identity" in the main README). Change it,
or generate one per real conversation, the same way you would against the
real OpenAI API.
