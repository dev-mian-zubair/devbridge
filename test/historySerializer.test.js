import { describe, it, expect } from 'vitest'
import { extractText, serializeHistory } from '../src/historySerializer.js'

describe('extractText', () => {
  it('returns a plain string as-is', () => {
    expect(extractText('hello')).toBe('hello')
  })

  it('joins text parts of a content array', () => {
    expect(extractText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('ab')
  })

  it('returns null for non-string, non-array content', () => {
    expect(extractText(null)).toBeNull()
    expect(extractText(undefined)).toBeNull()
  })
})

describe('serializeHistory', () => {
  it('renders a single user message', () => {
    expect(serializeHistory([{ role: 'user', content: 'hi' }])).toBe('User: hi')
  })

  it('renders a user/assistant/user exchange in order', () => {
    const messages = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'ack' },
      { role: 'user', content: 'second' },
    ]
    expect(serializeHistory(messages)).toBe('User: first\n\nAssistant: ack\n\nUser: second')
  })

  it('skips system and developer messages', () => {
    const messages = [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
    ]
    expect(serializeHistory(messages)).toBe('User: hi')
  })

  it('renders an assistant tool_calls message followed by its tool result', () => {
    const messages = [
      { role: 'user', content: 'weather in paris?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"location":"Paris"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'sunny, 22C' },
    ]
    expect(serializeHistory(messages)).toBe(
      'User: weather in paris?\n\n' +
      'Assistant called tool "get_weather" (call_id: call_1) with arguments: {"location":"Paris"}\n\n' +
      'Tool result (call_id: call_1): sunny, 22C'
    )
  })

  it('renders an assistant message that has both text and a tool call', () => {
    const messages = [{
      role: 'assistant',
      content: 'Let me check.',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }],
    }]
    expect(serializeHistory(messages)).toBe(
      'Assistant: Let me check.\nAssistant called tool "get_weather" (call_id: call_1) with arguments: {}'
    )
  })

  it('renders a tool result even when the current call has no tools declared (Review Focus)', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'tool', tool_call_id: 'call_orphan', content: 'some result' },
    ]
    expect(() => serializeHistory(messages)).not.toThrow()
    expect(serializeHistory(messages)).toContain('Tool result (call_id: call_orphan): some result')
  })
})
