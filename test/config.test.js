import { describe, it, expect } from 'vitest'
import { loadConfig } from '../src/config.js'

describe('loadConfig', () => {
  it('applies defaults when env vars are absent', () => {
    const cfg = loadConfig({})
    expect(cfg).toEqual({ port: 3000, host: '127.0.0.1', claudeConfigDir: '/data/.claude', execTimeoutMs: 120000 })
  })

  it('overrides defaults from the given env object', () => {
    const cfg = loadConfig({ PORT: '4000', HOST: '0.0.0.0', CLAUDE_CONFIG_DIR: '/x', EXEC_TIMEOUT_MS: '5000' })
    expect(cfg).toEqual({ port: 4000, host: '0.0.0.0', claudeConfigDir: '/x', execTimeoutMs: 5000 })
  })
})
