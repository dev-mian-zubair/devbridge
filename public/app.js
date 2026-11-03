const statusBar = document.getElementById('status-bar')
const projectTree = document.getElementById('project-tree')
const sessionDetail = document.getElementById('session-detail')
const signInButton = document.getElementById('sign-in-button')

const loginOverlay = document.getElementById('login-overlay')
const loginStatus = document.getElementById('login-status')
const loginLinkArea = document.getElementById('login-link-area')
const loginUrlLink = document.getElementById('login-url-link')
const loginRawOutput = document.getElementById('login-raw-output')
const loginInputField = document.getElementById('login-input-field')
const loginSendButton = document.getElementById('login-send-button')
const loginSignedInButton = document.getElementById('login-signed-in-button')
const loginCancelButton = document.getElementById('login-cancel-button')

// Sessions only ever appear here because the API (/v1/chat/completions)
// created them — there is no "add session" affordance any more. This map
// is rebuilt from the server's snapshot on connect and kept in sync by
// session:update events; it is purely a read-only observability view.
const sessionsById = new Map()
const liveOutputBySession = new Map()
let selectedSessionId = null

const URL_PATTERN = /https?:\/\/\S+/
const CODE_PATTERN = /\b[A-Za-z0-9-]{6,12}\b/
let loginAwaitingAuth = false
let loginOutputBuffer = ''

const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
const ws = new WebSocket(`${wsProtocol}//${window.location.host}/api/session/stream`)

function setStatus(text) {
  statusBar.textContent = `Status: ${text}`
}

function escapeHtml(text) {
  const div = document.createElement('div')
  div.textContent = text ?? ''
  return div.innerHTML
}

function renderProjectTree() {
  projectTree.innerHTML = ''

  if (sessionsById.size === 0) {
    const empty = document.createElement('p')
    empty.className = 'empty'
    empty.textContent = 'No sessions yet — they appear here once a request comes in through the API.'
    projectTree.appendChild(empty)
    return
  }

  const byProject = new Map()
  for (const session of sessionsById.values()) {
    const list = byProject.get(session.projectPath) ?? []
    list.push(session)
    byProject.set(session.projectPath, list)
  }

  for (const [projectPath, sessions] of byProject) {
    const group = document.createElement('div')
    group.className = 'project-group'

    const heading = document.createElement('div')
    heading.className = 'project-path'
    heading.textContent = projectPath
    group.appendChild(heading)

    const list = document.createElement('ul')
    for (const session of sessions.sort((a, b) => a.sessionId.localeCompare(b.sessionId))) {
      const li = document.createElement('li')
      li.className = `session-row status-${session.status}${session.sessionId === selectedSessionId ? ' selected' : ''}`
      li.textContent = `${session.sessionId} · ${session.status}`
      li.addEventListener('click', () => selectSession(session.sessionId))
      list.appendChild(li)
    }
    group.appendChild(list)
    projectTree.appendChild(group)
  }
}

function selectSession(sessionId) {
  selectedSessionId = sessionId
  renderProjectTree()
  renderSessionDetail()
}

function renderSessionDetail() {
  const session = sessionsById.get(selectedSessionId)
  if (!session) {
    sessionDetail.innerHTML = '<p class="empty">Select a session to view its activity.</p>'
    return
  }

  const live = liveOutputBySession.get(selectedSessionId) ?? ''
  const { lastRequest, lastResult, lastError } = session

  sessionDetail.innerHTML = `
    <h2>${escapeHtml(session.sessionId)}</h2>
    <p class="project-path">${escapeHtml(session.projectPath)}</p>
    <p class="status-badge status-${session.status}">${session.status}</p>
    ${lastRequest ? `
      <section>
        <h3>Request</h3>
        <p>model: ${escapeHtml(lastRequest.model ?? 'default')}</p>
        <p>messages: ${lastRequest.messageCount}</p>
        <p>last message: ${escapeHtml(lastRequest.lastUserMessage ?? '')}</p>
      </section>` : ''}
    ${session.status === 'running' ? `
      <section>
        <h3>Live output</h3>
        <pre class="live-output">${escapeHtml(live)}</pre>
      </section>` : ''}
    ${lastResult ? `
      <section>
        <h3>Last result</h3>
        <pre>${escapeHtml(lastResult.content ?? '')}</pre>
        <p>finish_reason: ${escapeHtml(lastResult.finishReason ?? '')}</p>
        <p>tokens: ${lastResult.usage?.total_tokens ?? '?'}</p>
      </section>` : ''}
    ${lastError ? `
      <section class="error">
        <h3>Last error</h3>
        <p>${escapeHtml(lastError.message ?? '')}</p>
      </section>` : ''}
  `
}

