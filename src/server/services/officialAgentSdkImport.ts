import type { SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk'
import { SessionBranchingError } from '../../utils/sessionBranching.js'

function incompatible(detail: string): never {
  throw new SessionBranchingError('INVALID_TARGET', `Cannot copy this history to Agent SDK: ${detail}`)
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function media(block: Record<string, unknown>): Record<string, unknown> {
  const source = block.source
  if (!object(source)) return incompatible('an attachment has no portable source')
  if (source.type === 'base64' && typeof source.data === 'string' && typeof source.media_type === 'string') {
    return { type: block.type, source: { type: 'base64', data: source.data, media_type: source.media_type } }
  }
  if (source.type === 'url' && typeof source.url === 'string' && /^https?:\/\//.test(source.url)) {
    return { type: block.type, source: { type: 'url', url: source.url } }
  }
  if (block.type === 'document' && source.type === 'text' && typeof source.data === 'string') {
    return { type: 'document', source: { type: 'text', data: source.data, media_type: 'text/plain' } }
  }
  return incompatible('an attachment uses a runtime-specific source')
}

function blocks(content: unknown, role: 'user' | 'assistant', nested = false): unknown[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return incompatible('a message has unsupported content')
  return content.flatMap(block => {
    if (!object(block)) return incompatible('a content block is malformed')
    switch (block.type) {
      case 'text':
        if (typeof block.text !== 'string') return incompatible('a text block is malformed')
        return [{ type: 'text', text: block.text }]
      case 'thinking':
      case 'redacted_thinking':
        // Provider-specific signatures cannot be replayed to another model.
        return []
      case 'image':
      case 'document':
        if (role !== 'user') return incompatible('assistant media is not portable')
        return [media(block)]
      case 'tool_use':
        if (nested || role !== 'assistant' || typeof block.id !== 'string' || !block.id ||
          typeof block.name !== 'string' || !block.name || !object(block.input)) {
          return incompatible('a historical tool call is malformed')
        }
        return [{ type: 'tool_use', id: block.id, name: block.name, input: block.input }]
      case 'tool_result':
        if (nested || role !== 'user' || typeof block.tool_use_id !== 'string' || !block.tool_use_id) {
          return incompatible('a historical tool result is malformed')
        }
        return [{ type: 'tool_result', tool_use_id: block.tool_use_id,
          content: blocks(block.content ?? '', 'user', true), ...(typeof block.is_error === 'boolean' ? { is_error: block.is_error } : {}) }]
      default:
        return incompatible(`unsupported historical content block: ${String(block.type)}`)
    }
  })
}

/** Import conversation evidence, never pending commands, grants, queued tasks,
 * deferred tool registrations, hooks or provider-specific thinking signatures.
 * The SDK has already selected the fork boundary and remapped native UUIDs. */
export function prepareLegacyAgentSdkImport(entries: SessionStoreEntry[]): SessionStoreEntry[] {
  const byId = new Map(entries.flatMap(entry => entry.uuid ? [[entry.uuid, entry] as const] : []))
  let current = entries.findLast(entry => entry.type === 'user' || entry.type === 'assistant')
  const chain: SessionStoreEntry[] = []
  const seen = new Set<string>()
  while (current) {
    if (!current.uuid || seen.has(current.uuid)) return incompatible('the conversation chain is incomplete or cyclic')
    seen.add(current.uuid)
    chain.unshift(current)
    if (!current.parentUuid) break
    if (typeof current.parentUuid !== 'string') return incompatible('the conversation chain is malformed')
    current = byId.get(current.parentUuid)
    if (!current) return incompatible('the conversation chain is incomplete')
  }
  const pending = new Set<string>()
  const usedToolIds = new Set<string>()
  const result: SessionStoreEntry[] = []
  let parentUuid: string | null = null
  for (const entry of chain) {
    if (entry.type !== 'user' && entry.type !== 'assistant') continue
    if (!object(entry.message)) return incompatible('a conversation message is malformed')
    const content = blocks(entry.message.content, entry.type)
    if (!content.length) continue
    for (const item of content) {
      const block = item as Record<string, unknown>
      if (block.type === 'tool_use') {
        if (usedToolIds.has(block.id as string)) return incompatible('a historical tool identifier is duplicated')
        usedToolIds.add(block.id as string)
        pending.add(block.id as string)
      } else if (block.type === 'tool_result') {
        if (!pending.delete(block.tool_use_id as string)) return incompatible('a historical tool result has no matching call')
      }
    }
    result.push({ type: entry.type, uuid: entry.uuid, parentUuid, sessionId: entry.sessionId,
      timestamp: entry.timestamp, cwd: entry.cwd, isSidechain: false, forkedFrom: entry.forkedFrom,
      message: { ...entry.message, role: entry.type, content } })
    parentUuid = entry.uuid!
  }
  if (!result.length) return incompatible('there is no portable conversation content')
  if (pending.size) return incompatible('choose a completed reply after all tool results have arrived')
  return [...result, ...entries.filter(entry => entry.type === 'custom-title')]
}
