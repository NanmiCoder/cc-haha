import { describe, expect, it } from 'bun:test'
import { translateCliMessage } from '../ws/handler.js'

/**
 * The CLI's `result` message has always carried `duration_ms` / `duration_api_ms`, and now
 * `decode_ms` / `ttft_ms` alongside them. The translation used to drop all four, which is why
 * nothing downstream could report how fast a session was generating. These pin the forwarding,
 * including the "absent means unknown" rule that keeps a client from dividing by zero.
 */
function resultMessages(overrides: Record<string, unknown>) {
  return translateCliMessage(
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 0,
      duration_api_ms: 0,
      usage: { input_tokens: 10, output_tokens: 20 },
      ...overrides,
    },
    'session-timing',
  ) as Array<{ type: string; usage?: unknown; timing?: Record<string, number> }>
}

describe('translateCliMessage: result timing', () => {
  it('forwards generation timings onto message_complete', () => {
    const [message] = resultMessages({
      duration_ms: 12_000,
      duration_api_ms: 9_000,
      decode_ms: 7_500,
      ttft_ms: 1_200,
    })

    expect(message?.type).toBe('message_complete')
    expect(message?.timing).toEqual({
      duration_ms: 12_000,
      duration_api_ms: 9_000,
      ttft_ms: 1_200,
      decode_ms: 7_500,
    })
    // The token buckets must keep flowing untouched — timing rides alongside, not instead.
    expect(message?.usage).toEqual({ input_tokens: 10, output_tokens: 20 })
  })

  it('omits timing entirely when the CLI reported none', () => {
    const [message] = resultMessages({})

    expect(message?.type).toBe('message_complete')
    // Absent rather than zero: a zero decode span would be read as "instant" and turn into an
    // infinite tokens/sec, whereas absent lets the client withhold the figure.
    expect(message?.timing).toBeUndefined()
    expect('timing' in (message ?? {})).toBe(false)
  })

  it('keeps a partial timing report instead of discarding it', () => {
    // An older CLI reports wall clock only; the remaining fields default to 0 so the shape
    // stays stable for consumers that read a single field.
    const [message] = resultMessages({ duration_ms: 5_000 })

    expect(message?.timing).toEqual({
      duration_ms: 5_000,
      duration_api_ms: 0,
      ttft_ms: 0,
      decode_ms: 0,
    })
  })

  it('ignores non-numeric timing values rather than emitting NaN', () => {
    const [message] = resultMessages({
      duration_ms: 'soon',
      decode_ms: null,
      ttft_ms: Number.NaN,
      duration_api_ms: Number.POSITIVE_INFINITY,
    })

    expect(message?.timing).toBeUndefined()
  })

  it('carries timing on an errored result too', () => {
    const messages = resultMessages({
      is_error: true,
      result: 'boom',
      duration_ms: 3_000,
      decode_ms: 2_000,
    })

    const complete = messages.find((message) => message.type === 'message_complete')
    // Tokens were generated and billed before the failure; the timing is as real as the usage.
    expect(complete?.timing?.decode_ms).toBe(2_000)
  })
})
