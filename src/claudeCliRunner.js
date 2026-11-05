import { spawn } from 'node:child_process'
import { createMcpBridge as realCreateMcpBridge } from './mcpBridge.js'

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

function buildArgs({ model, systemPrompt, effort, jsonSchema, mcpConfigPath, allowedToolNames }) {
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
  if (systemPrompt) args.push('--append-system-prompt', systemPrompt)
  if (effort) args.push('--effort', effort)
  if (jsonSchema) args.push('--json-schema', JSON.stringify(jsonSchema))
  if (mcpConfigPath) {
    args.push('--mcp-config', mcpConfigPath, '--strict-mcp-config', '--allowedTools', ...allowedToolNames)
  }
  return args
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
    runTurn({ content, projectPath, model, systemPrompt, effort, jsonSchema, tools, onDelta }) {
      let mcpConfigPath = null
      let allowedToolNames = []
      let cleanupMcpBridge = null
      if (tools?.length) {
        const bridge = createMcpBridge(tools)
        mcpConfigPath = bridge.mcpConfigPath
        allowedToolNames = bridge.allowedToolNames
        cleanupMcpBridge = bridge.cleanup
      }

      const args = buildArgs({ model, systemPrompt, effort, jsonSchema, mcpConfigPath, allowedToolNames })

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

      child.on('close', () => {
        exited = true
        cleanupMcpBridge?.()
      })

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

        function handleLine(line) {
          let event
          try {
            event = JSON.parse(line)
          } catch {
            return
          }

          if (event.type === 'stream_event' && event.event?.type === 'message_start') {
            capturedModel = event.event.message?.model ?? capturedModel
            return
          }

          if (
            event.type === 'stream_event' &&
            event.event?.type === 'content_block_delta' &&
            event.event.delta?.type === 'text_delta'
          ) {
            onDelta?.(event.event.delta.text)
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
        kill: () => {
          if (exited) return
          signalProcessGroup(child, 'SIGTERM')
          const killTimer = setTimeout(() => {
            if (!exited) signalProcessGroup(child, 'SIGKILL')
          }, killGraceMs)
          killTimer.unref?.()
          child.once('close', () => clearTimeout(killTimer))
        },
      }
    },
  }
}
