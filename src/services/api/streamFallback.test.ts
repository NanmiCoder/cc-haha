import { describe, expect, test } from 'bun:test'
import {
  formatStreamEndedEarlyMessage,
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

  test('evidence does not change the message wording', () => {
    const error = new StreamEndedEarlyError('incomplete', {
      eventCount: 3, lastEventType: 'content_block_delta', stopReason: null,
      messageStopReceived: false, openBlockCount: 1, elapsedMs: 1000,
    })
    expect(error.message).toBe('Provider stream ended before completing the response')
  })
})

describe('formatStreamEndedEarlyMessage', () => {
  const attribution =
    'The upstream model provider closed the stream before the reply finished; this is not a context-limit error.'

  test('a reply cut mid-block shows the open block and the missing terminal events', () => {
    const error = new StreamEndedEarlyError('incomplete', {
      eventCount: 412, lastEventType: 'content_block_delta', stopReason: null,
      messageStopReceived: false, openBlockCount: 1, elapsedMs: 263_400,
    })
    expect(formatStreamEndedEarlyMessage(error, 10)).toBe(
      `Provider stream ended before completing the response. ${attribution} ` +
        '(retried 10 times · 412 events · last content_block_delta · stop_reason none · message_stop missing · 1 block open · 263s)',
    )
  })

  test('a reply that only dropped message_stop shows the stop_reason it did send', () => {
    const error = new StreamEndedEarlyError('incomplete', {
      eventCount: 9, lastEventType: 'message_delta', stopReason: 'tool_use',
      messageStopReceived: false, openBlockCount: 0, elapsedMs: 4_000,
    })
    expect(formatStreamEndedEarlyMessage(error, 1)).toBe(
      `Provider stream ended before completing the response. ${attribution} ` +
        '(retried 1 time · 9 events · last message_delta · stop_reason tool_use · message_stop missing · 4s)',
    )
  })

  test('without evidence or retries only the wording and attribution remain', () => {
    expect(formatStreamEndedEarlyMessage(new StreamEndedEarlyError('no_events'))).toBe(
      `Stream ended without receiving any events. ${attribution}`,
    )
    expect(formatStreamEndedEarlyMessage(new StreamEndedEarlyError('no_events'), 0)).toBe(
      `Stream ended without receiving any events. ${attribution}`,
    )
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
