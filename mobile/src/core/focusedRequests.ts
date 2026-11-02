export type FocusedRequest = { signal: AbortSignal; isCurrent(): boolean }

/** A request may update the UI only within the focus period that started it. */
export class FocusedRequests {
  private focused = false
  private current?: AbortController

  focus() {
    this.invalidate()
    this.focused = true
  }

  blur() {
    this.focused = false
    this.invalidate()
  }

  invalidate() {
    this.current?.abort()
    this.current = undefined
  }

  begin(): FocusedRequest | null {
    if (!this.focused) return null
    this.invalidate()
    const controller = new AbortController()
    this.current = controller
    return {
      signal: controller.signal,
      isCurrent: () =>
        this.focused &&
        this.current === controller &&
        !controller.signal.aborted,
    }
  }
}
