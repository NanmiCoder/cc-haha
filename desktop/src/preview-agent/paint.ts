/** Bounds the wait: a guest that is not on screen never runs animation frames. */
const PAINT_TIMEOUT_MS = 250

/**
 * Resolves once the page has drawn a frame with its current DOM. The second
 * animation frame only runs after the first has been produced, so a native
 * `capturePage` that copies the guest's latest frame sees every change made
 * before this call — a <webview> guest does not repaint on its own before
 * being captured, and the copy would otherwise still show a closed edit bubble.
 */
export function afterNextPaint(timeoutMs = PAINT_TIMEOUT_MS): Promise<void> {
  return new Promise(resolve => {
    const timer = window.setTimeout(resolve, timeoutMs)
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      window.clearTimeout(timer)
      resolve()
    }))
  })
}
