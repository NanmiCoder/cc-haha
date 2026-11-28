import { describe, expect, test } from 'bun:test'
import type { AssistantMessage } from '../../types/message.js'
import { StreamAssistantCommitBuffer } from './streamAssistantCommitBuffer.js'
import { getOutputLimitRetryBudget } from './outputBudget.js'
import {
  commitOutputLimitResponse,
  createOutputLimitErrorMessage,
} from './streamResponseBoundary.js'

function assistant(uuid: string): AssistantMessage {
  return {
    type: 'assistant',
    uuid,
    timestamp: '2026-08-18T00:00:00.000Z',
    message: { role: 'assistant', content: [] } as AssistantMessage['message'],
  }
}

describe('stream response boundary', () => {
  test('keeps a larger retry budget on the exact response without persisting it', () => {
    const error = createOutputLimitErrorMessage({
      stopReason: 'max_tokens', maxOutputTokens: 8_000, truncatedToolUse: false, retryBudget: 32_000,
    })
    expect(getOutputLimitRetryBudget(error)).toBe(32_000)
    expect(getOutputLimitRetryBudget(JSON.parse(JSON.stringify(error)))).toBeUndefined()
  })

  test('allows clean replay of a truncated tool only with a larger supported budget', () => {
    const error = createOutputLimitErrorMessage({
      stopReason: 'max_tokens', maxOutputTokens: 8_000, truncatedToolUse: true, retryBudget: 32_000,
    })
    expect(error.apiError).toBe('max_output_tokens')
    expect(getOutputLimitRetryBudget(error)).toBe(32_000)
    expect(JSON.stringify(error.message.content)).toContain('not executed')
  })

  test('never retries the same or smaller budget or increases a context-window limit', () => {
    for (const retryBudget of [4_096, 8_000]) {
      const error = createOutputLimitErrorMessage({
        stopReason: 'max_tokens', maxOutputTokens: 8_000, truncatedToolUse: true, retryBudget,
      })
      expect(getOutputLimitRetryBudget(error)).toBeUndefined()
      expect(error.apiError).toBeUndefined()
    }
    const error = createOutputLimitErrorMessage({
      stopReason: 'model_context_window_exceeded', maxOutputTokens: 8_000, truncatedToolUse: false, retryBudget: 32_000,
    })
    expect(getOutputLimitRetryBudget(error)).toBeUndefined()
    expect(error.apiError).toBe('max_output_tokens')
  })

  test('does not report an internal requested budget as a proven upstream limit', () => {
    for (const truncatedToolUse of [true, false]) {
      const error = createOutputLimitErrorMessage({
        stopReason: 'max_tokens', maxOutputTokens: 32_000, truncatedToolUse,
      })
      const text = JSON.stringify(error.message.content)
      expect(text).not.toContain('32000')
      expect(text).toContain('upstream length limit')
      if (truncatedToolUse) expect(text).toContain('not executed')
    }
  })
  test('drops a local tool block when max_tokens proves it was truncated', () => {
    const buffer = new StreamAssistantCommitBuffer<AssistantMessage>({
      deferToolUseCommit: true,
    })
    buffer.add(assistant('thinking'), 'thinking')
    buffer.add(assistant('tool'), 'tool_use')

    const result = commitOutputLimitResponse(buffer, 'max_tokens')
    const error = createOutputLimitErrorMessage({
      stopReason: 'max_tokens',
      maxOutputTokens: 131_072,
      truncatedToolUse: result?.truncatedToolUse ?? false,
    })

    expect(result).toEqual({
      messages: [expect.objectContaining({ uuid: 'thinking' })],
      truncatedToolUse: true,
    })
    expect(error).toMatchObject({
      isApiErrorMessage: true,
      error: 'max_output_tokens',
      apiError: undefined,
    })
  })

  test('keeps ordinary output-limit recovery when no tool is pending', () => {
    const buffer = new StreamAssistantCommitBuffer<AssistantMessage>()
    buffer.add(assistant('text'), 'text')

    const result = commitOutputLimitResponse(buffer, 'max_tokens')
    const error = createOutputLimitErrorMessage({
      stopReason: 'max_tokens',
      maxOutputTokens: 32_000,
      truncatedToolUse: result?.truncatedToolUse ?? false,
    })

    expect(result).toEqual({
      messages: [expect.objectContaining({ uuid: 'text' })],
      truncatedToolUse: false,
    })
    expect(error.apiError).toBe('max_output_tokens')
  })

  test('handles context-window truncation and ignores normal stops', () => {
    const buffer = new StreamAssistantCommitBuffer<AssistantMessage>({
      deferToolUseCommit: true,
    })
    buffer.add(assistant('tool'), 'tool_use')

    expect(commitOutputLimitResponse(buffer, 'tool_use')).toBeNull()
    const result = commitOutputLimitResponse(
      buffer,
      'model_context_window_exceeded',
    )
    const error = createOutputLimitErrorMessage({
      stopReason: 'model_context_window_exceeded',
      maxOutputTokens: 32_000,
      truncatedToolUse: result?.truncatedToolUse ?? false,
    })

    expect(result).toEqual({ messages: [], truncatedToolUse: true })
    expect(error.apiError).toBeUndefined()
  })
})
