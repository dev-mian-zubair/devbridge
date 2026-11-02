import { Router } from 'express'
import { createTurnBuffer } from '../streamParser.js'
import { withTimeout } from '../timeoutGuard.js'
import { SessionConflictError, InvalidProjectPathError } from '../sessionManager.js'

function waitForReply(pty, buffer) {
  let disposable
  const promise = new Promise((resolve) => {
    let settled = false
    disposable = pty.onData((chunk) => {
      if (settled) return
      buffer.push(chunk)
      if (buffer.isReady()) {
        settled = true
        resolve(buffer.getReply())
      }
    })
  })
  return { promise, dispose: () => disposable?.dispose?.() }
}

function isValidChatRequest(body) {
  const lastMessage = Array.isArray(body?.messages) ? body.messages[body.messages.length - 1] : undefined
  return (
    typeof body?.sessionId === 'string' && body.sessionId.length > 0 &&
    typeof body?.projectPath === 'string' && body.projectPath.length > 0 &&
    Array.isArray(body?.messages) && body.messages.length > 0 &&
    typeof lastMessage?.content === 'string'
  )
}

export function createChatCompletionsRouter(sessionManager, { timeoutMs }) {
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

    const { sessionId, projectPath, messages } = req.body

    let session
    try {
      session = sessionManager.getOrCreate(sessionId, projectPath)
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
    const buffer = createTurnBuffer()
    const { promise: replyPromise, dispose } = waitForReply(session.pty, buffer)
    session.pty.write(content + '\r')

    try {
      const reply = await withTimeout(replyPromise, session.pty, timeoutMs)
      return res.json({
        id: `chatcmpl-local-${sessionId}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'claude-code-local',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: reply },
            finish_reason: 'stop',
          },
        ],
      })
    } catch (err) {
      if (err.message === 'timeout') {
        return res.status(504).json({
          error: { message: 'timed out waiting for a response', type: 'timeout' },
        })
      }
      return res.status(500).json({ error: { message: 'internal error', type: 'internal' } })
    } finally {
      dispose()
      busySessions.delete(sessionId)
    }
  })

  return router
}
