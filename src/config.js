export function loadConfig(env = process.env) {
  return {
    port: env.PORT ? Number(env.PORT) : 3000,
    host: env.HOST ?? '127.0.0.1',
    claudeConfigDir: env.CLAUDE_CONFIG_DIR ?? '/data/.claude',
    execTimeoutMs: env.EXEC_TIMEOUT_MS ? Number(env.EXEC_TIMEOUT_MS) : 120000,
  }
}
