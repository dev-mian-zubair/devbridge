export function withTimeout(promise, onTimeout, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        onTimeout()
      } catch {
        // A misbehaving callback must never stop the timeout from rejecting.
      }
      reject(new Error('timeout'))
    }, timeoutMs)

    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}
