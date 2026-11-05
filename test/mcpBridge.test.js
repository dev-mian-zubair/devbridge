import { describe, it, expect, vi } from 'vitest'
import { createMcpBridge } from '../src/mcpBridge.js'

function fakeFs(overrides = {}) {
  const written = {}
  return {
    written,
    mkdtempSync: vi.fn(() => '/tmp/devbridge-tools-fake'),
    writeFileSync: vi.fn((p, content) => { written[p] = content }),
    rmSync: vi.fn(),
    ...overrides,
  }
}
const SAMPLE_TOOLS = [{ type: 'function', function: { name: 'get_weather', description: 'd', parameters: { type: 'object' } } }]

describe('createMcpBridge', () => {
  it('writes a tools.json with name/description/parameters for each tool', () => {
    const fs = fakeFs()
    createMcpBridge(SAMPLE_TOOLS, fs)
    const toolsJsonPath = Object.keys(fs.written).find((p) => p.endsWith('tools.json'))
    expect(JSON.parse(fs.written[toolsJsonPath])).toEqual([{ name: 'get_weather', description: 'd', parameters: { type: 'object' } }])
  })

  it('writes an mcp-config.json that points at mcpStubServer.mjs with the tools.json path in env', () => {
    const fs = fakeFs()
    const { mcpConfigPath } = createMcpBridge(SAMPLE_TOOLS, fs)
    const config = JSON.parse(fs.written[mcpConfigPath])
    expect(config.mcpServers['client-tools'].args[0]).toMatch(/mcpStubServer\.mjs$/)
    expect(config.mcpServers['client-tools'].env.DEVBRIDGE_TOOLS_CONFIG_PATH).toMatch(/tools\.json$/)
  })

  it('returns allowedToolNames prefixed with mcp__client-tools__', () => {
    const { allowedToolNames } = createMcpBridge(SAMPLE_TOOLS, fakeFs())
    expect(allowedToolNames).toEqual(['mcp__client-tools__get_weather'])
  })

  it('cleanup removes the temp directory it created', () => {
    const fs = fakeFs()
    const { cleanup } = createMcpBridge(SAMPLE_TOOLS, fs)
    cleanup()
    expect(fs.rmSync).toHaveBeenCalledWith('/tmp/devbridge-tools-fake', { recursive: true, force: true })
  })

  it('cleanup does not throw if rmSync itself throws', () => {
    const fs = fakeFs({ rmSync: vi.fn(() => { throw new Error('gone') }) })
    const { cleanup } = createMcpBridge(SAMPLE_TOOLS, fs)
    expect(() => cleanup()).not.toThrow()
  })
})
