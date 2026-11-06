import { describe, it, expect } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { loadToolsConfig, buildToolsListResponse, isMainModule } from '../src/mcpStubServer.mjs'

describe('loadToolsConfig', () => {
  it('reads and parses the JSON file at the given path', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'mcp-stub-test-'))
    const file = path.join(tmp, 'tools.json')
    writeFileSync(file, JSON.stringify([{ name: 'get_weather', description: 'd', parameters: { type: 'object' } }]))
    expect(loadToolsConfig(file)).toEqual([{ name: 'get_weather', description: 'd', parameters: { type: 'object' } }])
  })
})

describe('buildToolsListResponse', () => {
  it('maps each tool to an MCP tool entry with its real schema', () => {
    const response = buildToolsListResponse([{ name: 'get_weather', description: 'd', parameters: { type: 'object', properties: { location: { type: 'string' } } } }])
    expect(response).toEqual({
      tools: [{ name: 'get_weather', description: 'd', inputSchema: { type: 'object', properties: { location: { type: 'string' } } } }],
    })
  })

  it('defaults a missing parameters to an empty object schema', () => {
    const response = buildToolsListResponse([{ name: 'ping', description: '' }])
    expect(response.tools[0].inputSchema).toEqual({ type: 'object', properties: {} })
  })
})

describe('isMainModule', () => {
  it('is true when run directly, even from an install path containing a space (security review #5)', () => {
    const scriptPath = '/opt/My Install/src/mcpStubServer.mjs'
    expect(isMainModule(pathToFileURL(scriptPath).href, scriptPath)).toBe(true)
  })

  it('is false for an unrelated path', () => {
    const scriptPath = '/opt/My Install/src/mcpStubServer.mjs'
    expect(isMainModule(pathToFileURL(scriptPath).href, '/opt/My Install/src/other.mjs')).toBe(false)
  })
})
