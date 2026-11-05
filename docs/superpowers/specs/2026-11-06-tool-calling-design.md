# OpenAI-compatible tool calling via an MCP bridge, with full-history replay

## Intent and why

DevBridge's `/v1/chat/completions` currently rejects `tools`/`tool_choice`/
`functions`/`function_call` outright (400). That's the right call for the
current architecture, documented in the README as: OpenAI tool-calling is
*client-executes* (the model proposes arguments, the caller runs the
function and reports a result back), while the CLI's own tools are
*agent-executes* (Bash/Edit/Read run inline, inside one turn, with no
pause point and no hook for a client-defined function).

The goal of this project is to close that gap: let a real OpenAI tool-use
client — concretely, LangGraph/LangChain's `ChatOpenAI` + `bindTools()` +
`ToolNode`, and `deepagents` built on the same primitives — drive DevBridge
exactly as it would drive the real OpenAI API, with the client executing
its own tools and DevBridge faithfully reporting the model's proposals.

This also corrects a latent design mismatch: DevBridge currently treats
`--resume`/`--session-id` continuity as free server-side state, serializing
only the newest message into each turn's prompt. The real OpenAI API holds
no server-side conversation state at all — every call resends the full
message list, and a tool result exists only in the client's own list, never
in any CLI session. Making tool-calling work *at all* requires replaying
full history every call (a tool result has nowhere else to live); this
project makes that the uniform behavior for both tool-calling and
plain-chat requests, dropping `--resume` entirely, so the two code paths
don't diverge in what "a turn" means.

## Goals

- `tools`/`tool_choice` on `/v1/chat/completions` work with real OpenAI SDK
  clients, specifically verified against LangChain's `ChatOpenAI.bindTools()`
  and LangGraph's `ToolNode`/`create_react_agent`, in both streaming and
  non-streaming mode.
- The model can propose multiple tool calls in one turn (parallel tool
  calls), and a turn may mix the CLI's own built-in tool use (Bash, Edit,
  Read, ...) with client-declared tool proposals — only the client-declared
  ones stop the turn.
- Streaming tool-call responses carry real incremental argument deltas
  (`delta.tool_calls[].function.arguments` fragments keyed by array
  `index`), not a single batched chunk — the CLI's own partial-message
  stream supports this (verified by spike, see Constraints).
- Every `/v1/chat/completions` call — tool-calling or plain-chat, streaming
  or not — replays the full `messages` array into a fresh `-p` invocation.
  `--resume`/`--session-id` continuity is removed from the chat-completions
  path entirely.
- `deepagents`' `create_deep_agent` works against DevBridge when given a
  `ChatOpenAI(base_url=...)` instance (not the `"openai:..."` shorthand,
  which switches to the Responses API — a different wire shape DevBridge
  does not implement; this is a usage note, not something DevBridge can
  detect or fix).

## Non-goals

- Reproducing OpenAI's Responses API. DevBridge implements Chat Completions
  only, as it already does.
- Preserving any server-side prompt-cache benefit across a growing
  tool-calling conversation. Full-history replay means every call
  reprocesses the whole conversation from scratch on the CLI side; this is
  the correct behavior per real OpenAI semantics, and the added cost is an
  accepted tradeoff, not a bug to engineer around in this project.
- `n > 1`, `logprobs: true`, non-`"text"` `modalities`, or any other
  already-rejected field. Those rejections are unrelated to tool-calling
  and stay exactly as they are.
- Persisting or resuming a tool-calling conversation server-side between
  HTTP calls. Each `/v1/chat/completions` call remains a single, complete,
  stateless turn; the loop (call → tool_calls → execute → call again with
  the result appended) lives entirely in the client, matching real OpenAI.

## Anti-goals

- A design that silently drops a tool call, a tool result, or any message
  in the replayed history. If something in a client's message list can't
  be faithfully represented in the CLI's prompt, that's a 400, not a best
  effort.
- Any code path where the CLI's own MCP tool handler actually executes for
  a client-declared tool. The whole point of the bridge is that the client
  executes; if the stub handler's body ever runs for real, the architecture
  has failed regardless of what it returns.
- Reintroducing `--resume` as an optimization "just for the plain-chat
  case." The whole point of this project is making the two paths the same
  shape; a plain-chat-only shortcut recreates the original mismatch.

## Constraints

- Node.js/Express, `child_process.spawn` (no PTY) for the chat-completions
  path — unchanged from the current architecture.
- The CLI is driven via `-p --output-format stream-json
  --include-partial-messages --verbose --permission-prompts none`, and
  `--mcp-config <file>` / `--strict-mcp-config` for registering client
  tools. `--allowedTools <names...>` scoped to exactly the generated MCP
  tool names must accompany any tools-bearing turn — `--permission-prompts
  none` denies any prompt it isn't told to auto-allow, and
  `--dangerously-skip-permissions` is unnecessary and not used (confirmed
  via a live spike against the installed CLI, `2.1.318`).
