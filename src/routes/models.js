import { Router } from 'express'

// These are the CLI's own documented model aliases (`claude --model <alias>`),
// not a dynamic list from an API — the CLI is the source of truth for what
// a given alias resolves to, and that can change independently of this proxy.
const MODEL_ALIASES = ['opus', 'sonnet', 'haiku', 'fable']

export function createModelsRouter() {
  const router = Router()
  const created = Math.floor(Date.now() / 1000)

  router.get('/v1/models', (_req, res) => {
    res.json({
      object: 'list',
      data: MODEL_ALIASES.map((id) => ({ id, object: 'model', created, owned_by: 'anthropic' })),
    })
  })

  return router
}