ws.addEventListener('open', () => setStatus('connected'))
ws.addEventListener('close', () => setStatus('disconnected'))

ws.addEventListener('message', (event) => {
  const frame = JSON.parse(event.data)

  if (frame.type === 'snapshot') {
    sessionsById.clear()
    for (const session of frame.sessions) sessionsById.set(session.sessionId, session)
    renderProjectTree()
    renderSessionDetail()
    return
  }

  if (frame.type === 'session:update') {
    sessionsById.set(frame.session.sessionId, frame.session)
    // A fresh turn starting clears the previous turn's accumulated live
    // output so it doesn't get appended to by mistake.
    if (frame.session.status === 'running') liveOutputBySession.set(frame.session.sessionId, '')
    renderProjectTree()
    if (frame.session.sessionId === selectedSessionId) renderSessionDetail()
    return
  }

  if (frame.type === 'session:delta') {
    const current = liveOutputBySession.get(frame.sessionId) ?? ''
    liveOutputBySession.set(frame.sessionId, current + frame.text)
    if (frame.sessionId === selectedSessionId) renderSessionDetail()
    return
  }

  if (frame.type === 'login:output') {
    handleLoginOutput(frame.data)
    return
  }

  if (frame.type === 'error') {
    setStatus(`error: ${frame.data}`)
  }
})

function openLoginOverlay() {
  loginOverlay.hidden = false
  loginStatus.textContent = 'Starting…'
  loginLinkArea.hidden = true
  loginRawOutput.textContent = ''
  loginOutputBuffer = ''
  loginAwaitingAuth = false
  loginInputField.value = ''
  loginInputField.focus()
}

function closeLoginOverlay() {
  loginOverlay.hidden = true
}

function completeLogin(statusText) {
  loginStatus.textContent = statusText
  ws.send(JSON.stringify({ type: 'login:complete' }))
  setTimeout(closeLoginOverlay, 1500)
}

function sendLoginInput() {
  const value = loginInputField.value
  if (!value) return
  ws.send(JSON.stringify({ type: 'login:input', data: `${value}\r` }))
  loginInputField.value = ''
}

// The CLI's /login flow isn't always just "a URL and code to open" — it
// can start with a method-selection menu, or other prompts, before (or
// instead of) ever showing one. The input row above is always available so
// the user can answer whatever's actually being asked; this just surfaces
// a URL+code pair prominently as a convenience when one appears, and
// offers to auto-complete once further output follows it (the same
// heuristic the old debug terminal used) — "I'm signed in" below covers
// the case where that heuristic doesn't fire.
function handleLoginOutput(chunk) {
  loginOutputBuffer += chunk
  loginRawOutput.textContent = loginOutputBuffer
  loginRawOutput.scrollTop = loginRawOutput.scrollHeight

  const urlMatch = chunk.match(URL_PATTERN)
  const codeMatch = chunk.match(CODE_PATTERN)
  if (urlMatch && codeMatch) {
    loginAwaitingAuth = true
    loginStatus.textContent = 'Open this link and authorize, then respond below if asked.'
    loginUrlLink.href = urlMatch[0]
    loginUrlLink.textContent = `${urlMatch[0]} (code: ${codeMatch[0]})`
    loginLinkArea.hidden = false
  } else if (loginAwaitingAuth) {
    loginAwaitingAuth = false
    completeLogin('Signed in.')
  }
}

signInButton.addEventListener('click', () => {
  openLoginOverlay()
  ws.send(JSON.stringify({ type: 'login:start' }))
})

loginSendButton.addEventListener('click', sendLoginInput)
loginInputField.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') sendLoginInput()
})

loginSignedInButton.addEventListener('click', () => {
  completeLogin('Signed in.')
})

loginCancelButton.addEventListener('click', () => {
  closeLoginOverlay()
})