- **Spike-confirmed stream shape** (ground truth, not assumption): an
  MCP-registered tool call's arguments arrive as
  `content_block_start {type: "tool_use", name: "mcp__<server>__<tool>"}`
  followed by one or more `content_block_delta {type: "input_json_delta",
  partial_json: "<fragment>"}` events, then `content_block_stop`, then
  `message_delta {stop_reason: "tool_use"}` and `message_stop`. This is
  the same shape Claude's native tool_use streaming uses — not a special
  case for MCP. The CLI's own built-in tool calls (Bash, Edit, ToolSearch,
  ...) use unrelated internal execution and never need to be translated —
  only `content_block_start.content_block.name` starting with
  `mcp__<server>__` identifies a client-declared tool call.
- **Spike-confirmed race safety** (ground truth, not assumption): sending
  `SIGTERM` to the CLI's process group the instant the parent observes
  `message_delta.stop_reason === "tool_use"` on stdout reliably beats the
  CLI's own dispatch to the MCP stub subprocess. Verified with an
  MCP handler that writes a sentinel file the instant it's entered (before
  any other work) — across 5 trials, the sentinel was never written. This
  has real margin, not a coin flip: the CLI still has to finish processing
  that same event internally and complete an MCP JSON-RPC round-trip to
  the stdio child before the handler body would run at all, both of which
  take materially longer than the parent's own read-line-and-kill reaction.
  The anti-goal ("the stub handler never truly executes") is sound as
  designed.
- **Usage for a tool_use-terminated turn comes from `message_delta`, not
  `result`.** The turn's final `result` event never arrives (the process
  is killed before the CLI would emit it), but spike data shows
  `message_delta` itself carries a complete `usage` object
  (`input_tokens`/`cache_creation_input_tokens`/`cache_read_input_tokens`/
  `output_tokens`) on every message, including the one that ends with
  `stop_reason: "tool_use"`. The runner maps *that* object the same way
  `mapUsage()` already maps a `result` event's `usage` today — no new
  token-accounting path, just a different event to read it from.
- `parallel_tool_calls` is already accepted-and-silently-ignored by
  `validateRequest` (README's compatibility table) — no change needed
  there; this was independently confirmed as load-bearing by research into
  `ChatOpenAI`'s default request shape.
- `tools`/`tool_choice`/`functions`/`function_call` are currently hard
  rejections in `src/routes/chatCompletions.js` (`validateRequest`,
  ~lines 48–67) and must change from "rejected" to "implemented" — not to
  "silently ignored." `functions`/`function_call` (the deprecated OpenAI
  aliases) are out of scope: leave them rejected.
- `src/claudeCliRunner.js`'s `buildArgs`/`runTurn` currently take
  `claudeSessionId` and emit `--resume`/`--session-id`; currently only
  `text_delta` content-block events are handled, nothing else in the
  stream is inspected. This is the file that grows the new event handling
  and MCP-config wiring.
- `src/turnSessions.js`'s per-`sessionId` session record (status,
  busy-lock, last request/result/error, `claudeSessionId`) is an
  observability/concurrency concept, not a CLI-continuity one, and is
  **not** removed — only its role in building `--resume` args goes away.
  The dashboard still needs one row per logical client session.
- README.md documents the current `tools` rejection, the compatibility
  table, and `--resume`-based continuity (lines ~59–62, ~295–297, ~332–336,
  ~420–425) and must be updated to match the new behavior — this is part
  of the deliverable, not an afterthought.

## Decisions made (the how)

**Full-history replay, uniformly.** `validateRequest` currently extracts
only `extractText(lastMessage.content)` as the prompt. This changes to
serializing the *entire* `messages` array — system/developer messages,
every prior `user`/`assistant` turn, `assistant` messages with `tool_calls`,
and `tool`-role results — into the `-p` call's stdin prompt, for every
request, tool-calling or not. `claudeSessionId`/`--resume`/`--session-id`
are removed from `buildArgs` entirely. The exact serialization format
(how an `assistant` message with `tool_calls` and a following `tool`
message are rendered into the single text prompt the CLI's stdin expects)
is left to the builder — it has no OpenAI-side constraint, only the
constraint that it must be lossless and the model must be able to tell, on
the next call, "this looks like a tool result for call X."

**MCP bridge, one stub server per tools-bearing request.** When a request's
`tools` array is non-empty, DevBridge generates an MCP server config (one
process, speaking stdio, registering one tool per entry in `tools` with
that entry's `name`/`description`/`parameters` as its JSON-schema input)
and passes it via `--mcp-config`, `--strict-mcp-config`, and
`--allowedTools` naming exactly those `mcp__<server>__<name>` tools. This
server's tool handlers are never meant to actually run (see interception,
below) — their only job, if interception ever fails to fire, is to be a
visible bug, not a silent wrong answer. The stub process and its config
file are per-request, spawned and torn down with the CLI invocation.

**Interception, not execution.** The runner watches the stream for
`content_block_start` where `content_block.name` starts with
`mcp__<server>__`. It accumulates `input_json_delta` fragments per block
`index` (translating them live, for a streaming response, into OpenAI's
`delta.tool_calls[index].function.arguments` fragments) until that block's
`content_block_stop`. It lets the turn continue — a model proposing several
tool calls in one message produces several such blocks before
`message_stop`, and the CLI's own tool use (a different `content_block.name`,
no `mcp__` prefix) is passed through untouched, not translated, not
intercepted. Only when `message_delta.stop_reason === "tool_use"` arrives
*and* at least one accumulated block was an MCP (client) tool call does the
runner kill the CLI process (same `signalProcessGroup` mechanism already
used for client-disconnect/timeout kills) before the CLI's internal loop
would hand control to the stub server's handler. The HTTP response then
closes with `finish_reason: "tool_calls"` and the full `tool_calls` array
built from the accumulated blocks.

