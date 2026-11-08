/**
 * 会话连接和电脑重新对齐的这段时间里，首页轮询、通知登记这类不急的请求先让一让：
 * 公网隧道又慢又窄，回到前台时它们会和聊天的历史、套接字一起挤在同一条链路上。
 * 让路有上限，连接一直对不齐（电脑睡着了）也不会把它们永久卡住。
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

  /** 占住闸门，返回释放函数；重复释放无副作用。 */
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

  /** 没人占用时立即放行，否则等到释放或 `maxMs` 到点，以先到者为准。 */
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
