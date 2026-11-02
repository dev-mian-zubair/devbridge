const term = new window.Terminal()
term.open(document.getElementById('terminal'))

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

function selectSession(sessionId) {
  currentSessionId = sessionId
  term.clear()
  awaitingAuth = false
  authLink.hidden = true
  setStatus('unknown')
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
// about (WS input for an unknown sessionId gets an error frame). A session
// is created server-side by sessionManager.getOrCreate, which only runs
// inside the chat-completions route — so adding a session here fires a
// fire-and-forget bootstrap request with empty content (just an Enter
// keypress) to spin up its PTY before the operator starts typing into the
// debug console.
async function ensureBackendSession(sessionId, projectPath) {
  try {
    await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, projectPath, messages: [{ role: 'user', content: '' }] }),
    })
  } catch (err) {
    console.error('Failed to create session', sessionId, err)
  }
}

addSessionForm.addEventListener('submit', (event) => {
  event.preventDefault()
  const sessionId = sessionIdInput.value.trim()
  const projectPath = projectPathInput.value.trim()
  if (!sessionId || !projectPath) return
  sessions.set(sessionId, { projectPath })
  renderSessionList()
  selectSession(sessionId)
  ensureBackendSession(sessionId, projectPath)
  sessionIdInput.value = ''
  projectPathInput.value = ''
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
