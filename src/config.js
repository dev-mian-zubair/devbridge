function parseNumber(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function loadConfig(env = process.env) {
  return {
    port: env.PORT ? parseNumber(env.PORT, 3000) : 3000,
    host: env.HOST ?? '127.0.0.1',
    claudeConfigDir: env.CLAUDE_CONFIG_DIR ?? '/data/.claude',
    execTimeoutMs: env.EXEC_TIMEOUT_MS ? parseNumber(env.EXEC_TIMEOUT_MS, 120000) : 120000,
  }
}
