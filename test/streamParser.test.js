import { describe, it, expect } from 'vitest'
import { createTurnBuffer } from '../src/streamParser.js'

describe('createTurnBuffer', () => {
  it('is not ready until a prompt marker line appears', () => {
    const buf = createTurnBuffer()
    buf.push('Here is the analysis...\n')
    expect(buf.isReady()).toBe(false)
  })

  it('is ready once a line ends with the ❯ cursor marker', () => {
    const buf = createTurnBuffer()
    buf.push('Done.\n❯ ')
    expect(buf.isReady()).toBe(true)
  })

  it('is ready once a line ends with a trailing ? cue', () => {
    const buf = createTurnBuffer()
    buf.push('Proceed with the change?')
    expect(buf.isReady()).toBe(true)
  })

  it('strips ANSI styling from the final reply', () => {
    const buf = createTurnBuffer()
    buf.push('\u001b[32mAll good\u001b[0m\n❯ ')
    expect(buf.getReply()).toBe('All good')
  })

  it('reassembles an ANSI escape sequence split across two chunks', () => {
    const buf = createTurnBuffer()
    buf.push('\u001b[32mAll good')
    buf.push('\u001b[0m\n❯ ')
    expect(buf.getReply()).toBe('All good')
  })
})
