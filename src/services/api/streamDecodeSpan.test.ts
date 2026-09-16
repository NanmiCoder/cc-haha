import { describe, expect, test } from 'bun:test'
import { StreamDecodeSpan } from './streamDecodeSpan.js'

describe('StreamDecodeSpan', () => {
  test('measures from the first generated delta, not from request start', () => {
    const span = new StreamDecodeSpan()

    // 2s of prefill: message_start and bookkeeping arrive, no token has been generated yet.
    span.record(false, 1_000)
    span.record(false, 1_200)
    span.record(false, 2_000)
    expect(span.elapsedMs(2_000)).toBe(0)

    // First real token at 2s; generation runs until the stream closes at 7s.
    span.record(true, 2_000)
    span.record(false, 5_000)
    expect(span.elapsedMs(7_000)).toBe(5_000)
  })

  test('does not reopen the span on later content deltas', () => {
    const span = new StreamDecodeSpan()

    span.record(true, 1_000)
    // The watchdog flag only fires once, but a caller that passed it twice must not restart
    // the clock — that would report a speed for the last token alone.
    span.record(true, 4_000)
    span.record(true, 6_000)

    expect(span.elapsedMs(9_000)).toBe(8_000)
  })

  test('reports nothing for a stream that never generated a token', () => {
    const span = new StreamDecodeSpan()

    span.record(false, 1_000)
    span.record(false, 9_000)

    // A request that produced no content has no rate to report. Returning the wait would let a
    // caller divide output tokens by a prefill-only span.
    expect(span.elapsedMs(9_000)).toBe(0)
  })

  test('reset clears the span for a retried attempt', () => {
    const span = new StreamDecodeSpan()
    span.record(true, 1_000)
    expect(span.elapsedMs(4_000)).toBe(3_000)

    span.reset()

    // The second attempt's prefill must not be counted as generation time from the first.
    span.record(false, 10_000)
    expect(span.elapsedMs(10_000)).toBe(0)
    span.record(true, 12_000)
    expect(span.elapsedMs(15_000)).toBe(3_000)
  })

  test('never returns a negative span when the clock steps backwards', () => {
    const span = new StreamDecodeSpan()
    span.record(true, 5_000)

    expect(span.elapsedMs(4_000)).toBe(0)
  })
})
