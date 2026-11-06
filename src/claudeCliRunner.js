import { spawn } from 'node:child_process'
import { createMcpBridge as realCreateMcpBridge, MCP_SERVER_NAME } from './mcpBridge.js'

const MCP_PREFIX = `mcp__${MCP_SERVER_NAME}__`

// DevBridge's primary audience points at it expecting an OpenAI-compatible
// chat model, not Claude Code itself — but the CLI's default persona and
// full built-in tool surface (confirmed live, even against a fresh,
// plugin-free config dir: this exact list) are both still "I am Claude
// Code, an agentic coding tool" by default. Without correcting for that, a
// plain chat/reasoning call (e.g. driving a non-coding LangGraph agent)
// can get coding-flavored answers or have the model actually try to read
// files / run shell commands that have nothing to do with the request.
// There used to be an opt-out (agentMode: "coding") that restored the real
// agent, tools and persona intact. It's been removed entirely, on purpose:
// this guarantees no caller — not a client header, not a future direct
// call into this module — can ever reach real file/shell access through
// this server, rather than relying on nobody asking for it.
const DEFAULT_MODE_DISALLOWED_TOOLS = [
  'Task', 'Bash', 'CronCreate', 'CronDelete', 'CronList', 'DesignSync', 'Edit',
  'EnterWorktree', 'ExitWorktree', 'ListAgents', 'Monitor', 'NotebookEdit',
  'PushNotification', 'Read', 'RemoteTrigger', 'ReportFindings', 'ScheduleWakeup',
  'SendMessage', 'Skill', 'TaskStop', 'ToolSearch', 'WebFetch', 'WebSearch', 'Workflow', 'Write',
]

const CORRECTIVE_SYSTEM_PROMPT =
  'You are being used as a general-purpose chat/reasoning model through an ' +
  'OpenAI-compatible API, not as Claude Code, a coding agent in a project ' +
  "directory. Don't reference files, repositories, codebases, or " +
  "development tools unless the user's own message raises them. You have " +
  'no file system or shell access in this context.'

// Claude Code's `-p/--print` mode is its officially supported non-interactive
// interface: `--output-format stream-json --include-partial-messages` emits
// one JSON object per line, mirroring the Anthropic Messages API's own
// streaming event shape (message_start/content_block_delta/message_stop),
// wrapped with Claude-Code-specific system/result lines. This is what the
// chat-completions route streams from and reports usage from — it replaces
// screen-scraping the interactive TUI with a structured, documented format.
//
// `--permission-prompts none` denies (instead of hanging on) any prompt that
// would otherwise need a live human to approve a tool call: there is no
// terminal attached to approve it in this mode, so the alternative is an
// indefinite hang. It does not change what the permission MODE itself allows
// — tools already allow-listed by the user's own Claude Code settings still
// run unattended, exactly as they would in an interactive session; only the
// prompts that would otherwise block on a human are turned into denials.
// No --session-id/--resume: continuity comes from replaying the full
// message history into every turn's prompt (see historySerializer.js),
// matching the real OpenAI API's statelessness instead of relying on
// CLI-side session state.
function spawnEnv() {
  const { ANTHROPIC_API_KEY, ...rest } = process.env
  return rest
}

function buildArgs({ model, systemPrompt, effort, jsonSchema, mcpConfigPath, allowedToolNames, requireToolUse, forcedToolName }) {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--permission-prompts',
    'none',
  ]
  if (model) args.push('--model', model)

  const promptParts = [CORRECTIVE_SYSTEM_PROMPT]
  if (systemPrompt) promptParts.push(systemPrompt)
  if (requireToolUse) {
    // Best-effort only — there's no CLI flag that forces a tool call the
    // way OpenAI's real tool_choice: "required" guarantees one. A forced
    // named tool also narrows --allowedTools below, which gets closer to
    // deterministic than the generic case (nothing else to call), but
    // neither is a hard guarantee; documented as such in the README.
    promptParts.push(
      forcedToolName
        ? `You must call the "${forcedToolName}" tool in this turn — one of the client-declared tools available to you, not your own built-in tools. Do not respond with only text.`
        : 'You must call one of the client-declared tools available to you in this turn — not your own built-in tools. Do not respond with only text.'
    )
  }
  const finalSystemPrompt = promptParts.length > 0 ? promptParts.join('\n\n') : undefined
  if (finalSystemPrompt) args.push('--append-system-prompt', finalSystemPrompt)

  if (effort) args.push('--effort', effort)
  if (jsonSchema) args.push('--json-schema', JSON.stringify(jsonSchema))
  if (mcpConfigPath) {
    const effectiveAllowedToolNames = forcedToolName
      ? allowedToolNames.filter((name) => name === `${MCP_PREFIX}${forcedToolName}`)
      : allowedToolNames
    args.push('--mcp-config', mcpConfigPath, '--strict-mcp-config', '--allowedTools', ...effectiveAllowedToolNames)
  }

  // The full default disallow list (always applied — see the comment on
  // DEFAULT_MODE_DISALLOWED_TOOLS) already includes Task, which also
  // covers the narrower tools-bearing-turn mitigation this project used to
  // apply separately (a native subagent's own tool calls being forwarded
  // on this stream, indistinguishably from the top-level turn's, was
  // unverified) — one disallow list, never pushed twice.
  args.push('--disallowedTools', ...DEFAULT_MODE_DISALLOWED_TOOLS)
  return args
}

