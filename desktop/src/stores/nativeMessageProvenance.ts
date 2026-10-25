import type { ServerMessage, UIMessage } from '@/types/chat'

export function sameNativeMessageIds(a?: string[], b?: string[]) {
  return (a ?? []).join('\n') === (b ?? []).join('\n')
}

export function nativeMessageMatches(message: UIMessage, ids: Set<string>): boolean {
  if (message.type === 'user_text') return false
  if (ids.has(message.id) || message.nativeMessageIds?.some(id => ids.has(id))) return true
  if ('transcriptMessageId' in message && message.transcriptMessageId && ids.has(message.transcriptMessageId)) return true
  // Hydrated native thinking and tool blocks use the transcript frame UUID.
  const split = message.id.lastIndexOf('-block-')
  return split >= 0 && /^\d+$/.test(message.id.slice(split + 7)) && ids.has(message.id.slice(0, split))
}

export function stampNativeMessageProvenance(
  previous: UIMessage[], next: UIMessage[], event: ServerMessage, streamingIds?: string[],
): UIMessage[] {
  if (!event.nativeMessageIds?.length && !streamingIds?.length) return next
  const old = new Map(previous.map(message => [message.id, message]))
  return next.map(message => {
    if (message === old.get(message.id) || message.type === 'user_text') return message
    const ids = message.type === 'assistant_text' ? streamingIds :
      ['thinking', 'tool_use', 'tool_result', 'error'].includes(message.type) ? event.nativeMessageIds : undefined
    return ids?.length ? { ...message, nativeMessageIds: [...new Set([...(message.nativeMessageIds ?? []), ...ids])] } : message
  })
}
