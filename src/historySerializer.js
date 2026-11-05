export function extractText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('')
  }
  return null
}

function renderMessage(message) {
  const { role, content, tool_calls: toolCalls, tool_call_id: toolCallId } = message

  if (role === 'system' || role === 'developer') return ''

  if (role === 'tool') {
    return `Tool result (call_id: ${toolCallId}): ${extractText(content)}\n\n`
  }

  if (role === 'assistant' && Array.isArray(toolCalls) && toolCalls.length > 0) {
    const text = extractText(content)
    let rendered = text ? `Assistant: ${text}\n` : ''
    for (const tc of toolCalls) {
      rendered += `Assistant called tool "${tc.function.name}" (call_id: ${tc.id}) with arguments: ${tc.function.arguments}\n`
    }
    return `${rendered}\n`
  }

  if (role === 'assistant') {
    return `Assistant: ${extractText(content)}\n\n`
  }

  return `User: ${extractText(content)}\n\n`
}

export function serializeHistory(messages) {
  return messages.map(renderMessage).join('').trimEnd()
}