// The earliest-positioned match across all stop sequences wins — matching
// real OpenAI's behavior when more than one sequence could apply. -1 means
// none of them appear yet.
function findEarliestStopIndex(text, stopSequences) {
  let earliest = -1
  for (const seq of stopSequences) {
    const idx = text.indexOf(seq)
    if (idx !== -1 && (earliest === -1 || idx < earliest)) earliest = idx
  }
  return earliest
}

// Signals the whole process group the CLI's child process leads (spawned
// with `detached: true` for exactly this reason), so a Bash/MCP subprocess
// it fanned out to is killed too instead of being orphaned. Falls back to
// signaling the child directly when there's no real pid to form a group
// from (a test double, or a process.kill failure on a platform without
// POSIX process groups).
function signalProcessGroup(child, signal) {
  const pid = child.pid
  if (typeof pid === 'number' && Number.isInteger(pid)) {
    try {
      process.kill(-pid, signal)
      return
    } catch {
      // No real process group (e.g. a test double) — fall through.
    }
  }
  try {
    child.kill(signal)
  } catch {
    // Already gone; nothing left to signal.
  }
}

export function createClaudeCliRunner(spawnFn = spawn, { killGraceMs = 5000, createMcpBridge = realCreateMcpBridge } = {}) {
  return {
    runTurn({ content, projectPath, model, systemPrompt, effort, jsonSchema, tools, stopSequences = [], requireToolUse, forcedToolName, onDelta, onToolCallDelta }) {
      let mcpConfigPath = null
      let allowedToolNames = []
      let cleanupMcpBridge = null
      if (tools?.length) {
        const bridge = createMcpBridge(tools)
        mcpConfigPath = bridge.mcpConfigPath
        allowedToolNames = bridge.allowedToolNames
        cleanupMcpBridge = bridge.cleanup
      }

      const args = buildArgs({ model, systemPrompt, effort, jsonSchema, mcpConfigPath, allowedToolNames, requireToolUse, forcedToolName })

      let child
      try {
        child = spawnFn('claude', args, { cwd: projectPath, env: spawnEnv(), detached: true })
      } catch (err) {
        // A synchronous spawn() throw (e.g. ERR_INVALID_ARG_VALUE from a
        // stray NUL byte that slipped past route-level validation, E2BIG)
        // must never escape runTurn() — nothing here would catch it, and an
        // uncaught exception takes the whole server down (Node exits on an
        // unhandled rejection too, which this would otherwise become).
        return { promise: Promise.reject(err), kill: () => {} }
      }

      let buffered = ''
      let stderrBuf = ''
      let settled = false
      let exited = false
      let capturedModel = null
      let capturedUsage = null

      child.on('close', () => {
        exited = true
        cleanupMcpBridge?.()
      })

      function killNow() {
        if (exited) return
        signalProcessGroup(child, 'SIGTERM')
        const killTimer = setTimeout(() => {
          if (!exited) signalProcessGroup(child, 'SIGKILL')
        }, killGraceMs)
        killTimer.unref?.()
        child.once('close', () => clearTimeout(killTimer))
      }

      const promise = new Promise((resolve, reject) => {
        function settleResolve(value) {
          if (settled) return
          settled = true
          resolve(value)
        }
        function settleReject(err) {
          if (settled) return
          settled = true
          reject(err)
        }

        // Blocks (and any preamble text) accumulated for the message
        // currently in flight — reset at every message_start, so a client
        // (MCP) tool call or text only reported in an earlier message of
        // this turn never leaks into a later stop.
        let currentBlocks = new Map()
        let currentText = ''

        function handleLine(line) {
          let event
          try {
            event = JSON.parse(line)
          } catch {
            return
          }

          if (event.type === 'stream_event' && event.event?.type === 'message_start') {
            capturedModel = event.event.message?.model ?? capturedModel
            // The only usage snapshot available if a stop sequence cuts this
            // message short before its own message_delta ever arrives —
            // honestly partial (mostly prompt-side tokens), not a lie: it
            // reflects what had actually happened at the point we stopped.
            capturedUsage = event.event.message?.usage ?? capturedUsage
            currentBlocks = new Map()
            currentText = ''
            return
          }

          if (
            event.type === 'stream_event' &&
            event.event?.type === 'content_block_start' &&
            event.event.content_block?.type === 'tool_use' &&
            event.event.content_block.name?.startsWith(MCP_PREFIX)
          ) {
            const { index } = event.event
            const { id, name } = event.event.content_block
            const bareName = name.slice(MCP_PREFIX.length)
            // The OpenAI tool_calls array is indexed 0-based, gaplessly,
            // among tool calls only — never the raw Anthropic content-block
            // index, which also counts any preceding text/native blocks in
            // the same message (e.g. the model writing "Let me check."
            // before calling a tool puts that tool_use block at index 1,
            // not 0). `ordinal` is this block's position among MCP blocks
            // seen so far in the current message; the raw `index` remains
            // only the Map key used to correlate later delta events.
            const ordinal = currentBlocks.size
            currentBlocks.set(index, { id, name: bareName, argsBuf: '', ordinal })
            onToolCallDelta?.({ index: ordinal, id, name: bareName, argumentsFragment: '' })
            return
          }

          if (
            event.type === 'stream_event' &&
            event.event?.type === 'content_block_delta' &&
            event.event.delta?.type === 'input_json_delta' &&
            currentBlocks.has(event.event.index)
          ) {
            const block = currentBlocks.get(event.event.index)
            const fragment = event.event.delta.partial_json
            block.argsBuf += fragment
            onToolCallDelta?.({ index: block.ordinal, argumentsFragment: fragment })
            return
          }

          if (
            event.type === 'stream_event' &&
            event.event?.type === 'content_block_delta' &&
            event.event.delta?.type === 'text_delta'
          ) {
            const fragment = event.event.delta.text
            const previousLength = currentText.length
            currentText += fragment

            const stopIndex = findEarliestStopIndex(currentText, stopSequences)
            if (stopIndex !== -1) {
              const truncated = currentText.slice(0, stopIndex)
              const visiblePart = truncated.length > previousLength ? truncated.slice(previousLength) : ''
              if (visiblePart) onDelta?.(visiblePart)
              settleResolve({
                text: truncated,
                usage: capturedUsage,
                totalCostUsd: null,
                claudeSessionId: null,
                isError: false,
                stopReason: 'stop_sequence',
                subtype: null,
                model: capturedModel,
              })
              killNow()
              return
            }

            onDelta?.(fragment)
            return
          }

          if (event.type === 'stream_event' && event.event?.type === 'message_delta' && event.event.delta?.stop_reason === 'tool_use') {
            if (currentBlocks.size === 0) return
            const toolCalls = [...currentBlocks.values()].map((b) => ({ index: b.ordinal, id: b.id, name: b.name, arguments: b.argsBuf }))
            settleResolve({
              text: currentText,
              usage: event.event.usage ?? null,
              totalCostUsd: null,
              claudeSessionId: null,
              isError: false,
              stopReason: 'tool_use',
              subtype: null,
              model: capturedModel,
              toolCalls,
            })
            killNow()
            return
          }

          if (event.type === 'result') {
            settleResolve({
              text: event.result ?? '',
              usage: event.usage ?? null,
              totalCostUsd: event.total_cost_usd ?? null,
              claudeSessionId: event.session_id ?? null,
              isError: Boolean(event.is_error),
              stopReason: event.stop_reason ?? null,
              subtype: event.subtype ?? null,
              model: capturedModel,
            })
          }
        }

        // setEncoding uses a StringDecoder internally, so a multi-byte UTF-8
        // character split across two chunks decodes correctly instead of
        // producing U+FFFD at the boundary (chunk.toString() per chunk does not).
        child.stdout.setEncoding('utf8')
        child.stdout.on('data', (strChunk) => {
          buffered += strChunk
          let idx
          while ((idx = buffered.indexOf('\n')) !== -1) {
            const line = buffered.slice(0, idx)
            buffered = buffered.slice(idx + 1)
            if (line.trim()) handleLine(line)
          }
        })

        child.stderr.setEncoding('utf8')
        child.stderr.on('data', (strChunk) => {
          // Capped: this only ever feeds a truncated diagnostic message, not
          // anything parsed, so there's no reason to let it grow unbounded.
          stderrBuf = (stderrBuf + strChunk).slice(-4096)
        })

        // A write (or the pending buffered data) after the child has already
        // exited surfaces as EPIPE on stdin. Without a listener, that's an
        // uncaught exception that crashes the whole process; the child's own
        // 'close' handler below is what actually settles this turn's outcome.
        child.stdin.on('error', () => {})

        child.on('error', (err) => settleReject(err))

        child.on('close', (code) => {
          // A result line with no trailing newline stays in the buffer until
          // the process exits — flush it before deciding this turn failed.
          if (buffered.trim()) {
            const trailing = buffered
            buffered = ''
            handleLine(trailing)
          }
          if (settled) return
          settleReject(new Error(`claude CLI exited with code ${code}${stderrBuf.trim() ? `: ${stderrBuf.trim()}` : ''}`))
        })
      })

      child.stdin.write(content)
      child.stdin.end()

      return {
        promise,
        kill: killNow,
      }
    },
  }
}
