import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { withTimeout } from '../src/timeoutGuard.js'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('withTimeout', () => {
  it('resolves with the inner promise value when it settles before the timeout', async () => {
    const onTimeout = vi.fn()
    const result = withTimeout(Promise.resolve('reply'), onTimeout, 120000)
    await expect(result).resolves.toBe('reply')
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it('calls onTimeout and rejects with a timeout error when the timer fires first', async () => {
    const onTimeout = vi.fn()
    const neverSettles = new Promise(() => {})
    const result = withTimeout(neverSettles, onTimeout, 120000)
    const assertion = expect(result).rejects.toThrow('timeout')
    await vi.advanceTimersByTimeAsync(120000)
    await assertion
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  it('rejects with the inner promise error when it rejects before the timeout', async () => {
    const onTimeout = vi.fn()
    const result = withTimeout(Promise.reject(new Error('boom')), onTimeout, 120000)
    await expect(result).rejects.toThrow('boom')
    expect(onTimeout).not.toHaveBeenCalled()
  })
})
