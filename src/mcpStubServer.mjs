import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import fs from 'node:fs'

export function loadToolsConfig(configPath) {
  return JSON.parse(fs.readFileSync(configPath, 'utf8'))
}

export function buildToolsListResponse(toolsConfig) {
  return {
    tools: toolsConfig.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.parameters ?? { type: 'object', properties: {} },
    })),
  }
}

async function main() {
  const toolsConfig = loadToolsConfig(process.env.DEVBRIDGE_TOOLS_CONFIG_PATH)
  const server = new Server({ name: 'client-tools', version: '0.0.1' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => buildToolsListResponse(toolsConfig))
  // Anti-goal: this must never run for real. If interception ever fails to
  // fire, this must be a loud, visible error — never a fabricated result.
  server.setRequestHandler(CallToolRequestSchema, async () => {
    throw new Error('DevBridge interception failed: MCP stub tool handler executed for real')
  })
  await server.connect(new StdioServerTransport())
}

if (import.meta.url === `file://${process.argv[1]}`) main()
