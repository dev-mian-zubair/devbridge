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

  describe('POST /api/sessions', () => {
    it('creates the PTY session the debug terminal will attach to', async () => {
      const pty = { write: vi.fn(), onData: vi.fn(), onExit: vi.fn(), kill: vi.fn() }
      const spawnFn = vi.fn(() => pty)
      const { app } = createServer({ port: 0, host: '127.0.0.1', execTimeoutMs: 1000 }, spawnFn)
      const res = await request(app).post('/api/sessions').send({ sessionId: 's1', projectPath: '/app/workspace/proj' })
      expect(res.status).toBe(204)
      expect(spawnFn).toHaveBeenCalledTimes(1)
    })

    it('returns 400 for a missing sessionId', async () => {
      const { app } = createServer({ port: 0, host: '127.0.0.1', execTimeoutMs: 1000 }, vi.fn())
      const res = await request(app).post('/api/sessions').send({ projectPath: '/app/workspace/proj' })
      expect(res.status).toBe(400)
      expect(res.body.error.type).toBe('invalid_request')
    })

    it('returns 400 for an invalid projectPath', async () => {
      const { app } = createServer({ port: 0, host: '127.0.0.1', execTimeoutMs: 1000 }, vi.fn())
      const res = await request(app).post('/api/sessions').send({ sessionId: 's1', projectPath: 'relative' })
      expect(res.status).toBe(400)
      expect(res.body.error.type).toBe('invalid_project_path')
    })

    it('returns 409 when the sessionId is already bound to a different projectPath', async () => {
      const pty = { write: vi.fn(), onData: vi.fn(), onExit: vi.fn(), kill: vi.fn() }
      const spawnFn = vi.fn(() => pty)
      const { app } = createServer({ port: 0, host: '127.0.0.1', execTimeoutMs: 1000 }, spawnFn)
      await request(app).post('/api/sessions').send({ sessionId: 's1', projectPath: '/a' })
      const res = await request(app).post('/api/sessions').send({ sessionId: 's1', projectPath: '/b' })
      expect(res.status).toBe(409)
      expect(res.body.error.type).toBe('session_conflict')
    })
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
  })
})
