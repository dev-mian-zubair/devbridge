import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTurnBuffer } from '../src/streamParser.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAY_OK_FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'say-ok.txt'), 'utf8')

describe('createTurnBuffer', () => {
  it('is not ready until a "done H:MM" status line appears', async () => {
    const buf = createTurnBuffer()
    await buf.push('Thinking…\r\n')
    expect(buf.isReady()).toBe(false)
    buf.dispose()
  })

  it('is ready once a status line like "done 6:15 PM" appears', async () => {
    const buf = createTurnBuffer()
    await buf.push('✳ Brewed for 1s · done 6:15 PM\r\n')
    expect(buf.isReady()).toBe(true)
    buf.dispose()
  })

  it('extracts the clean reply from a real captured CLI transcript', async () => {
    const buf = createTurnBuffer()
    await buf.push(SAY_OK_FIXTURE)
    expect(buf.isReady()).toBe(true)
    expect(buf.getReply()).toBe('OK')
    buf.dispose()
  })

  it('reassembles a real transcript split across multiple chunks', async () => {
    const buf = createTurnBuffer()
    const mid = Math.floor(SAY_OK_FIXTURE.length / 2)
    await buf.push(SAY_OK_FIXTURE.slice(0, mid))
    await buf.push(SAY_OK_FIXTURE.slice(mid))
    expect(buf.isReady()).toBe(true)
    expect(buf.getReply()).toBe('OK')
    buf.dispose()
  })

  it('does not mistake the live "thinking" spinner animation for completion', async () => {
    const buf = createTurnBuffer()
    const doneIdx = SAY_OK_FIXTURE.indexOf('done 6:15 PM')
    await buf.push(SAY_OK_FIXTURE.slice(0, doneIdx))
    expect(buf.isReady()).toBe(false)
    buf.dispose()
  })

  it('extracts a multi-line reply bounded by chrome lines', async () => {
    const buf = createTurnBuffer()
    await buf.push(
      '❯ hello\r\n' +
      '\r\n' +
      '● First line\r\n' +
      'Second line\r\n' +
      '\r\n' +
      '✻ Brewed for 2s · done 6:20 PM\r\n' +
      '────────\r\n' +
      '❯  \r\n'
    )
    expect(buf.getReply()).toBe('First line\nSecond line')
    buf.dispose()
  })
})
