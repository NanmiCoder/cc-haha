type Frame = Record<string, any>
type Block = { id: string; type: string; text: string; toolId?: string; assigned?: string }

/**
 * Native transcript UUIDs arrive after streaming. Keep block provenance so a
 * refusal can retract just the replaced frames, including their streamed UI.
 * This is process-local bookkeeping, never a second transcript.
 */
export function createOfficialAgentSdkMessageIdentity() {
  const active = new Map<string, string>()
  const blocks = new Map<string, Map<number, Block>>()
  const identities = new Map<string, string[]>()
  const scopeOf = (frame: Frame) => String(frame.parent_tool_use_id ?? '')
  const keyOf = (scope: string, id: string) => JSON.stringify([scope, id])
  function expand(uuids: unknown): string[] {
    if (!Array.isArray(uuids)) return []
    return [...new Set(uuids.filter((id): id is string => typeof id === 'string')
      .flatMap(id => [id, ...(identities.get(id) ?? [])]))]
  }
  return {
    expand,
    observe(frame: Frame): string[] | undefined {
      const scope = scopeOf(frame)
      if (frame.type === 'stream_event') {
        const event = frame.event
        if (event?.type === 'message_start' && typeof event.message?.id === 'string') {
          const key = keyOf(scope, event.message.id)
          active.set(scope, key)
          blocks.set(key, new Map())
        }
        const key = active.get(scope)
        const current = key && blocks.get(key)
        if (!current || typeof event?.index !== 'number') return
        if (event.type === 'content_block_start') {
          const block = event.content_block ?? {}
          current.set(event.index, {
            id: `sdk-block:${key}:${event.index}`,
            type: block.type, text: block.text ?? block.thinking ?? '',
            ...(typeof block.id === 'string' ? { toolId: block.id } : {}),
          })
        }
        const block = current.get(event.index)
        if (!block) return
        if (event.type === 'content_block_delta') {
          block.text += event.delta?.text ?? event.delta?.thinking ?? ''
        }
        return [block.id]
      }
      if ((frame.type !== 'assistant' && frame.type !== 'user') || typeof frame.uuid !== 'string') return
      if (identities.has(frame.uuid)) return [frame.uuid, ...identities.get(frame.uuid)!]
      const ids: string[] = []
      if (frame.type === 'assistant' && Array.isArray(frame.message?.content)) {
        const key = keyOf(scope, String(frame.message.id))
        const current = blocks.get(key)
        for (const content of frame.message.content) {
          const match = current && [...current.values()].find(block =>
            !block.assigned && block.type === content.type &&
            (block.toolId ? block.toolId === content.id : block.text === (content.text ?? content.thinking ?? '')))
          if (match) {
            match.assigned = frame.uuid
            ids.push(match.id)
          }
        }
      }
      identities.set(frame.uuid, ids)
      // Bounded to the current session's recent messages; older frames retain
      // their native UUID in hydrated history and are still retractable.
      if (identities.size > 4000) identities.delete(identities.keys().next().value!)
      if (blocks.size > 1000) blocks.delete(blocks.keys().next().value!)
      return [frame.uuid, ...ids]
    },
  }
}
