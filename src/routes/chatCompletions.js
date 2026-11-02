import { Router } from 'express'
import { withTimeout } from '../timeoutGuard.js'
import { SessionConflictError, InvalidProjectPathError } from '../turnSessions.js'

function isValidChatRequest(body) {
  const lastMessage = Array.isArray(body?.messages) ? body.messages[body.messages.length - 1] : undefined
  return (
    typeof body?.sessionId === 'string' && body.sessionId.length > 0 &&
    typeof body?.projectPath === 'string' && body.projectPath.length > 0 &&
    Array.isArray(body?.messages) && body.messages.length > 0 &&
    typeof lastMessage?.content === 'string'
  )
}

function systemPromptFrom(messages) {
  const systemText = messages
    .filter((m) => m.role === 'system' && typeof m.content === 'string')
    .map((m) => m.content)
    .join('\n\n')
  return systemText.length > 0 ? systemText : undefined
}

// Claude Code's own usage accounting splits input tokens into a fresh
// portion and two cache tiers (cache_read/cache_creation); all three were
// still tokens of context the turn paid for, so prompt_tokens is their sum
// rather than just input_tokens, which would under-report real cost on any
// turn after the first in a session.
function mapUsage(usage) {
  if (!usage) return undefined
  const promptTokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
  const completionTokens = usage.output_tokens ?? 0
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

export function createChatCompletionsRouter({ sessions, runner, timeoutMs }) {
  const router = Router()
  const busySessions = new Set()

  router.post('/v1/chat/completions', async (req, res) => {
    if (!isValidChatRequest(req.body)) {
      return res.status(400).json({
        error: {
          message: 'sessionId, projectPath, and a last message with string content are required',
          type: 'invalid_request',
        },
      })
    }

    const { sessionId, projectPath, messages, model, stream, stream_options: streamOptions } = req.body

    let session
    try {
      session = sessions.ensure(sessionId, projectPath)
    } catch (err) {
      if (err instanceof SessionConflictError) {
        return res.status(409).json({ error: { message: err.message, type: 'session_conflict' } })
      }
      if (err instanceof InvalidProjectPathError) {
        return res.status(400).json({ error: { message: err.message, type: 'invalid_project_path' } })
      }
      return res.status(500).json({ error: { message: 'internal error', type: 'internal' } })
    }

    if (busySessions.has(sessionId)) {
      return res.status(503).json({
        error: { message: 'a turn is already in progress for this session', type: 'session_busy' },
      })
    }
    busySessions.add(sessionId)

    const content = messages[messages.length - 1].content
    const systemPrompt = systemPromptFrom(messages)
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
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      sseWrite(res, { id, object: 'chat.completion.chunk', created, model: model ?? 'claude-code-local', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })

      const { promise, kill } = runner.runTurn({
        ...runTurnOpts,
        onDelta: (text) => {
          sseWrite(res, { id, object: 'chat.completion.chunk', created, model: model ?? 'claude-code-local', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })
        },
      })
      res.on('close', kill)

      try {
        const result = await withTimeout(promise, kill, timeoutMs)
        sessions.setClaudeSessionId(sessionId, result.claudeSessionId)
        sseWrite(res, {
          id, object: 'chat.completion.chunk', created, model: result.model ?? model ?? 'claude-code-local',
          choices: [{ index: 0, delta: {}, finish_reason: mapFinishReason(result.stopReason) }],
        })
        if (streamOptions?.include_usage) {
          sseWrite(res, { id, object: 'chat.completion.chunk', created, model: result.model ?? model ?? 'claude-code-local', choices: [], usage: mapUsage(result.usage) })
        }
      } catch {
        // Headers are already committed to text/event-stream at this point,
        // so an error can't become a JSON error response — the best this
        // proxy can do is end the stream cleanly; the client sees a turn
        // that stopped short rather than a protocol-level failure.
      } finally {
        res.off('close', kill)
      }
      res.write('data: [DONE]\n\n')
      res.end()
      busySessions.delete(sessionId)
      return
    }

    const { promise, kill } = runner.runTurn(runTurnOpts)

    try {
      const result = await withTimeout(promise, kill, timeoutMs)
      sessions.setClaudeSessionId(sessionId, result.claudeSessionId)

      if (result.isError) {
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
      return res.status(500).json({ error: { message: 'internal error', type: 'internal' } })
    } finally {
      busySessions.delete(sessionId)
    }
  })

  return router
}
