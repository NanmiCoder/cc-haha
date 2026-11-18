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

describe('translateCliMessage: tool_result durationMs', () => {
  it('forwards per-tool execution durationMs on user tool_result and background agent_tool_activity frames', () => {
    const [direct] = translateCliMessage(
      {
        type: 'user',
        durationMs: 220,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_edit_1', content: 'ok', is_error: false }],
        },
      },
      'session-tool-timing',
    ) as Array<Record<string, unknown>>

    expect(direct).toEqual({
      type: 'tool_result',
      toolUseId: 'toolu_edit_1',
      content: 'ok',
      isError: false,
      parentToolUseId: undefined,
      durationMs: 220,
    })

    const [bgActivity] = translateCliMessage(
      {
        type: 'system',
        subtype: 'agent_tool_activity',
        tool_use_id: 'toolu_parent_agent',
        activity: {
          kind: 'tool_result',
          tool_use_id: 'toolu_child_edit',
          content: 'done',
          is_error: false,
          duration_ms: 145,
        },
      },
      'session-tool-timing',
    ) as Array<Record<string, unknown>>

    expect(bgActivity).toEqual({
      type: 'tool_result',
      toolUseId: 'toolu_parent_agent/toolu_child_edit',
      originalToolUseId: 'toolu_child_edit',
      content: 'done',
      isError: false,
      parentToolUseId: 'toolu_parent_agent',
      durationMs: 145,
    })
  })

  it('omits durationMs when absent, invalid, or ambiguous across multiple tool_result blocks', () => {
    const [legacy] = translateCliMessage(
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_legacy', content: 'ok', is_error: false }],
        },
      },
      'session-tool-timing-legacy',
    ) as Array<Record<string, unknown>>
    expect('durationMs' in legacy!).toBe(false)

    const [invalid] = translateCliMessage(
      {
        type: 'user',
        durationMs: -5,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_neg', content: 'ok', is_error: false }],
        },
      },
      'session-tool-timing-invalid',
    ) as Array<Record<string, unknown>>
    expect('durationMs' in invalid!).toBe(false)

    const multi = translateCliMessage(
      {
        type: 'user',
        durationMs: 200,
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_a', content: 'a', is_error: false },
            { type: 'tool_result', tool_use_id: 'toolu_b', content: 'b', is_error: false },
          ],
        },
      },
      'session-tool-timing-multi',
    ) as Array<Record<string, unknown>>
    expect(multi).toHaveLength(2)
    expect('durationMs' in multi[0]!).toBe(false)
    expect('durationMs' in multi[1]!).toBe(false)
  })
})
