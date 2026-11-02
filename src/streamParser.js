import pkg from '@xterm/headless'

const { Terminal } = pkg

// Claude Code's CLI is a full-screen TUI: it repaints a fixed-position
// prompt box, spinner, and status line in place using cursor-addressed
// escape codes, rather than printing a scrolling log of text. A naive
// "does the last line end in a prompt marker" scan sees that prompt box
// throughout the entire turn (including while it's still "thinking"), not
// just once it settles — so instead this feeds the raw bytes into a real
// (headless) terminal emulator and reads back the rendered screen.
//
// The one line the CLI only emits once a turn has actually finished is a
// status line like "✻ Brewed for 1s · done 6:15 PM" (the flavor verb and
// duration vary; the "done H:MM AM/PM" suffix does not).
const DONE_MARKER = /\bdone\s+\d{1,2}:\d{2}\s*[AP]M\b/i
const BORDER_LINE = /^[─]+$/
const FOOTER_LINE = /^⏵⏵/
const HINT_LINE = /^⎿|Tip:/
const PROMPT_LINE = /^❯/
const REPLY_PREFIX = /^●\s?/

function isChromeLine(line) {
  const trimmed = line.trim()
  return (
    trimmed === '' ||
    BORDER_LINE.test(trimmed) ||
    DONE_MARKER.test(trimmed) ||
    FOOTER_LINE.test(trimmed) ||
    HINT_LINE.test(trimmed) ||
    PROMPT_LINE.test(trimmed)
  )
}

export function createTurnBuffer() {
  const term = new Terminal({ cols: 120, rows: 40, allowProposedApi: true })

  function renderedLines() {
    const buf = term.buffer.active
    const lines = []
    for (let y = 0; y < buf.length; y++) {
      const line = buf.getLine(y)
      if (line) lines.push(line.translateToString(true))
    }
    return lines
  }

  return {
    push(rawChunk) {
      return new Promise((resolve) => term.write(rawChunk, resolve))
    },
    isReady() {
      return renderedLines().some((line) => DONE_MARKER.test(line))
    },
    getReply() {
      const lines = renderedLines()
      const doneIndex = lines.findIndex((line) => DONE_MARKER.test(line))
      if (doneIndex === -1) return ''

      const content = []
      for (let y = doneIndex - 1; y >= 0; y--) {
        if (isChromeLine(lines[y])) {
          if (content.length > 0) break
          continue
        }
        content.unshift(lines[y].replace(REPLY_PREFIX, '').trim())
      }
      return content.join('\n').trim()
    },
    dispose() {
      term.dispose()
    },
  }
}
