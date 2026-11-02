import { Router } from 'express'
import { createTurnBuffer } from '../streamParser.js'
import { withTimeout } from '../timeoutGuard.js'
import { SessionConflictError } from '../sessionManager.js'

function waitForReply(pty, buffer) {
  return new Promise((resolve) => {
    let settled = false
    pty.onData((chunk) => {
      if (settled) return
      buffer.push(chunk)
      if (buffer.isReady()) {
        settled = true
        resolve(buffer.getReply())
      }
    })
  })
}

export function createChatCompletionsRouter(sessionManager, { timeoutMs }) {
  const router = Router()

  router.post('/v1/chat/completions', async (req, res) => {
    const { sessionId, projectPath, messages } = req.body

    let session
    try {
      session = sessionManager.getOrCreate(sessionId, projectPath)
    } catch (err) {
      if (err instanceof SessionConflictError) {
        return res.status(409).json({ error: { message: err.message, type: 'session_conflict' } })
      }
      throw err
    }

    const content = messages[messages.length - 1].content
    const buffer = createTurnBuffer()
    const replyPromise = waitForReply(session.pty, buffer)
    session.pty.write(content + '\n')

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
      throw err
    }
  })

  return router
}
