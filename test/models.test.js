import { describe, it, expect } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createModelsRouter } from '../src/routes/models.js'

describe('GET /v1/models', () => {
  it('lists the model aliases the CLI exposes via --model, in OpenAI list shape', async () => {
    const app = express()
    app.use(createModelsRouter())
    const res = await request(app).get('/v1/models')

    expect(res.status).toBe(200)
    expect(res.body.object).toBe('list')
    expect(res.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'opus', object: 'model', owned_by: 'anthropic' }),
        expect.objectContaining({ id: 'sonnet', object: 'model', owned_by: 'anthropic' }),
        expect.objectContaining({ id: 'haiku', object: 'model', owned_by: 'anthropic' }),
      ])
    )
    expect(res.body.data.every((m) => typeof m.created === 'number')).toBe(true)
  })
})
