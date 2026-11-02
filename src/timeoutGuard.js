export function withTimeout(promise, pty, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pty.write('\x03')
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
