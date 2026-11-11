export type WechatTextBufferOptions = {
  intervalMs?: number
  charThreshold?: number
  maxBytes?: number
  onError?: (error: unknown, phase: 'stage' | 'send' | 'overflow') => void
}

/** Persist synchronously before releasing text. Sending may fail only after the
 * journal owns the payload, so network uncertainty must not requeue it here. */
export class WechatTextBuffer {
  private buffer = ''
  private timer: ReturnType<typeof setTimeout> | undefined
  private microtaskScheduled = false
  private active: Promise<void> | undefined
  private completeRequested = false
  private disposed = false
  private readonly intervalMs: number
  private readonly charThreshold: number
  private readonly maxBytes: number

  constructor(private readonly stage: (text: string) => () => Promise<void>, private readonly options: WechatTextBufferOptions = {}) {
    this.intervalMs = options.intervalMs ?? 3000
    this.charThreshold = options.charThreshold ?? 200
    this.maxBytes = options.maxBytes ?? 128 * 1024
  }

  append(text: string): void {
    if (this.disposed || !text) return
    if (Buffer.byteLength(this.buffer) + Buffer.byteLength(text) > this.maxBytes) {
      const error = new Error('WeChat unsaved text buffer is full; stop generation and inspect the desktop result')
      this.report(error, 'overflow')
      throw error
    }
    this.buffer += text
    if (this.buffer.length >= this.charThreshold) {
      this.clearTimer()
      if (!this.microtaskScheduled) {
        this.microtaskScheduled = true
        queueMicrotask(() => {
          this.microtaskScheduled = false
          if (!this.disposed) void this.flush().catch(() => {})
        })
      }
    } else if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = undefined; void this.flush().catch(() => {}) }, this.intervalMs)
    }
  }

  async complete(): Promise<void> {
    if (this.disposed) return
    this.clearTimer()
    if (this.active) {
      this.completeRequested = true
      await this.active
      return
    }
    await this.flush()
  }

  reset(): void {
    this.buffer = ''
    this.completeRequested = false
    this.clearTimer()
  }

  dispose(): void { this.reset(); this.disposed = true }

  private async flush(): Promise<void> {
    this.clearTimer()
    if (this.disposed || !this.buffer) return
    if (this.active) {
      // The in-flight flush schedules the remaining buffer after it settles.
      return
    }
    let send: () => Promise<void>
    try {
      send = this.stage(this.buffer)
    } catch (error) {
      this.report(error, 'stage')
      // Keep the exact text and do not create a retry timer. A new append or an
      // explicit complete() can retry staging once storage becomes available.
      throw error
    }
    this.buffer = ''
    this.active = Promise.resolve().then(send).catch(error => this.report(error, 'send')).then(async () => {
      this.active = undefined
      if (this.disposed) return
      if (this.completeRequested) {
        this.completeRequested = false
        await this.flush()
      } else if (this.buffer && !this.timer) {
        this.timer = setTimeout(() => { this.timer = undefined; void this.flush().catch(() => {}) }, this.intervalMs)
      }
    })
    await this.active
  }

  private report(error: unknown, phase: 'stage' | 'send' | 'overflow'): void {
    try { this.options.onError?.(error, phase) } catch { /* Reporting must not change ownership of buffered text. */ }
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }
}
