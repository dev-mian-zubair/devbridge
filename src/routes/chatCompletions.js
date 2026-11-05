import { Router } from 'express'
import { withTimeout } from '../timeoutGuard.js'
import { SessionConflictError, InvalidProjectPathError } from '../turnSessions.js'
import { extractText, serializeHistory } from '../historySerializer.js'

// A model/alias name becomes a `--model <value>` argv element, which Node's
// spawn() rejects synchronously if it contains a NUL byte (ERR_INVALID_ARG_VALUE).
// Restricting the charset up front means that failure mode is a clean 400
// instead of ever reaching the process-spawn layer.
const MODEL_PATTERN = /^[\w.\-:]+$/

// The CLI's own --effort flag only accepts these five levels; OpenAI's
// reasoning_effort also allows "none"/"minimal", which have no CLI
// equivalent to map onto.
const CLI_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

function validateRequest(body, sessionId, projectPath) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return { error: 'sessionId is required, as the X-Session-Id header or a body field' }
  }
  if (typeof projectPath !== 'string' || projectPath.length === 0) {
    return { error: 'projectPath is required, as the X-Project-Path header or a body field' }
  }
  if (!Array.isArray(body?.messages) || body.messages.length === 0) {
    return { error: 'a non-empty messages array with a last message of text content is required' }
  }

  const content = serializeHistory(body.messages)
  if (content.length === 0) {
    return { error: 'the message history must serialize to non-empty content' }
  }

  if (body.model !== undefined && (typeof body.model !== 'string' || !MODEL_PATTERN.test(body.model))) {
    return { error: 'model must contain only letters, numbers, dots, hyphens, underscores, or colons' }
  }

  // tools: a client-declared tool is bridged through a per-request MCP stub
  // server and intercepted before the CLI would ever dispatch to it — see
  // mcpBridge.js/claudeCliRunner.js. tool_choice only maps cleanly onto
  // "offer the tools" (auto, the default) or "don't" (none); "required" or
  // a forced named tool has no clean CLI-side equivalent, so it stays a
  // clear 400 rather than a silent best-effort. functions/function_call
  // (the deprecated aliases) are out of scope and stay rejected outright.
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (tool?.type !== 'function' || typeof tool.function?.name !== 'string' || tool.function.name.length === 0) {
        return { error: 'each tools entry must be {type: "function", function: {name, ...}}' }
      }
    }
    // JSON.stringify escapes a literal NUL byte as the 6-character sequence
    // \u0000 rather than preserving the raw byte, so detecting it means
    // checking for that escaped form, not a literal '\0' in the output.
    if (JSON.stringify(body.tools).includes('\\u0000')) {
      return { error: 'tools must not contain a NUL byte' }
    }
  }
  if (body.tool_choice !== undefined && body.tool_choice !== 'auto' && body.tool_choice !== 'none') {
    return { error: 'tool_choice must be one of auto, none — required/forced-tool selection is not supported' }
  }
  if (Array.isArray(body.functions) && body.functions.length > 0) {
    return { error: 'functions is not supported (deprecated alias of tools)' }
  }
  if (body.function_call !== undefined && body.function_call !== 'none') {
    return { error: 'function_call is not supported (deprecated alias of tool_choice)' }
  }

  // The CLI produces exactly one response per turn; silently returning a
  // single choice to a client that asked for and loops over several would
  // be a silent capability gap rather than a clear error.
  if (typeof body.n === 'number' && body.n > 1) {
    return { error: 'n greater than 1 is not supported: the CLI produces exactly one response per turn' }
  }

  // logprobs: the CLI exposes no token-level probabilities. Returning the
  // response's always-null logprobs field to a client that explicitly asked
  // for real data would silently misrepresent what happened, the same risk
  // as the tools gap above — worth a clear 400 instead.
  if (body.logprobs === true) {
    return { error: 'logprobs is not supported: the CLI has no token-level log probabilities to return' }
  }

  // modalities: the CLI only ever produces text. Requesting "audio" (or any
  // non-"text" modality) and silently getting text back instead would be a
  // silent capability gap rather than a clear error.
  if (Array.isArray(body.modalities) && body.modalities.some((m) => m !== 'text')) {
    return { error: 'modalities must be ["text"]: the CLI only produces text output' }
  }

  const systemParts = body.messages
    .filter((m) => m.role === 'system' || m.role === 'developer')
    .map((m) => extractText(m.content))
    .filter((t) => t)
  const systemPrompt = systemParts.length > 0 ? systemParts.join('\n\n') : undefined
  if (systemPrompt?.includes('\0')) {
    return { error: 'system message content must not contain a NUL byte' }
  }

  let effort
  if (body.reasoning_effort !== undefined) {
    if (typeof body.reasoning_effort !== 'string' || !CLI_EFFORT_LEVELS.has(body.reasoning_effort)) {
      return { error: `reasoning_effort must be one of ${[...CLI_EFFORT_LEVELS].join(', ')} — the underlying CLI has no equivalent for other values (e.g. "none", "minimal")` }
    }
    effort = body.reasoning_effort
  }

  // response_format: "text" (default) and "json_object" are no-ops — OpenAI
  // itself only weakly enforces json_object ("the model must be told to
  // produce JSON in a system or user message"), so there's nothing less
  // honest about not enforcing it here either. "json_schema" maps directly
  // onto the CLI's own --json-schema flag, which *is* enforced.
  let jsonSchema
  if (body.response_format !== undefined) {
    const type = body.response_format?.type
    if (type === undefined || type === 'text' || type === 'json_object') {
      // no-op
    } else if (type === 'json_schema') {
      const schema = body.response_format.json_schema?.schema
      if (schema === undefined || schema === null || typeof schema !== 'object') {
        return { error: 'response_format.json_schema.schema is required and must be an object' }
      }
      jsonSchema = schema
    } else {
      return { error: 'response_format.type must be one of text, json_object, json_schema' }
    }
  }
  if (jsonSchema && JSON.stringify(jsonSchema).includes('\0')) {
    return { error: 'response_format.json_schema must not contain a NUL byte' }
  }

  const activeTools = body.tool_choice === 'none' || !Array.isArray(body.tools) || body.tools.length === 0 ? null : body.tools

  return { content, systemPrompt, effort, jsonSchema, tools: activeTools }
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
    prompt_tokens_details: { cached_tokens: usage?.cache_read_input_tokens ?? 0 },
  }
}

