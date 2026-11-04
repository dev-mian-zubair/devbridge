import { describe, it, expect } from 'vitest'
import { createTerminalBuffer } from '../public/terminalBuffer.js'

describe('createTerminalBuffer', () => {
  it('renders plain text written with no escapes', () => {
    const term = createTerminalBuffer()
    term.write('hello')
    expect(term.render()).toBe('hello')
  })

  it('renders a line feed as a new row', () => {
    const term = createTerminalBuffer()
    term.write('line1\r\nline2')
    expect(term.render()).toBe('line1\nline2')
  })

  it('overwrites earlier characters on carriage return', () => {
    const term = createTerminalBuffer()
    term.write('hello')
    term.write('\rHI')
    expect(term.render()).toBe('HIllo')
  })

  it('moves the cursor backward and overwrites in place (CUB)', () => {
    const term = createTerminalBuffer()
    term.write('abc')
    term.write('\u001b[2DX')
    expect(term.render()).toBe('aXc')
  })

  it('moves the cursor to an absolute column (CHA)', () => {
    const term = createTerminalBuffer()
    term.write('abcdef')
    term.write('\u001b[3GXY')
    expect(term.render()).toBe('abXYef')
  })

  it('erases the rest of the current line (EL 0)', () => {
    const term = createTerminalBuffer()
    term.write('hello world')
    term.write('\r\u001b[5C\u001b[K')
    expect(term.render()).toBe('hello')
  })

  it('erases an entire line (EL 2) without touching other rows', () => {
    const term = createTerminalBuffer()
    term.write('line1\r\nline2')
    term.write('\u001b[2K')
    expect(term.render()).toBe('line1')
  })

  it('moves the cursor up and down across rows (CUU/CUD)', () => {
    const term = createTerminalBuffer()
    term.write('aaa\r\nbbb\r\nccc')
    term.write('\u001b[1A\rX')
    expect(term.render()).toBe('aaa\nXbb\nccc')
  })

  it('strips SGR color codes and private-mode toggles without affecting layout', () => {
    const term = createTerminalBuffer()
    term.write('\u001b[?25l\u001b[38;5;153mhello\u001b[39m\u001b[?25h')
    expect(term.render()).toBe('hello')
  })

  it('strips OSC sequences terminated by BEL', () => {
    const term = createTerminalBuffer()
    term.write('before\u001b]7501;?\u0007after')
    expect(term.render()).toBe('beforeafter')
  })

  // Real bytes captured from the CLI's own /login flow (login-method menu),
  // via a WS probe against a running devbridge instance — see commit
  // message. Confirms the cursor-tracking model matches this app's actual
  // redraw idiom (ink-style: erase-line + relative cursor moves), not just
  // a hand-rolled synthetic case.
  const MENU_PAINT =
    '\u001b[1D\u001b[14B\u001b[2K\u001b[1A\u001b[2K\u001b[1A\u001b[2K\u001b[1A\u001b[2K\u001b[1A\u001b[2K\u001b[1A\u001b[2K\u001b[1A\u001b[2K\u001b[1A\u001b[2K\u001b[1A\u001b[2K\u001b[1A\u001b[2K\u001b[1A\u001b[2K\u001b[G\u001b[1A\r\u001b[1C\u001b[7A\u001b[1mClaude Code can be used with your Claude subscription or billed based on API usage through your Console account.\r\u001b[1C\u001b[2B\u001b[22mSelect login method:\u001b[K\r\u001b[1C\u001b[1B\u001b[K\r\u001b[1C\u001b[1B\u001b[38;5;153m❯\u001b[4G\u001b[38;5;246m1. \u001b[38;5;153mClaude account with subscription · \u001b[38;5;246mPro, Max, Team, or Enterprise\r\u001b[3C\u001b[1B2. \u001b[39mAnthropi\u001b[16G Console account\u001b[33G·\u001b[35G\u001b[38;5;246mAPI usage billing\r\u001b[1B\u001b[39m \u001b[4G\u001b[38;5;246m3. \u001b[39m3rd-party\u001b[17Gplatform\u001b[26G·\u001b[28G\u001b[38;5;246mAmazon Bedrock, Microsoft Foundry, Google Vertex AI\r\u001b[1B\u001b[39m\u001b[K\r\u001b[1B\u001b[K\r\u001b[1B\u001b[K\r\u001b[1B\u001b[K\r\u001b[1B\u001b[K\r\u001b[1B\u001b[K\r\u001b[1B\u001b[K\r\u001b[1B\u001b[K\r\u001b[1B\u001b[K\r\u001b[1B\u001b[K\r\u001b[1B\u001b[K\r\u001b[1B\u001b[K\r\u001b[1B\u001b[K\r\u001b[12A\u001b[1C\u001b[3A'
  const MENU_ARROW_DOWN =
    '\u001b[1D\u001b[3B\r\u001b[1C\u001b[3A \u001b[7GClaude account with subscription · \r\u001b[1C\u001b[1B\u001b[38;5;153m❯\u001b[7GAnthropic Console account · \u001b[39m\r\r\n\r\n\u001b[1C\u001b[2A'

  it('renders the real login-method menu readably, selection on option 1', () => {
    const term = createTerminalBuffer()
    term.write(MENU_PAINT)
    const text = term.render()
    expect(text).toContain('Select login method:')
    expect(text).toContain('❯ 1. Claude account with subscription · Pro, Max, Team, or Enterprise')
    expect(text).toContain('2. Anthropi')
    expect(text).toContain('Console account')
    expect(text).toContain('3. 3rd-party platform')
  })

  it('moves the selection marker instead of duplicating the menu on arrow-down', () => {
    const term = createTerminalBuffer()
    term.write(MENU_PAINT)
    term.write(MENU_ARROW_DOWN)
    const text = term.render()
    expect(text).not.toContain('❯ 1. Claude account')
    expect(text).toContain('1. Claude account with subscription ·')
    expect(text).toContain('❯ 2. Anthropic Console account ·')
    // The real bug: option text must appear exactly once each, not stacked
    // from both the initial paint and the redraw.
    expect(text.split('Claude account with subscription').length - 1).toBe(1)
    expect(text.split('Anthropic Console account').length - 1).toBe(1)
  })
})
