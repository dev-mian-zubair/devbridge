import { describe, it, expect, vi } from 'vitest'
import request from 'supertest'
import { createServer } from '../src/server.js'

describe('createServer', () => {
  it('serves the dashboard shell at /', async () => {
    const { app } = createServer({ port: 0, host: '127.0.0.1', execTimeoutMs: 1000 }, vi.fn())
    const res = await request(app).get('/')
    expect(res.status).toBe(200)
    expect(res.text).toContain('<html')
  })

  it('mounts the chat completions route', async () => {
    const spawnFn = vi.fn(() => ({ write: vi.fn(), onData: vi.fn(), kill: vi.fn() }))
    const { app } = createServer({ port: 0, host: '127.0.0.1', execTimeoutMs: 1000 }, spawnFn)
    const res = await request(app).post('/v1/chat/completions').send({
      sessionId: 's1', projectPath: '/app/workspace/proj', messages: [{ role: 'user', content: 'hi' }],
    })
    expect(res.status).not.toBe(404)
  })
})
