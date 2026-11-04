import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

// A single-slot PTY session dedicated to the CLI's own `/login`
// device-code flow. Unlike the old generic per-project debug terminal this
// replaces, login isn't scoped to a project — there's exactly one of these
// at a time, reused across start() calls while active, and garbage
// collected (see createLoginSession's gcTimeoutMs) rather than left to run
// forever once the manual "add session" form that used to own cleanup is
// gone.
function spawnEnv() {
  const { ANTHROPIC_API_KEY, ...rest } = process.env
  return rest
}

// node-pty.write()ing a freshly-spawned claude CLI races its own startup:
// until the CLI finishes initializing and puts the PTY into raw mode, an
// early write (including the Enter keypress) can be swallowed by the
// kernel's line-discipline echo instead of being read as real input once
// the CLI's own input handler comes up. Entering the alternate screen
// buffer (`CSI ? 1049 h`) is the one escape sequence the CLI only emits
// once its full-screen UI has actually initialized, so readiness is "that
// sequence appeared, then output went quiet for a short settle window."
const READY_MARKER = '\u001b[?1049h'

function waitForReadiness(pty, { timeoutMs, settleMs }) {
  return new Promise((resolve) => {
    let disposable
    let settleTimer = null
    let timeoutTimer = null

    const finish = () => {
      clearTimeout(settleTimer)
      clearTimeout(timeoutTimer)
      disposable?.dispose?.()
      resolve()
    }

    timeoutTimer = setTimeout(finish, timeoutMs)
    disposable = pty.onData((chunk) => {
      if (chunk.includes(READY_MARKER)) {
        clearTimeout(settleTimer)
        settleTimer = setTimeout(finish, settleMs)
      }
    })
  })
}

// --dangerously-skip-permissions would otherwise be the obvious way to
// bypass this, but the CLI refuses it outright when running as root — and
// this container always does. Writing hasTrustDialogAccepted directly is
// the same effect, through the same field the CLI itself sets when a human
// accepts the dialog interactively, scoped to only the one directory this
// session ever runs in. Best-effort: a container that has never
// authenticated yet has no .claude.json to update, and that's fine — it's
// not this function's job to create one.
function ensureCwdTrusted(claudeConfigDir, cwd, { readFileSync, writeFileSync }) {
  if (!claudeConfigDir) return
  const configPath = path.join(claudeConfigDir, '.claude.json')

  let config
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch {
    return
  }

  config.projects ??= {}
  if (config.projects[cwd]?.hasTrustDialogAccepted) return
  config.projects[cwd] = { ...config.projects[cwd], hasTrustDialogAccepted: true }

  try {
    writeFileSync(configPath, JSON.stringify(config, null, 2))
  } catch {
    // Best-effort — if this fails, /login will hit the trust dialog and
    // time out at the readiness check instead of hanging indefinitely.
  }
}

// The inverse of ensureCwdTrusted, run whenever a login directory is torn
// down: a trust entry for a directory that no longer exists is pure
// clutter (and, if that random path were ever reused, stale permission —
// so it's removed outright rather than left behind).
function removeCwdTrust(claudeConfigDir, cwd, { readFileSync, writeFileSync }) {
  if (!claudeConfigDir) return
  const configPath = path.join(claudeConfigDir, '.claude.json')

  let config
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch {
    return
  }
  if (!config.projects?.[cwd]) return
  delete config.projects[cwd]

  try {
    writeFileSync(configPath, JSON.stringify(config, null, 2))
  } catch {
    // Best-effort cleanup — a leftover entry for a now-deleted directory
    // is inert, never a directory anything will run in again.
  }
}

