// A minimal virtual terminal for the login overlay's raw-output view.
//
// The CLI's interactive TUI (theme picker, login-method menu, etc.) repaints
// itself the way any ink/curses-style program does: relative cursor moves
// (CUU/CUD/CUF/CUB/CHA) plus erase-line sequences, not a fresh screen each
// time. Stripping ANSI codes and concatenating chunks therefore shows every
// historical frame stacked on top of the next — e.g. pressing an arrow key
// to move a menu selection *adds* a second copy of the menu instead of
// updating the first. This tracks just enough cursor state to materialize
// "what the screen shows right now."
//
// This is intentionally not a terminal emulator (xterm.js was dropped on
// purpose in the dashboard redesign — see README) — no color, no scrollback,
// no wide-char/grapheme handling, only the cursor-movement/erase subset this
// app's own CLI output actually uses, enough to keep text readable.

const ESC = '\u001b'
const CSI_FINAL = /[@-~]/

function blankRow() {
  return []
}

export function createTerminalBuffer() {
  const rows = [blankRow()]
  let row = 0
  let col = 0

  function ensureRow(r) {
    while (rows.length <= r) rows.push(blankRow())
  }

  function putChar(ch) {
    ensureRow(row)
    const line = rows[row]
    while (line.length < col) line.push(' ')
    line[col] = ch
    col += 1
  }

  function eraseLine(mode) {
    ensureRow(row)
    const line = rows[row]
    if (mode === 2) {
      line.length = 0
    } else if (mode === 1) {
      for (let i = 0; i < col && i < line.length; i++) line[i] = ' '
    } else {
      line.length = Math.min(line.length, col)
    }
  }

  function applyCsi(params, final) {
    const n = params === '' ? 1 : parseInt(params, 10) || 1
    switch (final) {
      case 'A':
        row = Math.max(0, row - n)
        break
      case 'B':
        row += n
        ensureRow(row)
        break
      case 'C':
        col += n
        break
      case 'D':
        col = Math.max(0, col - n)
        break
      case 'G':
        col = Math.max(0, n - 1)
        break
      case 'H':
      case 'f': {
        const [r, c] = params.split(';').map((v) => parseInt(v, 10) || 1)
        row = Math.max(0, (r || 1) - 1)
        col = Math.max(0, (c || 1) - 1)
        ensureRow(row)
        break
      }
      case 'K':
        eraseLine(params === '' ? 0 : parseInt(params, 10))
        break
      // SGR ('m'), private-mode toggles ('h'/'l'), device/status queries
      // and the rest don't affect the materialized text — ignored.
      default:
        break
    }
  }

  function write(chunk) {
    let i = 0
    while (i < chunk.length) {
      const ch = chunk[i]
      if (ch === ESC) {
        const next = chunk[i + 1]
        if (next === '[') {
          let j = i + 2
          while (j < chunk.length && !CSI_FINAL.test(chunk[j])) j++
          applyCsi(chunk.slice(i + 2, j), chunk[j])
          i = j + 1
          continue
        }
        if (next === ']') {
          // OSC: terminated by BEL or ST (ESC \\) — e.g. terminal-capability queries.
          let j = i + 2
          while (j < chunk.length && chunk[j] !== '\u0007' && !(chunk[j] === ESC && chunk[j + 1] === '\\')) j++
          i = chunk[j] === ESC ? j + 2 : j + 1
          continue
        }
        // Save/restore cursor (ESC 7 / ESC 8), charset designation
        // (ESC ( X / ESC ) X), and similar two-byte sequences — consumed,
        // not rendered.
        i += next === '(' || next === ')' ? 3 : 2
        continue
      }
      if (ch === '\r') {
        col = 0
        i++
        continue
      }
      if (ch === '\n') {
        row += 1
        ensureRow(row)
        i++
        continue
      }
      if (ch === '\u0007' || ch === '\b') {
        i++
        continue
      }
      putChar(ch)
      i++
    }
  }

  function render() {
    return rows
      .map((line) => line.join('').replace(/\s+$/u, ''))
      .join('\n')
      .replace(/^\n+/u, '')
      .replace(/\n+$/u, '')
  }

  return { write, render }
}
