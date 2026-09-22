export type SessionReference = { sessionId: string }

export function normalizeSessionReferences(value: unknown): SessionReference[] {
  if (!Array.isArray(value)) return []
  const ids = new Set<string>()
  for (const item of value.slice(0, 20)) {
    if (item && typeof item === 'object' && typeof item.sessionId === 'string' && item.sessionId.length > 0 && item.sessionId.length <= 200) ids.add(item.sessionId)
  }
  return [...ids].map(sessionId => ({ sessionId }))
}

/** Restore the server's trailing envelope, leaving literal/invalid tags untouched. */
export function splitSessionReferenceContext(text: string): { content: string, sessionReferences: SessionReference[] } {
  const match = /(?:^|\n\n)<session_references>\n[^\n]*\n([^\n]+)\n<\/session_references>\s*$/.exec(text)
  if (!match) return { content: text, sessionReferences: [] }
  try {
    const value: unknown = JSON.parse(match[1]!)
    const references = normalizeSessionReferences(value)
    if (!Array.isArray(value) || !references.length || references.length !== value.length) return { content: text, sessionReferences: [] }
    return { content: text.slice(0, match.index).trimEnd(), sessionReferences: references }
  } catch { return { content: text, sessionReferences: [] } }
}
