import { describe, expect, test } from 'bun:test'
import {
  StreamWatchdogTimeoutError,
  createStreamWatchdogState,
} from './streamWatchdog.js'

describe('stream watchdog state', () => {
  test('keeps the first-token budget until content deltas arrive', () => {
    const state = createStreamWatchdogState()

    expect(state.recordEvent({ type: 'message_start' })).toBe(false)
    expect(state.recordEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking' },
    })).toBe(false)

    expect(state.hasContentDelta()).toBe(false)
    expect(state.snapshot().phase).toBe('before_content')

    expect(state.recordEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'working' },
    })).toBe(true)

    expect(state.hasContentDelta()).toBe(true)
    expect(state.snapshot()).toMatchObject({
      phase: 'mid_stream',
      eventCount: 3,
      contentDeltaCount: 1,
      thinkingDeltaCount: 1,
      lastEventType: 'content_block_delta',
      lastDeltaType: 'thinking_delta',
      lastBlockType: 'thinking',
    })
  })

  test('describes a stream that started but never produced content', () => {
    const state = createStreamWatchdogState()
    state.recordEvent({ type: 'message_start' })
    state.recordEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking' },
    })

    const error = state.createTimeoutError('idle', 600_000)

    expect(error).toBeInstanceOf(StreamWatchdogTimeoutError)
    expect(error.code).toBe('STREAM_IDLE_TIMEOUT')
    expect(error.phase).toBe('before_content')
    expect(error.safeToRetryStream()).toBe(true)
    expect(error.message).toContain('stream started but no content was received')
    expect(error.message).toContain('last event: content_block_start')
  })

  test('describes a provider stream that stalls after partial output', () => {
    const state = createStreamWatchdogState()
    state.recordEvent({ type: 'message_start' })
    state.recordEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text' },
    })
    state.recordEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'writing HTML report, partial' },
    })

    const error = state.createTimeoutError('idle', 240_000)

    expect(error.code).toBe('STREAM_IDLE_TIMEOUT')
    expect(error.phase).toBe('mid_stream')
    expect(error.safeToRetryStream()).toBe(true)
    expect(error.message).toContain('Provider stream stalled after partial response')
    expect(error.message).toContain('last event: text_delta')
    expect(error.message).not.toContain('no chunks received')
  })

  test('retries partial local tool input but stops after the tool block completes', () => {
    const state = createStreamWatchdogState()
    state.recordEvent({ type: 'message_start' })
    state.recordEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use' },
    })

    expect(state.createTimeoutError('idle', 240_000).safeToRetryStream()).toBe(true)

    state.recordEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"file_path":' },
    })
    expect(state.createTimeoutError('idle', 240_000).safeToRetryStream()).toBe(true)

    state.recordEvent({ type: 'content_block_stop', index: 0 })
    const error = state.createTimeoutError('idle', 240_000)

    expect(error.phase).toBe('mid_stream')
    expect(error.safeToRetryStream()).toBe(false)
  })

  test('never retries after server-side tool activity begins', () => {
    const state = createStreamWatchdogState()
    state.recordEvent({ type: 'message_start' })
    state.recordEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'server_tool_use' },
    })

    const error = state.createTimeoutError('idle', 240_000)

    expect(error.safeToRetryStream()).toBe(false)
  })

  test('classifies max-duration aborts separately from idle aborts', () => {
    const state = createStreamWatchdogState()
    state.recordEvent({ type: 'message_start' })
    state.recordEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text' },
    })
    state.recordEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'partial' },
    })

    const error = state.createTimeoutError('max_duration', 600_000)

    expect(error.code).toBe('STREAM_MAX_DURATION')
    expect(error.phase).toBe('mid_stream')
    expect(error.safeToRetryStream()).toBe(false)
    expect(error.message).toContain('Stream max duration exceeded')
    expect(error.message).toContain('last event: text_delta')
  })

  test('does not retry a tool input that exceeded its generation budget', () => {
    const state = createStreamWatchdogState()
    state.recordEvent({ type: 'message_start' })
    state.recordEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use' },
    })
    state.recordEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"content":"partial' },
    })

    const error = state.createTimeoutError('tool_input_duration', 120_000)

    expect(error.code).toBe('STREAM_TOOL_INPUT_DURATION')
    expect(error.safeToRetryStream()).toBe(false)
    expect(error.message).toContain('Tool input generation exceeded 120s')
    expect(error.message).toContain('last event: input_json_delta')
  })
})
