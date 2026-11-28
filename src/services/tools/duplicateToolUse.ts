import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import type { AssistantMessage, Message } from '../../types/message.js'
import { createUserMessage } from '../../utils/messages.js'

/**
 * A model can degenerate and emit the same tool call several times in one
 * assistant message (a 100k-token context produced three identical TeamPlan
 * submits). None of those calls can have depended on an earlier result, so
 * only the first may run: executing the rest repeats side effects and floods
 * the transcript. Every skipped call still gets its own tool_result so the
 * assistant tool_use / user tool_result pairing stays valid.
 */

/** Stable serialization: the same input object always yields the same text. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null'
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      key =>
        `${JSON.stringify(key)}:${canonicalJson(
          (value as Record<string, unknown>)[key],
        )}`,
    )
  return `{${entries.join(',')}}`
}

/**
 * Identity of a tool invocation. The tool_use id is intentionally excluded:
 * repetitions differ only in id. Inputs come from the API as JSON, so the
 * canonical form is always defined.
 */
export function toolUseSignature(block: ToolUseBlock): string {
  return `${block.name}\u0000${canonicalJson(block.input)}`
}

/** IDs of calls that repeat an earlier call in the same batch, in order. */
export function duplicateToolUseIds(
  blocks: readonly ToolUseBlock[],
): Set<string> {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const block of blocks) {
    const signature = toolUseSignature(block)
    if (seen.has(signature)) duplicates.add(block.id)
    else seen.add(signature)
  }
  return duplicates
}

/** Tool result for a suppressed duplicate, telling the model to reuse the first result. */
export function createDuplicateToolResult(
  block: ToolUseBlock,
  assistantMessage: AssistantMessage,
): Message {
  const message =
    `Duplicate call skipped: ${block.name} was already called with identical input in this message. ` +
    'Only the first call runs; reuse its result instead of issuing the same call again.'
  return createUserMessage({
    content: [
      {
        type: 'tool_result',
        content: `<tool_use_error>${message}</tool_use_error>`,
        is_error: true,
        tool_use_id: block.id,
      },
    ],
    toolUseResult: 'Duplicate tool call skipped',
    durationMs: 0,
    sourceToolAssistantUUID: assistantMessage.uuid,
  })
}
