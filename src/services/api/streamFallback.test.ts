import { describe, expect, test } from 'bun:test'
import {
  shouldTriggerNonStreamingFallbackForEmptyStream,
  StreamEndedEarlyError,
} from './streamFallback.js'

describe('StreamEndedEarlyError', () => {
  test('keeps the user-visible wording that error matchers key on', () => {
    expect(new StreamEndedEarlyError('no_events').message).toBe(
      'Stream ended without receiving any events',
    )
    expect(new StreamEndedEarlyError('incomplete').message).toBe(
      'Provider stream ended before completing the response',
    )
    expect(new StreamEndedEarlyError('incomplete')).toBeInstanceOf(Error)
  })
})

describe('stream fallback policy', () => {
  test('falls back when a stream never produced message_start', () => {
    expect(
      shouldTriggerNonStreamingFallbackForEmptyStream({
        hasMessageStart: false,
        assistantMessageCount: 0,
        stopReason: null,
      }),
    ).toBe(true)
  })

  test('falls back when a stream starts but produces no terminal reason or content', () => {
    expect(
      shouldTriggerNonStreamingFallbackForEmptyStream({
        hasMessageStart: true,
        assistantMessageCount: 0,
        stopReason: null,
      }),
    ).toBe(true)
  })

  test('falls back when a stream reports tool_use without any tool block', () => {
    expect(
      shouldTriggerNonStreamingFallbackForEmptyStream({
        hasMessageStart: true,
        assistantMessageCount: 0,
        stopReason: 'tool_use',
      }),
    ).toBe(true)
  })

  test('keeps legitimate empty end_turn responses', () => {
    expect(
      shouldTriggerNonStreamingFallbackForEmptyStream({
        hasMessageStart: true,
        assistantMessageCount: 0,
        stopReason: 'end_turn',
      }),
    ).toBe(false)
  })

  test('does not fall back after yielding an assistant message', () => {
    expect(
      shouldTriggerNonStreamingFallbackForEmptyStream({
        hasMessageStart: true,
        assistantMessageCount: 1,
        stopReason: 'tool_use',
      }),
    ).toBe(false)
  })
})
