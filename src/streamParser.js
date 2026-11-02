import stripAnsi from 'strip-ansi'

const PROMPT_MARKER = /(❯|\?)\s*$/

export function createTurnBuffer() {
  let raw = ''

  function strippedLines() {
    return stripAnsi(raw).split('\n').filter((line) => line.trim().length > 0)
  }

  return {
    push(rawChunk) {
      raw += rawChunk
    },
    isReady() {
      const lines = strippedLines()
      if (lines.length === 0) return false
      return PROMPT_MARKER.test(lines[lines.length - 1])
    },
    getReply() {
      const lines = strippedLines()
      if (lines.length > 0 && PROMPT_MARKER.test(lines[lines.length - 1])) {
        lines.pop()
      }
      return lines.join('\n').trim()
    },
  }
}
