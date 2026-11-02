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