If `message_delta.stop_reason === "tool_use"` fires with *no* MCP blocks
accumulated (the model only used CLI-native tools and is now done), that's
not a tool-calling stop in the OpenAI sense — the turn's `result` event
still carries the real text answer, same as today.

**Resolve, don't reject, on an interception kill.** `runTurn`'s promise
today settles exactly one way: a `result` event resolves it, anything else
(including every existing use of `kill()` — timeout, client disconnect)
reaches `child.on('close', ...)` with no `result` seen and rejects with
"claude CLI exited with code N". An interception kill is a *third*,
new case: the process exits with no `result`, but the turn is a success —
the runner has everything it needs (the accumulated tool-call blocks and
the `message_delta` usage above). The interception logic's own kill call
must carry this outcome through explicitly — e.g. by calling a dedicated
`settleResolve({ toolCalls, usage, ... })` itself, bypassing the
close-handler's "no result means failure" assumption — so that an
externally-triggered kill (timeout, disconnect) is still unambiguously a
failure, and only a self-initiated "I have a complete tool call" kill
resolves successfully.

**Same-message native+client mixing degrades to across-message mixing.**
The kill fires before the CLI dispatches *any* block of the message that
triggered it — so if a single assistant message proposed both a native
call (Bash) and a client (MCP) call together, killing pre-dispatch means
the native call in that specific message doesn't get to run this turn
either. This is an accepted, harmless degradation, not a correctness gap:
CLI-native tool calls have no representation in the OpenAI response shape
in the first place (the client never sees that Bash ran, same as today) —
all that's lost is the model's chance to use Bash *in the same breath* as
proposing a client tool, which it can instead do in an earlier message
(sequential, as the spike observed: a full native round-trip completing
before a later message proposes the client call) or in the next turn
after the client's tool result comes back. "Accumulated blocks" state is
tracked per in-flight *message* (reset at each `message_start`), not
across the whole turn.

**Non-streaming requests see the same interception**, just without
incremental delta translation: the runner still has to watch the stream
internally (it's the only way to see the CLI about to hand off to the MCP
server, and to kill it before that happens), it just assembles each
tool_use block's `partial_json` fragments into one complete `arguments`
string before the single JSON response is written, rather than writing a
chunk per fragment.

## What's left to the builder

- The exact text serialization of history-with-tool-results into the `-p`
  stdin prompt (format, not feasibility — feasibility is settled by the
  "full fidelity" goal, the shape is an implementation choice).
- The exact MCP stub-server implementation (one Node process per request
  using `@modelcontextprotocol/sdk`, matching the spike's `weather-server.mjs`
  shape) and its config-file generation/cleanup lifecycle.
- Exactly how `src/claudeCliRunner.js`'s existing `handleLine`/`onDelta`
  shape extends to carry tool-call block state without breaking its
  existing plain-text streaming callers — this file's current single
  `onDelta(text)` callback is not enough; the new shape (additional
  callback(s), or a richer event object) is an implementation choice, not
  a wire-format one.
- Where exactly the 400-vs-implement line now falls for `tool_choice`
  values other than `undefined`/`"none"` (e.g. `"auto"`, `"required"`, a
  forced named tool) — OpenAI defines these; map what maps cleanly onto
  `--allowedTools`/prompting, reject what doesn't, following the same
  "clear 400 over silent capability gap" principle the rest of
  `validateRequest` already uses.
- `README.md`'s specific wording updates (compatibility table, the
  `tools`-rejection rationale section, the `--resume`/`--session-id`
  continuity description).
- `tools[].name`/schema get the same NUL-byte/charset validation
  `validateRequest` already applies to `model` and the system prompt,
  before they're written into the generated `--mcp-config` file and
  `--allowedTools` args — same discipline, not a new principle.
- Whether `src/turnSessions.js`'s stored `claudeSessionId` field is dropped
  outright (it drives nothing once `--resume` is gone) or kept purely as a
  "the CLI's own last session id, for debugging" observability value —
  either is consistent with this design; pick whichever is less code.
