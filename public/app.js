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

addSessionForm.addEventListener('submit', (event) => {
  event.preventDefault()
  const sessionId = sessionIdInput.value.trim()
  const projectPath = projectPathInput.value.trim()
  if (!sessionId || !projectPath) return
  sessions.set(sessionId, { projectPath })
  renderSessionList()
  selectSession(sessionId)
  sessionIdInput.value = ''
  projectPathInput.value = ''
})

authButton.addEventListener('click', () => {
  if (!currentSessionId) return
  ws.send(JSON.stringify({ type: 'input', sessionId: currentSessionId, data: '/login\n' }))
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
