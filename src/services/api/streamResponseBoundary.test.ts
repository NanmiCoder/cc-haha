import { describe, expect, test } from 'bun:test'
import type { AssistantMessage } from '../../types/message.js'
import { StreamAssistantCommitBuffer } from './streamAssistantCommitBuffer.js'
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