export function createLoginSession(
  spawnFn,
  {
    readinessTimeoutMs = 5000,
    readinessSettleMs = 250,
    gcTimeoutMs = 5 * 60 * 1000,
    disconnectGraceMs = 15 * 1000,
    claudeConfigDir,
    readFileSync = fs.readFileSync,
    writeFileSync = fs.writeFileSync,
    mkdtempSync = fs.mkdtempSync,
    chmodSync = fs.chmodSync,
    rmSync = fs.rmSync,
  } = {}
) {
  let active = null

  function cleanup(current) {
    clearTimeout(current.gcTimer)
    clearTimeout(current.graceTimer)
    removeCwdTrust(claudeConfigDir, current.loginCwd, { readFileSync, writeFileSync })
    try {
      rmSync(current.loginCwd, { recursive: true, force: true })
    } catch {
      // Best-effort — an orphaned empty temp directory is harmless.
    }
  }

  function dispose() {
    if (!active) return
    const current = active
    active = null
    cleanup(current)
    try {
      current.pty.kill()
    } catch {
      // Already gone; nothing left to kill.
    }
  }

  return {
    async start(onOutput) {
      if (active) {
        if (onOutput) active.listeners.add(onOutput)
        // A reconnect (page reload, a second tab) attaching before the
        // disconnect grace period (see detach()) elapses means the session
        // isn't actually abandoned — cancel the pending teardown.
        clearTimeout(active.graceTimer)
        active.graceTimer = null
        return
      }

      // An interactive session (unlike the chat-completions path's `-p`
      // turns, which the CLI's own docs say skip this) hits the workspace
      // trust dialog on its cwd, which the server has no way to answer
      // interactively — see ensureCwdTrusted above. The cwd is a freshly
      // created, mode-0700 directory private to this one session — never
      // os.tmpdir() itself, which is shared and world-writable, so
      // pre-trusting it would let anything else that can write there plant
      // a .claude/.mcp.json the login PTY would then load.
      const loginCwd = mkdtempSync(path.join(os.tmpdir(), 'devbridge-login-'))
      chmodSync(loginCwd, 0o700)
      ensureCwdTrusted(claudeConfigDir, loginCwd, { readFileSync, writeFileSync })
      const pty = spawnFn('claude', [], {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: loginCwd,
        env: spawnEnv(),
      })
      const listeners = new Set(onOutput ? [onOutput] : [])
      const current = { pty, listeners, loginCwd, gcTimer: null, graceTimer: null }
      active = current

      pty.onExit(() => {
        if (active === current) {
          active = null
          cleanup(current)
        }
      })
      pty.onData((chunk) => {
        // One listener's callback throwing (e.g. ws.send() on a socket that
        // has since closed) must not stop delivery to the others, and must
        // not escape into node-pty's own event dispatch — same reasoning as
        // turnEvents.js's subscribe().
        for (const listener of listeners) {
          try {
            listener(chunk)
          } catch {
            // Dropped — that listener's connection is no longer reachable.
          }
        }
      })

      current.gcTimer = setTimeout(dispose, gcTimeoutMs)
      current.gcTimer.unref?.()

      await waitForReadiness(pty, { timeoutMs: readinessTimeoutMs, settleMs: readinessSettleMs })
      pty.write('/login\r')
    },
    input(data) {
      active?.pty.write(data)
    },
    // Called when one connection that was watching this session goes away
    // (its WS closed). Neither extreme is right: disposing the instant any
    // one connection drops killed a real, already-succeeded login when its
    // one watching tab closed (see sessionStream.js); never disposing on
    // disconnect leaves a truly abandoned session alive — and attachable by
    // a different connection — for the full gcTimeoutMs. A short grace
    // period threads the needle: start() (a reload, a second tab) cancels
    // it, so only genuine abandonment reaches it.
    detach(onOutput) {
      if (!active) return
      const current = active
      current.listeners.delete(onOutput)
      if (current.listeners.size > 0 || current.graceTimer) return
      current.graceTimer = setTimeout(() => {
        if (active === current) dispose()
      }, disconnectGraceMs)
      current.graceTimer.unref?.()
    },
    dispose,
    isActive() {
      return active !== null
    },
  }
}
