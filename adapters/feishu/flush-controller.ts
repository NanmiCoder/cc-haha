/**
 * Generic flush scheduler with throttling + mutex + conflict re-flush
 *
 * This is a pure scheduling primitive —— no business logic (sending cards, building markdown, etc.).
 * The actual flush work is done by the doFlush callback injected via the constructor.
 *
 * Semantics:
 *   - throttledUpdate(throttleMs) is triggered by streaming data and throttled per window
 *   - flush() is mutex-protected; only one runs at a time
 *   - New data arriving during a flush marks needsReflush; a follow-up flush runs right after the API call
 *   - The first flush after a long gap (> 2000ms) is delayed 300ms to batch, avoiding jitter
 *   - After complete(), all new flushes are rejected
 *
 * Reference implementation: openclaw-lark/src/card/flush-controller.ts
 */

// ---------------------------------------------------------------------------
// Throttle constants
// ---------------------------------------------------------------------------

export const THROTTLE = {
  /** Minimum interval for CardKit cardElement.content() —— designed for streaming, can be high-frequency */
  CARDKIT_MS: 100,
  /** Minimum interval for im.message.patch —— strict rate limit (230020) */
  PATCH_MS: 1500,
  /** Long-gap threshold. elapsed > 2000ms triggers batch mode */
  LONG_GAP_THRESHOLD_MS: 2000,
  /** Extra delay for the first frame after a long gap, so more text accumulates */
  BATCH_AFTER_GAP_MS: 300,
} as const

// ---------------------------------------------------------------------------
// FlushController
// ---------------------------------------------------------------------------

export class FlushController {
  private flushInProgress = false
  private flushResolvers: Array<() => void> = []
  private needsReflush = false
  private pendingFlushTimer: ReturnType<typeof setTimeout> | null = null
  private lastUpdateTime = 0
  private isCompleted = false
  private _cardMessageReady = false

  constructor(private readonly doFlush: () => Promise<void>) {}

  /** Mark complete —— no new flushes accepted after the current one finishes. */
  complete(): void {
    this.isCompleted = true
  }

  /** Cancel any pending delayed flush timer. */
  cancelPendingFlush(): void {
    if (this.pendingFlushTimer) {
      clearTimeout(this.pendingFlushTimer)
      this.pendingFlushTimer = null
    }
  }

  /** Wait for the currently running flush to finish. Returns immediately if none is running. */
  waitForFlush(): Promise<void> {
    if (!this.flushInProgress) return Promise.resolve()
    return new Promise<void>((resolve) => this.flushResolvers.push(resolve))
  }

  /**
   * Mark whether the card message was sent successfully; decides whether flushes are allowed.
   *
   * The first time it becomes true, lastUpdateTime is updated synchronously so the first throttledUpdate
   * sees a small elapsed, matching openclaw's "flush right after card creation" behavior.
   */
  setCardMessageReady(ready: boolean): void {
    this._cardMessageReady = ready
    if (ready) this.lastUpdateTime = Date.now()
  }

  cardMessageReady(): boolean {
    return this._cardMessageReady
  }

  /**
   * Run one flush (mutex-protected + conflict re-flush).
   *
   * If a flush is already running, set needsReflush; another flush runs automatically after the current one.
   */
  async flush(): Promise<void> {
    if (!this.cardMessageReady() || this.flushInProgress || this.isCompleted) {
      if (this.flushInProgress && !this.isCompleted) this.needsReflush = true
      return
    }
    this.flushInProgress = true
    this.needsReflush = false
    // Update the timestamp **before** the API call so concurrent callers don't also enter flush
    this.lastUpdateTime = Date.now()
    try {
      await this.doFlush()
      this.lastUpdateTime = Date.now()
    } finally {
      this.flushInProgress = false
      const resolvers = this.flushResolvers
      this.flushResolvers = []
      for (const resolve of resolvers) resolve()

      // If new events arrived during the API call, flush again immediately
      if (this.needsReflush && !this.isCompleted && !this.pendingFlushTimer) {
        this.needsReflush = false
        this.pendingFlushTimer = setTimeout(() => {
          this.pendingFlushTimer = null
          void this.flush()
        }, 0)
      }
    }
  }

  /**
   * Throttled update entry point.
   *
   * @param throttleMs - minimum flush interval. CardKit passes THROTTLE.CARDKIT_MS,
   *   the Patch fallback path passes THROTTLE.PATCH_MS.
   */
  async throttledUpdate(throttleMs: number): Promise<void> {
    if (!this.cardMessageReady()) return

    const now = Date.now()
    const elapsed = now - this.lastUpdateTime

    if (elapsed >= throttleMs) {
      this.cancelPendingFlush()
      if (elapsed > THROTTLE.LONG_GAP_THRESHOLD_MS) {
        // Long-gap batch mode: delay the first frame after a tool call / reasoning by 300ms
        // so more text accumulates instead of showing only a character or two
        this.lastUpdateTime = now
        this.pendingFlushTimer = setTimeout(() => {
          this.pendingFlushTimer = null
          void this.flush()
        }, THROTTLE.BATCH_AFTER_GAP_MS)
      } else {
        await this.flush()
      }
    } else if (!this.pendingFlushTimer) {
      // Within the throttle window —— delay until the window ends, then flush
      const delay = throttleMs - elapsed
      this.pendingFlushTimer = setTimeout(() => {
        this.pendingFlushTimer = null
        void this.flush()
      }, delay)
    }
  }
}
