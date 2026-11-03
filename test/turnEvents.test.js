import { describe, it, expect, vi } from 'vitest'
import { createTurnEvents } from '../src/turnEvents.js'

describe('createTurnEvents', () => {
  it('delivers a published message to a subscribed listener', () => {
    const events = createTurnEvents()
    const listener = vi.fn()
    events.subscribe(listener)
    events.publish({ type: 'session:update', session: { sessionId: 's1' } })
    expect(listener).toHaveBeenCalledWith({ type: 'session:update', session: { sessionId: 's1' } })
  })

  it('delivers a published message to every subscribed listener', () => {
    const events = createTurnEvents()
    const a = vi.fn()
    const b = vi.fn()
    events.subscribe(a)
    events.subscribe(b)
    events.publish({ type: 'session:delta', sessionId: 's1', text: 'hi' })
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('stops delivering to a listener once unsubscribed', () => {
    const events = createTurnEvents()
    const listener = vi.fn()
    const unsubscribe = events.subscribe(listener)
    unsubscribe()
    events.publish({ type: 'session:delta', sessionId: 's1', text: 'hi' })
    expect(listener).not.toHaveBeenCalled()
  })

  it('does not let one listener throwing stop delivery to the others', () => {
    const events = createTurnEvents()
    const broken = vi.fn(() => { throw new Error('boom') })
    const fine = vi.fn()
    events.subscribe(broken)
    events.subscribe(fine)
    expect(() => events.publish({ type: 'session:update', session: {} })).not.toThrow()
    expect(fine).toHaveBeenCalledTimes(1)
  })
})
