import express from 'express'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import * as pty from 'node-pty'
import { loadConfig } from './config.js'
import { createSessionManager } from './sessionManager.js'
import { createTurnSessions } from './turnSessions.js'
import { createClaudeCliRunner } from './claudeCliRunner.js'
import { createChatCompletionsRouter } from './routes/chatCompletions.js'
import { createModelsRouter } from './routes/models.js'
import { createSessionStreamHandler } from './ws/sessionStream.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const publicDir = path.join(__dirname, '..', 'public')

// DNS rebinding lets an attacker-controlled domain resolve to 127.0.0.1, so
// Origin and Host can be attacker-controlled *together* — comparing them to
// each other (the previous approach) proves nothing. Both are instead
// checked independently against a fixed loopback allowlist.
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

function hostnameOf(hostHeader) {
  if (!hostHeader) return null
  if (hostHeader.startsWith('[')) {
    const end = hostHeader.indexOf(']')
    return end === -1 ? null : hostHeader.slice(0, end + 1)
  }
  return hostHeader.split(':')[0]
}

function isLoopbackHostname(hostHeader) {
  const hostname = hostnameOf(hostHeader)
  return hostname !== null && LOOPBACK_HOSTNAMES.has(hostname)
}

function sameOriginOnly(req, res, next) {
  if (!isLoopbackHostname(req.headers.host)) {
    return res.status(403).json({ error: { message: 'forbidden host', type: 'forbidden' } })
  }
  const origin = req.headers.origin
  if (origin) {
    let originHost
    try {
      originHost = new URL(origin).host
    } catch {
      return res.status(403).json({ error: { message: 'forbidden origin', type: 'forbidden' } })
    }
    if (!isLoopbackHostname(originHost)) {
      return res.status(403).json({ error: { message: 'forbidden origin', type: 'forbidden' } })
    }
  }
  next()
}

function isAllowedOrigin({ req }) {
  if (!isLoopbackHostname(req.headers.host)) return false
  const origin = req.headers.origin
  if (!origin) return true
  try {
    return isLoopbackHostname(new URL(origin).host)
  } catch {
    return false
  }
}

export function createApp(sessionManager, turnSessions, runner, { timeoutMs = 120000 } = {}) {
  const app = express()
  app.use(sameOriginOnly)
  app.use(express.json())
  app.use(express.static(publicDir))

  // The dashboard's live debug terminal is a separate concern from the chat
  // completions API below: it drives the interactive PTY session directly
  // (see src/ws/sessionStream.js) so a human can watch and type into the
  // real CLI, independent of the API's own per-turn session bookkeeping.
  app.post('/api/sessions', async (req, res) => {
    const { sessionId, projectPath } = req.body ?? {}
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return res.status(400).json({ error: { message: 'sessionId is required', type: 'invalid_request' } })
    }
    try {
      await sessionManager.getOrCreate(sessionId, projectPath)
      return res.status(204).end()
    } catch (err) {
      if (err.name === 'SessionConflictError') {
        return res.status(409).json({ error: { message: err.message, type: 'session_conflict' } })
      }
      if (err.name === 'InvalidProjectPathError') {
        return res.status(400).json({ error: { message: err.message, type: 'invalid_project_path' } })
      }
      return res.status(500).json({ error: { message: 'internal error', type: 'internal' } })
    }
  })

  app.use(createModelsRouter())
  app.use(createChatCompletionsRouter({ sessions: turnSessions, runner, timeoutMs }))
  return app
}

export function createServer(config, spawnFn) {
  const sessionManager = createSessionManager(spawnFn, {
    readinessTimeoutMs: config.readinessTimeoutMs,
    readinessSettleMs: config.readinessSettleMs,
  })
  const turnSessions = createTurnSessions()
  const runner = createClaudeCliRunner()
  const app = createApp(sessionManager, turnSessions, runner, { timeoutMs: config.execTimeoutMs })
  const httpServer = http.createServer(app)
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/api/session/stream',
    verifyClient: isAllowedOrigin,
  })
  wss.on('connection', createSessionStreamHandler(sessionManager))
  return { app, httpServer, wss }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig()
  const { httpServer } = createServer(config, pty.spawn)
  httpServer.listen(config.port, config.host)
}
