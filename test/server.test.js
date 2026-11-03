import { describe, it, expect, vi, afterEach } from 'vitest'
import request from 'supertest'
import { WebSocket } from 'ws'
import { createServer } from '../src/server.js'

describe('createServer', () => {
  it('serves the dashboard shell at /', async () => {
    const { app } = createServer({ port: 0, host: '127.0.0.1', execTimeoutMs: 1000 }, vi.fn())
    const res = await request(app).get('/')
    expect(res.status).toBe(200)
    expect(res.text).toContain('<html')
  })

  it('mounts the chat completions route', async () => {
    const spawnFn = vi.fn(() => ({ write: vi.fn(), onData: vi.fn(), onExit: vi.fn(), kill: vi.fn() }))
    const { app } = createServer({ port: 0, host: '127.0.0.1', execTimeoutMs: 1000 }, spawnFn)
    const res = await request(app).post('/v1/chat/completions').send({
      sessionId: 's1', projectPath: '/app/workspace/proj', messages: [{ role: 'user', content: 'hi' }],
    })
    expect(res.status).not.toBe(404)
  })

  describe('Cross-origin / DNS-rebinding protection on HTTP routes', () => {
    it('rejects a request whose Host header is not a loopback hostname, even without Origin', async () => {
      const { app } = createServer({ port: 0, host: '127.0.0.1', execTimeoutMs: 1000 }, vi.fn())
      const res = await request(app).get('/').set('Host', 'evil.example')
      expect(res.status).toBe(403)
    })

    it('rejects a request whose Host is loopback but whose Origin is not (cross-site POST)', async () => {
      const spawnFn = vi.fn(() => ({ write: vi.fn(), onData: vi.fn(), onExit: vi.fn(), kill: vi.fn() }))
      const { app } = createServer({ port: 0, host: '127.0.0.1', execTimeoutMs: 1000 }, spawnFn)
      const res = await request(app).post('/v1/chat/completions')
        .set('Origin', 'http://evil.example')
        .send({ sessionId: 's1', projectPath: '/app/workspace/proj', messages: [{ role: 'user', content: 'hi' }] })
      expect(res.status).toBe(403)
    })

    it('allows a request with a loopback Host and no Origin (non-browser client)', async () => {
      const { app } = createServer({ port: 0, host: '127.0.0.1', execTimeoutMs: 1000 }, vi.fn())
      const res = await request(app).get('/')
      expect(res.status).toBe(200)
    })

    it('allows a request with a loopback Host and a loopback Origin', async () => {
      const { app } = createServer({ port: 0, host: '127.0.0.1', execTimeoutMs: 1000 }, vi.fn())
      const res = await request(app).get('/').set('Origin', 'http://127.0.0.1:3000')
      expect(res.status).toBe(200)
    })

    it('rejects a non-loopback Host when trustedHosts is empty (default)', async () => {
      const { app } = createServer({ port: 0, host: '127.0.0.1', execTimeoutMs: 1000, trustedHosts: [] }, vi.fn())
      const res = await request(app).get('/').set('Host', 'litellm:4000')
      expect(res.status).toBe(403)
    })

    it('allows a Host explicitly named in trustedHosts (port is ignored, same as loopback)', async () => {
      const { app } = createServer({ port: 0, host: '127.0.0.1', execTimeoutMs: 1000, trustedHosts: ['litellm'] }, vi.fn())
      const res = await request(app).get('/').set('Host', 'litellm:4000')
      expect(res.status).toBe(200)
    })

    it('still rejects a Host not in trustedHosts even when the list is non-empty', async () => {
      const { app } = createServer({ port: 0, host: '127.0.0.1', execTimeoutMs: 1000, trustedHosts: ['litellm'] }, vi.fn())
      const res = await request(app).get('/').set('Host', 'evil.example')
      expect(res.status).toBe(403)
    })

    it('allows an Origin explicitly named in trustedHosts', async () => {
      const { app } = createServer({ port: 0, host: '127.0.0.1', execTimeoutMs: 1000, trustedHosts: ['litellm'] }, vi.fn())
      const res = await request(app).get('/').set('Host', 'litellm:4000').set('Origin', 'http://litellm:4000')
      expect(res.status).toBe(200)
    })
  })

  describe('WS /api/session/stream origin check', () => {
    let httpServer

    afterEach(() => {
      httpServer?.close()
    })

    function connect(port, origin) {
      return new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/session/stream`, { headers: { origin } })
        ws.on('open', () => { resolve(true); ws.close() })
        ws.on('unexpected-response', () => resolve(false))
        ws.on('error', () => resolve(false))
      })
    }

    it('accepts a same-origin upgrade and rejects a cross-origin one', async () => {
      ;({ httpServer } = createServer({ port: 0, host: '127.0.0.1', execTimeoutMs: 1000 }, vi.fn()))
      await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
      const { port } = httpServer.address()

      await expect(connect(port, `http://127.0.0.1:${port}`)).resolves.toBe(true)
      await expect(connect(port, 'http://evil.example')).resolves.toBe(false)
    })

    it('accepts an upgrade whose Origin is explicitly named in trustedHosts', async () => {
      ;({ httpServer } = createServer({ port: 0, host: '127.0.0.1', execTimeoutMs: 1000, trustedHosts: ['litellm'] }, vi.fn()))
      await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
      const { port } = httpServer.address()

      await expect(connect(port, 'http://litellm:4000')).resolves.toBe(true)
    })
  })

  describe('WS /api/session/stream wiring', () => {
    let httpServer

    afterEach(() => {
      httpServer?.close()
    })

    function connectAndCollect(port) {
      return new Promise((resolve) => {
        const messages = []
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/session/stream`)
        ws.on('message', (raw) => {
          messages.push(JSON.parse(raw))
          resolve({ ws, messages })
        })
      })
    }

    it('sends a snapshot of current sessions as soon as the dashboard connects', async () => {
      ;({ httpServer } = createServer({ port: 0, host: '127.0.0.1', execTimeoutMs: 1000 }, vi.fn()))
      await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
      const { port } = httpServer.address()

      const { ws, messages } = await connectAndCollect(port)
      expect(messages[0]).toEqual({ type: 'snapshot', sessions: [] })
      ws.close()
    })

    it('spawns the login PTY via the injected spawnFn when the dashboard sends login:start', async () => {
      const pty = { write: vi.fn(), onData: vi.fn(), onExit: vi.fn(), kill: vi.fn() }
      const spawnFn = vi.fn(() => pty)
      ;({ httpServer } = createServer({ port: 0, host: '127.0.0.1', execTimeoutMs: 1000, readinessTimeoutMs: 10, readinessSettleMs: 1 }, spawnFn))
      await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
      const { port } = httpServer.address()

      const { ws } = await connectAndCollect(port)
      ws.send(JSON.stringify({ type: 'login:start' }))
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(spawnFn).toHaveBeenCalledTimes(1)
      ws.close()
    })
  })
})
