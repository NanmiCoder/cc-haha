import type { BetaStopReason } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { AssistantMessage } from '../../types/message.js'
import { createAssistantAPIErrorMessage } from '../../utils/messages.js'
import { API_ERROR_MESSAGE_PREFIX } from './errors.js'
import type { StreamAssistantCommitBuffer } from './streamAssistantCommitBuffer.js'

export type OutputLimitStopReason = Extract<
  BetaStopReason,
  'max_tokens' | 'model_context_window_exceeded'
>

export function commitOutputLimitResponse(
  buffer: StreamAssistantCommitBuffer<AssistantMessage>,
  stopReason: BetaStopReason | null,
): { messages: AssistantMessage[]; truncatedToolUse: boolean } | null {
  if (
    stopReason !== 'max_tokens' &&
    stopReason !== 'model_context_window_exceeded'
  ) {
    return null
  }
  const truncatedToolUse = buffer.hasPendingToolUse()
  return {
    messages: truncatedToolUse
      ? buffer.flushWithoutToolUse()
      : buffer.flush(),
    truncatedToolUse,
  }
}

export function createOutputLimitErrorMessage({
  stopReason,
  truncatedToolUse,
}: {
  stopReason: OutputLimitStopReason
  maxOutputTokens: number
  truncatedToolUse: boolean
}): AssistantMessage {
  const content = stopReason === 'max_tokens'
    ? truncatedToolUse
      ? `${API_ERROR_MESSAGE_PREFIX}: The model's tool call was truncated at an upstream length limit, so it was not executed. Retry with a larger supported output budget or split the operation into smaller tool calls.`
      : `${API_ERROR_MESSAGE_PREFIX}: The model's response was truncated at an upstream length limit (output or context). Check the provider's output budget and context limit.`
    : truncatedToolUse
      ? `${API_ERROR_MESSAGE_PREFIX}: The model's tool call was truncated at the context window limit, so it was not executed.`
      : `${API_ERROR_MESSAGE_PREFIX}: The model has reached its context window limit.`

  // Output-budget truncation is always recoverable: query.ts's
  // max_output_tokens loop resumes the turn and asks the model to break the
  // remaining work into smaller pieces, so a truncated tool call retries on a
  // continuation instead of hard-failing the session. A context-window cut is
  // different — no smaller budget makes it fit — so a truncated tool call
  // there stays terminal (no apiError → recovery gate not engaged).
  const recoverable = stopReason === 'max_tokens' || !truncatedToolUse
  return createAssistantAPIErrorMessage({
    content,
    ...(recoverable ? { apiError: 'max_output_tokens' } : undefined),
    error: 'max_output_tokens',
  })
}