function mapFinishReason(stopReason) {
  if (stopReason === 'max_tokens') return 'length'
  if (stopReason === 'tool_use') return 'tool_calls'
  return 'stop'
}

function mapToolCalls(toolCalls) {
  return toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } }))
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

export function createChatCompletionsRouter({ sessions, runner, timeoutMs, events }) {
  const router = Router()
  const busySessions = new Set()

  router.post('/v1/chat/completions', async (req, res) => {
    // Headers let a client keep the JSON body pure OpenAI wire format (no
    // app-specific fields); body fields remain supported for existing
    // callers, with the header taking precedence when both are given.
    const sessionId = req.get('x-session-id') || req.body?.sessionId
    const projectPath = req.get('x-project-path') || req.body?.projectPath

    const validation = validateRequest(req.body, sessionId, projectPath)
    if (validation.error) {
      noRetry(res)
      return res.status(400).json({ error: { message: validation.error, type: 'invalid_request_error' } })
    }

    const { model } = req.body
    const { content, systemPrompt, effort, jsonSchema, tools } = validation
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
    sessions.recordRequestStart(sessionId, { model: model ?? null, messageCount: req.body.messages.length, lastUserMessage: content })
    const publishDelta = (text) => events.publish({ type: 'session:delta', sessionId, text })

    const id = `chatcmpl-local-${sessionId}-${Date.now()}`
    const created = Math.floor(Date.now() / 1000)

    const runTurnOpts = {
      content,
      projectPath,
      model,
      systemPrompt,
      effort,
      jsonSchema,
      tools,
    }

    if (stream) {
      const { promise: rawPromise, kill } = runner.runTurn({
        ...runTurnOpts,
        onDelta: (text) => {
          sseWrite(res, { id, object: 'chat.completion.chunk', created, model: model ?? 'claude-code-local', choices: [{ index: 0, delta: { content: text }, finish_reason: null, logprobs: null }] })
          publishDelta(text)
        },
        onToolCallDelta: ({ index, id: toolCallId, name, argumentsFragment }) => {
          const delta = toolCallId !== undefined
            ? { index, id: toolCallId, type: 'function', function: { name, arguments: argumentsFragment } }
            : { index, function: { arguments: argumentsFragment } }
          sseWrite(res, { id, object: 'chat.completion.chunk', created, model: model ?? 'claude-code-local', choices: [{ index: 0, delta: { tool_calls: [delta] }, finish_reason: null, logprobs: null }] })
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
      sseWrite(res, { id, object: 'chat.completion.chunk', created, model: model ?? 'claude-code-local', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null, logprobs: null }] })

      try {
        const result = await withTimeout(rawPromise, kill, timeoutMs)
        sessions.setClaudeSessionId(sessionId, result.claudeSessionId)

        if (result.isError) {
          sseWrite(res, { id, error: { message: result.text || 'the assistant turn ended in an error', type: 'assistant_error', code: result.subtype } })
          sessions.recordError(sessionId, { message: result.text || 'the assistant turn ended in an error', code: result.subtype })
        } else {
          sseWrite(res, {
            id, object: 'chat.completion.chunk', created, model: result.model ?? model ?? 'claude-code-local',
            choices: [{ index: 0, delta: {}, finish_reason: mapFinishReason(result.stopReason), logprobs: null }],
          })
          if (req.body.stream_options?.include_usage) {
            sseWrite(res, { id, object: 'chat.completion.chunk', created, model: result.model ?? model ?? 'claude-code-local', choices: [], usage: mapUsage(result.usage) })
          }
          sessions.recordResult(sessionId, { content: result.text, finishReason: mapFinishReason(result.stopReason), usage: mapUsage(result.usage) })
        }
      } catch (err) {
        // Headers are already committed to text/event-stream at this point,
        // so an error can't become a JSON error response — the closest
        // equivalent is an error-shaped chunk before the stream ends, which
        // is what the OpenAI SDKs look for to raise APIError from a stream.
        sseWrite(res, { id, error: { message: err.message, type: err.message === 'timeout' ? 'timeout' : 'server_error' } })
        sessions.recordError(sessionId, { message: err.message, code: err.message === 'timeout' ? 'timeout' : 'server_error' })
      } finally {
        res.off('close', kill)
      }
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }

    const { promise: rawPromise, kill } = runner.runTurn({ ...runTurnOpts, onDelta: publishDelta })
    rawPromise.catch(() => {}).finally(() => busySessions.delete(sessionId))
    res.on('close', kill)

    try {
      const result = await withTimeout(rawPromise, kill, timeoutMs)
      sessions.setClaudeSessionId(sessionId, result.claudeSessionId)

      if (result.isError) {
        noRetry(res)
        sessions.recordError(sessionId, { message: result.text || 'the assistant turn ended in an error', code: result.subtype })
        return res.status(500).json({
          error: { message: result.text || 'the assistant turn ended in an error', type: 'assistant_error', code: result.subtype },
        })
      }

      sessions.recordResult(sessionId, { content: result.text, finishReason: mapFinishReason(result.stopReason), usage: mapUsage(result.usage) })
      const message = result.toolCalls?.length
        ? { role: 'assistant', content: null, tool_calls: mapToolCalls(result.toolCalls), refusal: null }
        : { role: 'assistant', content: result.text, refusal: null }
      return res.json({
        id,
        object: 'chat.completion',
        created,
        model: result.model ?? model ?? 'claude-code-local',
        choices: [
          {
            index: 0,
            message,
            finish_reason: mapFinishReason(result.stopReason),
            logprobs: null,
          },
        ],
        usage: mapUsage(result.usage),
      })
    } catch (err) {
      if (err.message === 'timeout') {
        sessions.recordError(sessionId, { message: 'timed out waiting for a response', code: 'timeout' })
        return res.status(504).json({
          error: { message: 'timed out waiting for a response', type: 'timeout' },
        })
      }
      sessions.recordError(sessionId, { message: err.message, code: 'server_error' })
      return res.status(500).json({ error: { message: err.message, type: 'server_error' } })
    } finally {
      res.off('close', kill)
    }
  })

  return router
}
