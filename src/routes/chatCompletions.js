import { Router } from 'express'
import { withTimeout } from '../timeoutGuard.js'
import { SessionConflictError, InvalidProjectPathError } from '../turnSessions.js'

// A model/alias name becomes a `--model <value>` argv element, which Node's
// spawn() rejects synchronously if it contains a NUL byte (ERR_INVALID_ARG_VALUE).
// Restricting the charset up front means that failure mode is a clean 400
// instead of ever reaching the process-spawn layer.
const MODEL_PATTERN = /^[\w.\-:]+$/

function extractText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('')
  }
  return null
}

function validateRequest(body) {
  if (typeof body?.sessionId !== 'string' || body.sessionId.length === 0) {
    return { error: 'sessionId, projectPath, and a last message with text content are required' }
  }
  if (typeof body?.projectPath !== 'string' || body.projectPath.length === 0) {
    return { error: 'sessionId, projectPath, and a last message with text content are required' }
  }
  if (!Array.isArray(body?.messages) || body.messages.length === 0) {
    return { error: 'sessionId, projectPath, and a last message with text content are required' }
  }

  const lastMessage = body.messages[body.messages.length - 1]
  const content = extractText(lastMessage?.content)
  if (content === null || content.length === 0) {
    return { error: 'the last message must have non-empty text content' }
  }

  if (body.model !== undefined && (typeof body.model !== 'string' || !MODEL_PATTERN.test(body.model))) {
    return { error: 'model must contain only letters, numbers, dots, hyphens, underscores, or colons' }
  }

  const systemParts = body.messages
    .filter((m) => m.role === 'system')
    .map((m) => extractText(m.content))
    .filter((t) => t)
  const systemPrompt = systemParts.length > 0 ? systemParts.join('\n\n') : undefined
  if (systemPrompt?.includes('\0')) {
    return { error: 'system message content must not contain a NUL byte' }
  }

  return { content, systemPrompt }
}

// Claude Code's own usage accounting splits input tokens into a fresh
// portion and two cache tiers (cache_read/cache_creation); all three were
// still tokens of context the turn paid for, so prompt_tokens is their sum
// rather than just input_tokens, which would under-report real cost on any
// turn after the first in a session.
function mapUsage(usage) {
  const promptTokens = (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0)
  const completionTokens = usage?.output_tokens ?? 0
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  }
}

function mapFinishReason(stopReason) {
  if (stopReason === 'max_tokens') return 'length'
  return 'stop'
}

function sseWrite(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

// A handful of 4xx/409 cases are the client's own input and won't change on
// retry; OpenAI SDKs (and anything following their x-should-retry header
// convention) take this as a signal not to auto-retry them, which matters
// most for assistant_error — a retry there could re-run a turn that already
// executed side-effecting tools.
function noRetry(res) {
  res.set('x-should-retry', 'false')
}

export function createChatCompletionsRouter({ sessions, runner, timeoutMs }) {
  const router = Router()
  const busySessions = new Set()

  router.post('/v1/chat/completions', async (req, res) => {
    const validation = validateRequest(req.body)
    if (validation.error) {
      noRetry(res)
      return res.status(400).json({ error: { message: validation.error, type: 'invalid_request_error' } })
    }

    const { sessionId, projectPath, model } = req.body
    const { content, systemPrompt } = validation
    const stream = req.body.stream === true

    let session
    try {
      session = sessions.ensure(sessionId, projectPath)
    } catch (err) {
      if (err instanceof SessionConflictError) {
        noRetry(res)
        return res.status(409).json({ error: { message: err.message, type: 'session_conflict' } })
      }
      if (err instanceof InvalidProjectPathError) {
        noRetry(res)
        return res.status(400).json({ error: { message: err.message, type: 'invalid_project_path' } })
      }
      return res.status(500).json({ error: { message: 'internal error', type: 'server_error' } })
    }

    if (busySessions.has(sessionId)) {
      res.set('Retry-After', '1')
      return res.status(503).json({
        error: { message: 'a turn is already in progress for this session', type: 'session_busy' },
      })
    }
    busySessions.add(sessionId)

    const id = `chatcmpl-local-${sessionId}-${Date.now()}`
    const created = Math.floor(Date.now() / 1000)

    const runTurnOpts = {
      content,
      projectPath,
      model,
      systemPrompt,
      claudeSessionId: session.claudeSessionId ?? undefined,
    }

    if (stream) {
      const { promise: rawPromise, kill } = runner.runTurn({
        ...runTurnOpts,
        onDelta: (text) => {
          sseWrite(res, { id, object: 'chat.completion.chunk', created, model: model ?? 'claude-code-local', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })
        },
      })
      // The lock is released once the underlying process has actually
      // exited (success, failure, or killed) — not merely once this
      // request's response has finished — so a client retry can't race a
      // still-exiting process into --resume-ing the same CLI session.
      rawPromise.catch(() => {}).finally(() => busySessions.delete(sessionId))
      res.on('close', kill)

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      sseWrite(res, { id, object: 'chat.completion.chunk', created, model: model ?? 'claude-code-local', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })

      try {
        const result = await withTimeout(rawPromise, kill, timeoutMs)
        sessions.setClaudeSessionId(sessionId, result.claudeSessionId)

        if (result.isError) {
          sseWrite(res, { id, error: { message: result.text || 'the assistant turn ended in an error', type: 'assistant_error', code: result.subtype } })
        } else {
          sseWrite(res, {
            id, object: 'chat.completion.chunk', created, model: result.model ?? model ?? 'claude-code-local',
            choices: [{ index: 0, delta: {}, finish_reason: mapFinishReason(result.stopReason) }],
          })
          if (req.body.stream_options?.include_usage) {
            sseWrite(res, { id, object: 'chat.completion.chunk', created, model: result.model ?? model ?? 'claude-code-local', choices: [], usage: mapUsage(result.usage) })
          }
        }
      } catch (err) {
        // Headers are already committed to text/event-stream at this point,
        // so an error can't become a JSON error response — the closest
        // equivalent is an error-shaped chunk before the stream ends, which
        // is what the OpenAI SDKs look for to raise APIError from a stream.
        sseWrite(res, { id, error: { message: err.message, type: err.message === 'timeout' ? 'timeout' : 'server_error' } })
      } finally {
        res.off('close', kill)
      }
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }

    const { promise: rawPromise, kill } = runner.runTurn(runTurnOpts)
    rawPromise.catch(() => {}).finally(() => busySessions.delete(sessionId))
    res.on('close', kill)

    try {
      const result = await withTimeout(rawPromise, kill, timeoutMs)
      sessions.setClaudeSessionId(sessionId, result.claudeSessionId)

      if (result.isError) {
        noRetry(res)
        return res.status(500).json({
          error: { message: result.text || 'the assistant turn ended in an error', type: 'assistant_error', code: result.subtype },
        })
      }

      return res.json({
        id,
        object: 'chat.completion',
        created,
        model: result.model ?? model ?? 'claude-code-local',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: result.text },
            finish_reason: mapFinishReason(result.stopReason),
          },
        ],
        usage: mapUsage(result.usage),
      })
    } catch (err) {
      if (err.message === 'timeout') {
        return res.status(504).json({
          error: { message: 'timed out waiting for a response', type: 'timeout' },
        })
      }
      return res.status(500).json({ error: { message: err.message, type: 'server_error' } })
    } finally {
      res.off('close', kill)
    }
  })

  return router
}
