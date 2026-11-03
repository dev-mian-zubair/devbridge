const term = new window.Terminal()
const fitAddon = new window.FitAddon.FitAddon()
term.loadAddon(fitAddon)
term.open(document.getElementById('terminal'))
fitAddon.fit()

const statusBar = document.getElementById('status-bar')
const sessionList = document.getElementById('session-list')
const addSessionForm = document.getElementById('add-session-form')
const sessionIdInput = document.getElementById('session-id-input')
const projectPathInput = document.getElementById('project-path-input')
const authButton = document.getElementById('auth-button')
const authLink = document.getElementById('auth-link')

const sessions = new Map()
let currentSessionId = null
let awaitingAuth = false

const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
const ws = new WebSocket(`${wsProtocol}//${window.location.host}/api/session/stream`)

const URL_PATTERN = /https?:\/\/\S+/
const CODE_PATTERN = /\b[A-Za-z0-9-]{6,12}\b/

function setStatus(text) {
  statusBar.textContent = `Status: ${text}`
}

// The PTY is spawned at a fixed size before the browser has ever reported
// its own (see src/sessionManager.js), so the CLI's full-screen TUI starts
// out positioning its cursor for a terminal width that doesn't match what
// xterm.js actually renders — the result is garbled, wrapped-wrong output
// until the server is told the real size.
function fitAndNotify() {
  fitAddon.fit()
  if (currentSessionId && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'resize', sessionId: currentSessionId, cols: term.cols, rows: term.rows }))
  }
}

new ResizeObserver(fitAndNotify).observe(document.getElementById('terminal'))
ws.addEventListener('open', fitAndNotify)

function selectSession(sessionId) {
  currentSessionId = sessionId
  term.clear()
  awaitingAuth = false
  authLink.hidden = true
  setStatus('unknown')
  fitAndNotify()
}

function renderSessionList() {
  sessionList.innerHTML = ''
  for (const sessionId of sessions.keys()) {
    const li = document.createElement('li')
    li.textContent = sessionId
    li.addEventListener('click', () => selectSession(sessionId))
    sessionList.appendChild(li)
  }
}

// The dashboard only ever talks to sessions the backend already knows
// about (WS input for an unknown sessionId gets an error frame). This
// debug terminal drives its own PTY session directly via POST
// /api/sessions, independent of /v1/chat/completions' own per-turn
// session bookkeeping — the two are unrelated sessions by design, so a
// sessionId used here is not implicitly usable as a chat-completions
// sessionId, and vice versa.
async function ensureBackendSession(sessionId, projectPath) {
  try {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, projectPath }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      return { ok: false, message: body?.error?.message ?? `request failed (${res.status})` }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, message: err.message }
  }
}

addSessionForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  const sessionId = sessionIdInput.value.trim()
  const projectPath = projectPathInput.value.trim()
  if (!sessionId || !projectPath) return
  sessionIdInput.value = ''
  projectPathInput.value = ''

  // The debug terminal has nothing to attach to until the backend PTY
  // session actually exists, so wait for that before selecting it (or
  // showing it in the list at all, if it was rejected).
  const result = await ensureBackendSession(sessionId, projectPath)
  if (!result.ok) {
    setStatus(`failed to add session: ${result.message}`)
    return
  }
  sessions.set(sessionId, { projectPath })
  renderSessionList()
  selectSession(sessionId)
})

authButton.addEventListener('click', () => {
  if (!currentSessionId || ws.readyState !== WebSocket.OPEN) return
  ws.send(JSON.stringify({ type: 'input', sessionId: currentSessionId, data: '/login\r' }))
})

// The debug console is interactive per PRD §3 Component B ("for manual
// intervention if the agent gets stuck") — keystrokes typed into it go to
// the selected session's PTY. Terminals submit on \r (carriage return),
// not \n.
term.onData((data) => {
  if (!currentSessionId || ws.readyState !== WebSocket.OPEN) return
  ws.send(JSON.stringify({ type: 'input', sessionId: currentSessionId, data }))
})

ws.addEventListener('message', (event) => {
  const frame = JSON.parse(event.data)
  if (frame.sessionId !== currentSessionId) return

  if (frame.type === 'output') {
    term.write(frame.data)

    const urlMatch = frame.data.match(URL_PATTERN)
    const codeMatch = frame.data.match(CODE_PATTERN)
    if (urlMatch && codeMatch) {
      awaitingAuth = true
      authLink.hidden = false
      authLink.replaceChildren()
      const a = document.createElement('a')
      a.href = urlMatch[0]
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
      a.textContent = `${urlMatch[0]} (code: ${codeMatch[0]})`
      authLink.appendChild(a)
      setStatus('requires interaction')
    } else if (awaitingAuth) {
      awaitingAuth = false
      authLink.hidden = true
      setStatus('authenticated')
    }
  } else if (frame.type === 'error') {
    term.write(`\r\n[error] ${frame.data}\r\n`)
  }
})
