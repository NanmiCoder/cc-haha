/**
 * While the session connection is resyncing with the computer, non-urgent requests like home polling and notification registration yield: 
 * The public tunnel is slow and narrow; on returning to foreground they would crowd the same link with chat history and sockets.
 * Yielding is capped, so a connection that never resyncs (computer asleep) cannot block them forever.
 */
export type GateTimers = {
  set(callback: () => void, delay: number): unknown
  clear(handle: unknown): void
}
const defaultTimers: GateTimers = {
  set: (callback, delay) => setTimeout(callback, delay),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export class ForegroundGate {
  #holds = new Set<symbol>()
  #waiters = new Set<() => void>()
  constructor(private timers: GateTimers = defaultTimers) {}

  get busy() {
    return this.#holds.size > 0
  }

  /** Hold the gate and return a release function; releasing twice has no side effect. */
  hold(): () => void {
    const token = Symbol('hold')
    this.#holds.add(token)
    return () => {
      if (!this.#holds.delete(token) || this.#holds.size) return
      const waiters = [...this.#waiters]
      this.#waiters.clear()
      for (const wake of waiters) wake()
    }
  }

  /** Pass immediately when nobody holds it, otherwise wait until released or `maxMs` elapses, whichever comes first. */
  whenIdle(maxMs: number): Promise<void> {
    if (!this.#holds.size) return Promise.resolve()
    return new Promise((resolve) => {
      const wake = () => {
        this.timers.clear(timer)
        this.#waiters.delete(wake)
        resolve()
      }
      const timer = this.timers.set(wake, maxMs)
      this.#waiters.add(wake)
    })
  }
}

export const foregroundGate = new ForegroundGate()
