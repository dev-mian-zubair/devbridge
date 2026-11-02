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

function isAllowedOrigin({ req }) {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

export function createApp(sessionManager, { timeoutMs = 120000 } = {}) {
  const app = express()
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
