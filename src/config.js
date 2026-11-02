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
    readinessTimeoutMs: env.READINESS_TIMEOUT_MS ? parseNumber(env.READINESS_TIMEOUT_MS, 5000) : 5000,
    readinessSettleMs: env.READINESS_SETTLE_MS ? parseNumber(env.READINESS_SETTLE_MS, 250) : 250,
  }
}
