/**
 * Tracks the span over which a single API response was emitting tokens.
 *
 * Tokens/sec is only meaningful as `output_tokens / decode_ms` when the denominator excludes the
 * prefill wait and every tool round-trip. So the span opens at the first *generated* delta rather
 * than at request start, and it closes when the stream terminates — the same measurement the
 * session projections make host-side in DeepSeek Harness.
 *
 * A stream that ends without `message_stop` reports 0, meaning "unknown", not "instant": the
 * response was truncated, and a partial span would both understate the rate the model was
 * actually running at and invite a caller to divide by a number that describes nothing.
 */
export class StreamDecodeSpan {
  private firstContentDeltaAt: number | null = null

  /** Call at the top of each attempt — a retried request starts a fresh span. */
  reset(): void {
    this.firstContentDeltaAt = null
  }

  /**
   * Record one stream event.
   *
   * `isFirstContentDelta` is the watchdog's transition flag, which is exactly "the first token
   * was generated"; the span needs no inspection of its own.
   */
  record(isFirstContentDelta: boolean, now: number): void {
    if (isFirstContentDelta && this.firstContentDeltaAt === null) {
      this.firstContentDeltaAt = now
    }
  }

  /** Milliseconds since the first generated delta, or 0 when no span ever opened. */
  elapsedMs(now: number): number {
    if (this.firstContentDeltaAt === null) return 0
    return Math.max(0, now - this.firstContentDeltaAt)
  }
}
