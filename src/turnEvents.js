import { EventEmitter } from 'node:events'

// A small pub/sub bus decoupling the chat-completions route and
// turnSessions (publishers of turn/session lifecycle data) from the
// dashboard's WS connections (subscribers) — neither side needs to know
// the other exists.
export function createTurnEvents() {
  const emitter = new EventEmitter()

  // A WS connection's own listener failing (a bad send on a half-closed
  // socket, say) must never stop a live turn's event from reaching every
  // other dashboard connection — each listener gets its own try/catch
  // rather than relying on EventEmitter's default behavior, which aborts
  // the rest of the listener list on the first throw.
  function wrapped(listener) {
    return (message) => {
      try {
        listener(message)
      } catch {
        // Isolated: a broken subscriber doesn't take down the others.
      }
    }
  }

  return {
    publish(message) {
      emitter.emit('message', message)
    },
    subscribe(listener) {
      const fn = wrapped(listener)
      emitter.on('message', fn)
      return () => emitter.off('message', fn)
    },
  }
}
