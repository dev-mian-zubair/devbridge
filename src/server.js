import express from 'express'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import * as pty from 'node-pty'
import { loadConfig } from './config.js'
import { createLoginSession } from './loginSession.js'
import { createTurnSessions } from './turnSessions.js'
import { createTurnEvents } from './turnEvents.js'
import { createClaudeCliRunner } from './claudeCliRunner.js'
import { createChatCompletionsRouter } from './routes/chatCompletions.js'
import { createModelsRouter } from './routes/models.js'
import { createSessionStreamHandler } from './ws/sessionStream.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const publicDir = path.join(__dirname, '..', 'public')

// DNS rebinding lets an attacker-controlled domain resolve to 127.0.0.1, so
// Origin and Host can be attacker-controlled *together* — comparing them to
// each other (the previous approach) proves nothing. Both are instead
// checked independently against a fixed hostname allowlist: loopback plus
// whatever hostnames the operator explicitly named via TRUSTED_HOSTS (e.g. a
// gateway's hostname on a private docker-compose network) — never a
// wildcard, so the deny-by-default posture holds for everything else.
const LOOPBACK_HOSTNAMES = ['127.0.0.1', 'localhost', '[::1]', '::1']

function buildTrustedHostnames(additional = []) {
  return new Set([...LOOPBACK_HOSTNAMES, ...additional])
}

function hostnameOf(hostHeader) {
  if (!hostHeader) return null
  if (hostHeader.startsWith('[')) {
    const end = hostHeader.indexOf(']')
    return end === -1 ? null : hostHeader.slice(0, end + 1)
  }
  return hostHeader.split(':')[0]
}

function isTrustedHostHeader(hostHeader, trustedHostnames) {
  const hostname = hostnameOf(hostHeader)
  return hostname !== null && trustedHostnames.has(hostname)
}

function createSameOriginOnly(trustedHostnames) {
  return function sameOriginOnly(req, res, next) {
    if (!isTrustedHostHeader(req.headers.host, trustedHostnames)) {
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
      if (!isTrustedHostHeader(originHost, trustedHostnames)) {
        return res.status(403).json({ error: { message: 'forbidden origin', type: 'forbidden' } })
      }
    }
    next()
  }
}

function createIsAllowedOrigin(trustedHostnames) {
  return function isAllowedOrigin({ req }) {
    if (!isTrustedHostHeader(req.headers.host, trustedHostnames)) return false
    const origin = req.headers.origin
    if (!origin) return true
    try {
      return isTrustedHostHeader(new URL(origin).host, trustedHostnames)
    } catch {
      return false
    }
  }
}

export function createApp({ turnSessions, runner, events, timeoutMs = 120000, trustedHosts = [] } = {}) {
  const app = express()
  app.use(createSameOriginOnly(buildTrustedHostnames(trustedHosts)))
  app.use(express.json())
  app.use(express.static(publicDir))

  app.use(createModelsRouter())
  app.use(createChatCompletionsRouter({ sessions: turnSessions, runner, timeoutMs, events }))
  return app
}

export function createServer(config, spawnFn) {
  const events = createTurnEvents()
  const turnSessions = createTurnSessions(undefined, events)
  const loginSession = createLoginSession(spawnFn, {
    readinessTimeoutMs: config.readinessTimeoutMs,
    readinessSettleMs: config.readinessSettleMs,
    claudeConfigDir: config.claudeConfigDir,
  })
  const runner = createClaudeCliRunner()
  const app = createApp({
    turnSessions,
    runner,
    events,
    timeoutMs: config.execTimeoutMs,
    trustedHosts: config.trustedHosts,
  })
  const httpServer = http.createServer(app)
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/api/session/stream',
    verifyClient: createIsAllowedOrigin(buildTrustedHostnames(config.trustedHosts)),
  })
  wss.on('connection', createSessionStreamHandler({ turnSessions, events, loginSession }))
  return { app, httpServer, wss }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig()
  const { httpServer } = createServer(config, pty.spawn)
  httpServer.listen(config.port, config.host)
}
