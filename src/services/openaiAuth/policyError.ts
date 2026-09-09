const POLICY_ERROR_CODES = new Set([
  'cyber_policy',
  'content_policy',
  'content_policy_violation',
])

/** Match explicit upstream policy codes, never infer a rejection from prose. */
export function getOpenAIPolicyError(input: unknown): { code: string; message: string } | null {
  const visited = new Set<object>()
  function visit(value: unknown, depth: number): { code: string; message: string } | null {
    if (depth > 12 || value === null || typeof value !== 'object' || visited.has(value)) return null
    visited.add(value)
    const record = value as Record<string, unknown>
    if (typeof record.code === 'string' && POLICY_ERROR_CODES.has(record.code)) {
      return {
        code: record.code,
        message: typeof record.message === 'string' && record.message.trim()
          ? record.message
          : 'Request rejected by the upstream safety policy.',
      }
    }
    // SDK errors, Responses events and our retry wrappers use these boundaries.
    for (const key of ['error', 'response', 'originalError', 'cause']) {
      const match = visit(record[key], depth + 1)
      if (match) return match
    }
    if (typeof record.message === 'string') {
      // Anthropic SDK prefixes a serialized error body with its HTTP status.
      const serialized = record.message.replace(/^\d{3}\s+/, '').trim()
      if (serialized.startsWith('{')) {
        try {
          return visit(JSON.parse(serialized), depth + 1)
        } catch {
          // Unstructured messages must not become policy classifications.
        }
      }
    }
    return null
  }
  return visit(input, 0)
}

export function isOpenAIPolicyError(input: unknown): boolean {
  return getOpenAIPolicyError(input) !== null
}
