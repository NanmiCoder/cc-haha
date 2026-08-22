export class StreamToolInputDurationGuard {
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>()

  constructor(
    private readonly options: {
      enabled: boolean
      timeoutMs: number
      onTimeout: (index: number) => void
    },
  ) {}

  start(index: number): void {
    this.stop(index)
    if (!this.options.enabled || this.options.timeoutMs <= 0) return
    this.timers.set(index, setTimeout(() => {
      this.timers.delete(index)
      this.options.onTimeout(index)
    }, this.options.timeoutMs))
  }

  stop(index: number): void {
    const timer = this.timers.get(index)
    if (timer === undefined) return
    clearTimeout(timer)
    this.timers.delete(index)
  }

  clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }
}
