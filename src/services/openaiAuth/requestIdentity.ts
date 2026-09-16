import { createHash } from 'crypto'

// UUID URL namespace, used only for legacy non-UUID session identifiers.
const URL_NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Stable transport identity. Cache overrides and per-turn routing are separate. */
export function resolveOpenAIRequestIdentity(
  rootSessionId: string | null | undefined,
  agentId?: string,
): { sessionId: string; threadId: string } | undefined {
  const sessionId = rootSessionId?.trim()
  if (!sessionId) return undefined
  if (!agentId) return { sessionId, threadId: sessionId }

  // A resumed branch keeps its agentId. Namespace by the root session so the
  // same local agent ID in another conversation cannot alias this thread.
  const uuidRoot = UUID_PATTERN.test(sessionId)
  const namespace = uuidRoot ? sessionId : URL_NAMESPACE
  const name = uuidRoot ? agentId : JSON.stringify(['cc-haha', sessionId, agentId])
  const bytes = createHash('sha1')
    .update(Buffer.from(namespace.replaceAll('-', ''), 'hex'))
    .update(name, 'utf8')
    .digest()
    .subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  const threadId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  return { sessionId, threadId }
}
