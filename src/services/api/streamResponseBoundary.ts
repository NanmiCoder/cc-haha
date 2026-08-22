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
  maxOutputTokens,
  truncatedToolUse,
}: {
  stopReason: OutputLimitStopReason
  maxOutputTokens: number
  truncatedToolUse: boolean
}): AssistantMessage {
  const content = stopReason === 'max_tokens'
    ? truncatedToolUse
      ? `${API_ERROR_MESSAGE_PREFIX}: The model's tool call was truncated after reaching the ${maxOutputTokens} output token maximum, so it was not executed.`
      : `${API_ERROR_MESSAGE_PREFIX}: Claude's response exceeded the ${maxOutputTokens} output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.`
    : truncatedToolUse
      ? `${API_ERROR_MESSAGE_PREFIX}: The model's tool call was truncated at the context window limit, so it was not executed.`
      : `${API_ERROR_MESSAGE_PREFIX}: The model has reached its context window limit.`

  return createAssistantAPIErrorMessage({
    content,
    ...(truncatedToolUse ? undefined : { apiError: 'max_output_tokens' }),
    error: 'max_output_tokens',
  })
}
