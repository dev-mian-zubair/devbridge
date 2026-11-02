import express from 'express'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import * as pty from 'node-pty'
import { loadConfig } from './config.js'
import { createSessionManager } from './sessionManager.js'
import { createChatCompletionsRouter } from './routes/chatCompletions.js'
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

export function createApp(sessionManager, { timeoutMs = 120000 } = {}) {
  const app = express()
  app.use(sameOriginOnly)
  app.use(express.json())
  app.use(express.static(publicDir))
  app.use(createChatCompletionsRouter(sessionManager, { timeoutMs }))
  return app
}

export function createServer(config, spawnFn) {
  const sessionManager = createSessionManager(spawnFn)
  const app = createApp(sessionManager, { timeoutMs: config.execTimeoutMs })
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
