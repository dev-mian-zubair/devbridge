import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const MCP_SERVER_NAME = 'client-tools'

const STUB_SERVER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcpStubServer.mjs')

export function createMcpBridge(
  tools,
  { mkdtempSync = fs.mkdtempSync, writeFileSync = fs.writeFileSync, rmSync = fs.rmSync } = {}
) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'devbridge-tools-'))
  const toolsConfigPath = path.join(dir, 'tools.json')
  const mcpConfigPath = path.join(dir, 'mcp-config.json')

  const toolsConfig = tools.map((t) => ({
    name: t.function.name,
    description: t.function.description ?? '',
    parameters: t.function.parameters ?? { type: 'object', properties: {} },
  }))
  writeFileSync(toolsConfigPath, JSON.stringify(toolsConfig))
  writeFileSync(
    mcpConfigPath,
    JSON.stringify({
      mcpServers: {
        [MCP_SERVER_NAME]: {
          command: process.execPath,
          args: [STUB_SERVER_PATH],
          env: { DEVBRIDGE_TOOLS_CONFIG_PATH: toolsConfigPath },
        },
      },
    })
  )

  const allowedToolNames = tools.map((t) => `mcp__${MCP_SERVER_NAME}__${t.function.name}`)

  return {
    mcpConfigPath,
    allowedToolNames,
    cleanup() {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // Best-effort — an orphaned temp directory is harmless.
      }
    },
  }
}
