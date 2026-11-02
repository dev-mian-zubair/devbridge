import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { withTimeout } from '../src/timeoutGuard.js'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('withTimeout', () => {
  it('resolves with the inner promise value when it settles before the timeout', async () => {
    const pty = { write: vi.fn() }
    const result = withTimeout(Promise.resolve('reply'), pty, 120000)
    await expect(result).resolves.toBe('reply')
    expect(pty.write).not.toHaveBeenCalled()
  })

  it('force-injects SIGINT and rejects with a timeout error when the timer fires first', async () => {
    const pty = { write: vi.fn() }
    const neverSettles = new Promise(() => {})
    const result = withTimeout(neverSettles, pty, 120000)
    const assertion = expect(result).rejects.toThrow('timeout')
    await vi.advanceTimersByTimeAsync(120000)
    await assertion
    expect(pty.write).toHaveBeenCalledWith('\x03')
  })
})
