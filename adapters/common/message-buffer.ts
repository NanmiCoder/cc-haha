/**
 * Streaming message buffer
 *
 * Accumulates content_delta and flushes in batches by time window or character count.
 * Used for Telegram editMessage / Feishu streaming card updates.
 */

export type FlushCallback = (text: string, isComplete: boolean) => void | Promise<void>

const DEFAULT_INTERVAL_MS = 500
const DEFAULT_CHAR_THRESHOLD = 200

export class MessageBuffer {
  private buffer = ''
  private timer: ReturnType<typeof setTimeout> | null = null
  private flushing = false
  private pendingComplete = false
  private activeFlush: Promise<void> | null = null

  constructor(
    private onFlush: FlushCallback,
    private intervalMs = DEFAULT_INTERVAL_MS,
    private charThreshold = DEFAULT_CHAR_THRESHOLD,
  ) {}

  /** Append text delta. Triggers flush if threshold reached. */
  append(text: string): void {
    this.buffer += text
    if (this.buffer.length >= this.charThreshold) {
      this.scheduleFlush()
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(false), this.intervalMs)
    }
  }

  /** Immediately flush all remaining content (called on message_complete). */
  async complete(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.flushing) {
      // A flush is in-flight; mark pending so it fires after current flush finishes
      this.pendingComplete = true
      await this.activeFlush
      return
    }
    await this.flush(true)
  }

  /** Reset the buffer for a new message. */
  reset(): void {
    this.buffer = ''
    this.pendingComplete = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private scheduleFlush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    queueMicrotask(() => this.flush(false))
  }

  private async flush(isComplete: boolean): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.flushing) {
      await this.activeFlush
      return
    }
    if (this.buffer.length === 0) return

    this.flushing = true
    const text = this.buffer
    this.buffer = ''
    this.activeFlush = (async () => {
      try {
        await this.onFlush(text, isComplete)
      } catch (err) {
        console.error('[MessageBuffer] Flush error:', err)
      } finally {
        this.flushing = false
        this.activeFlush = null
        // If complete() was called while we were flushing, do the final flush now.
        if (this.pendingComplete) {
          this.pendingComplete = false
          await this.flush(true)
        }
      }
    })()
    await this.activeFlush
  }
}
