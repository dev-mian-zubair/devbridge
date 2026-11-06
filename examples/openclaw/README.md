# OpenClaw

[OpenClaw](https://docs.openclaw.ai) is a self-hosted gateway that connects
chat channels (WhatsApp, Telegram, Discord, ...) to LLM providers and
tools. Unlike the other examples here, there's no script to run — you
register DevBridge as a **custom model provider** in OpenClaw's own
config, the same way you'd register any other OpenAI-compatible backend.

## Applying the config

[`devbridge.patch.json5`](devbridge.patch.json5) is a ready-to-apply
config patch. Validate it first, then apply it:

```bash
openclaw config patch --file ./devbridge.patch.json5 --dry-run   # validate only
openclaw config patch --file ./devbridge.patch.json5             # apply
openclaw config validate                                          # confirm
```

Then try a real turn through it:

```bash
openclaw agent --local --model devbridge/sonnet --message "Reply with exactly one word: OK"
```

## The gotcha: OpenClaw doesn't send `X-Session-Id` by default

DevBridge requires `X-Session-Id` on every request (400
`invalid_request_error` otherwise) — but OpenClaw's generic
`openai-completions` adapter has no idea DevBridge needs this. Without it,
the very first call fails with `sessionId is required, as the
X-Session-Id header or a body field`.

The fix is the provider's own static `headers` field, which OpenClaw sends
on every request to that provider:

```json5
devbridge: {
  baseUrl: "http://127.0.0.1:3000/v1",
  apiKey: "devbridge-does-not-check-this",
  api: "openai-completions",
  headers: { "X-Session-Id": "openclaw-devbridge" },
  models: [{ id: "sonnet", name: "DevBridge (Claude Sonnet, plain chat)" }],
}
```

A single fixed session id is fine for a single-user local setup like
this — DevBridge only needs it to be stable for one logical conversation,
not globally unique. If you want OpenClaw's different chats to map to
separate DevBridge sessions (so they don't serialize behind each other —
see "Known limitations" in the main README), give each provider entry, or
each agent's model override, its own `X-Session-Id` value.

## Referencing the model

A provider's models aren't used automatically — `agents.defaults.model.primary`
(or a per-agent `--model` override) selects one by `"<providerId>/<modelId>"`,
matching the provider id and the `models[].id` entry in the config above:

```json5
agents: { defaults: { model: { primary: "devbridge/sonnet" } } }
```
