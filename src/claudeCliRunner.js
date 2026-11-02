import { spawn } from 'node:child_process'
import crypto from 'node:crypto'

// Claude Code's `-p/--print` mode is its officially supported non-interactive
// interface: `--output-format stream-json --include-partial-messages` emits
// one JSON object per line, mirroring the Anthropic Messages API's own
// streaming event shape (message_start/content_block_delta/message_stop),
// wrapped with Claude-Code-specific system/result lines. This is what the
// chat-completions route streams from and reports usage from — it replaces
// screen-scraping the interactive TUI with a structured, documented format.
//
// `--permission-prompts none` denies (instead of hanging on) anything that
// would otherwise need a live human to approve a tool call: there is no
// terminal attached to approve it in this mode, so the alternative is an
// indefinite hang. `--session-id`/`--resume` map directly onto this proxy's
// own sessionId for multi-turn continuity, without needing to keep a process
// alive between turns the way the PTY-based approach did.
function spawnEnv() {
  const { ANTHROPIC_API_KEY, ...rest } = process.env
  return rest
}

function buildArgs({ claudeSessionId, model, systemPrompt }) {
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
  if (claudeSessionId) {
    args.push('--resume', claudeSessionId)
  } else {
    args.push('--session-id', crypto.randomUUID())
  }
  return args
}

export function createClaudeCliRunner(spawnFn = spawn) {
  return {
    runTurn({ content, projectPath, claudeSessionId, model, systemPrompt, onDelta }) {
      const args = buildArgs({ claudeSessionId, model, systemPrompt })
      const fallbackSessionId = claudeSessionId ?? args[args.indexOf('--session-id') + 1]
      const child = spawnFn('claude', args, { cwd: projectPath, env: spawnEnv() })

      let buffered = ''
      let stderrBuf = ''
      let settled = false
      let capturedModel = null

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
              claudeSessionId: event.session_id ?? fallbackSessionId,
              isError: Boolean(event.is_error),
              stopReason: event.stop_reason ?? null,
              subtype: event.subtype ?? null,
              model: capturedModel,
            })
          }
        }

        child.stdout.on('data', (chunk) => {
          buffered += chunk.toString()
          let idx
          while ((idx = buffered.indexOf('\n')) !== -1) {
            const line = buffered.slice(0, idx)
            buffered = buffered.slice(idx + 1)
            if (line.trim()) handleLine(line)
          }
        })

        child.stderr.on('data', (chunk) => {
          stderrBuf += chunk.toString()
        })

        child.on('error', (err) => settleReject(err))

        child.on('close', (code) => {
          if (settled) return
          settleReject(new Error(`claude CLI exited with code ${code}${stderrBuf.trim() ? `: ${stderrBuf.trim()}` : ''}`))
        })
      })

      child.stdin.write(content)
      child.stdin.end()

      return {
        promise,
        kill: () => child.kill(),
      }
    },
  }
}
