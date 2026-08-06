import type { MessageEntry } from './sessionService.js'

export function collectErroredToolUseIds(messages: MessageEntry[]): Set<string> {
  const erroredToolUseIds = new Set<string>()

  for (const message of messages) {
    if (message.type !== 'tool_result' || !Array.isArray(message.content)) continue

    for (const block of message.content) {
      if (!block || typeof block !== 'object') continue
      const record = block as Record<string, unknown>
      if (
        record.type === 'tool_result' &&
        record.is_error === true &&
        typeof record.tool_use_id === 'string'
      ) {
        erroredToolUseIds.add(record.tool_use_id)
      }
    }
  }

  return erroredToolUseIds
}

export function collectSuccessfulToolUseIds(messages: MessageEntry[]): Set<string> {
  const successfulToolUseIds = new Set<string>()
  const erroredToolUseIds = collectErroredToolUseIds(messages)

  for (const message of messages) {
    if (message.type !== 'tool_result' || !Array.isArray(message.content)) continue

    for (const block of message.content) {
      if (!block || typeof block !== 'object') continue
      const record = block as Record<string, unknown>
      if (
        record.type === 'tool_result' &&
        record.is_error !== true &&
        typeof record.tool_use_id === 'string'
      ) {
        successfulToolUseIds.add(record.tool_use_id)
      }
    }
  }

  for (const toolUseId of erroredToolUseIds) {
    successfulToolUseIds.delete(toolUseId)
  }
  return successfulToolUseIds
}
