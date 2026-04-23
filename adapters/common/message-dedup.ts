/**
 * 消息去重
 *
 * 防止 WebSocket 重连等场景下消息重复处理。
 * 参考 openclaw-lark dedup.ts 的 Map + TTL + 容量 设计。
 */

const DEFAULT_TTL_MS = 10 * 60_000  // 10 minutes
const DEFAULT_MAX_ENTRIES = 5000
const SWEEP_INTERVAL_MS = 60_000    // 1 minute

export class MessageDedup {
  private store = new Map<string, number>()
  private sweepTimer: ReturnType<typeof setInterval>

  constructor(
    private ttlMs = DEFAULT_TTL_MS,
    private maxEntries = DEFAULT_MAX_ENTRIES,
  ) {
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS)
  }

  /** Returns true if this is a NEW message, false if duplicate. */
  tryRecord(id: string): boolean {
    const now = Date.now()
    const existing = this.store.get(id)

    if (existing !== undefined && now - existing < this.ttlMs) {
      return false // duplicate
    }

    // Evict oldest if at capacity
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value
      if (oldest !== undefined) this.store.delete(oldest)
    }

    this.store.set(id, now)
    return true
  }

  private sweep(): void {
    const now = Date.now()
    for (const [key, ts] of this.store) {
      if (now - ts >= this.ttlMs) {
        this.store.delete(key)
      } else {
        break // Map preserves insertion order; once fresh, rest is fresh
      }
    }
  }

  destroy(): void {
    clearInterval(this.sweepTimer)
    this.store.clear()
  }
}
