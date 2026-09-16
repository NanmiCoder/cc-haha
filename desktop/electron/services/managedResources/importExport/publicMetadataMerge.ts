import { isDeepStrictEqual } from 'node:util'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Only fields present in the strict public DTO participate in comparison.
// Private credential references and internal forward-compatible fields are not
// overwritten by an external document. Array entity identity is always its ID.
export function mergePublicMetadata<T>(existing: T | undefined, incoming: T): T {
  function merge(previous: unknown, next: unknown): unknown {
    if (Array.isArray(next)) {
      const old = Array.isArray(previous) ? previous : []
      return next.map(item => merge(
        record(item) && typeof item.id === 'string'
          ? old.find(candidate => record(candidate) && candidate.id === item.id)
          : undefined,
        item,
      ))
    }
    if (!record(next)) return next
    const old = record(previous) ? previous : {}
    const result = { ...old }
    for (const [key, value] of Object.entries(next)) {
      if (key === 'credentialId' || key === 'clientKeyCredentialId') {
        result[key] = old[key] ?? null
      } else {
        result[key] = merge(old[key], value)
      }
    }
    return result
  }
  return merge(existing, incoming) as T
}

export function hasImportRevisionConflict<T extends { revision: number }>(existing: T | undefined, incoming: T): boolean {
  if (!existing) return false
  if (incoming.revision < existing.revision) return true
  if (incoming.revision > existing.revision) return false
  const merged = mergePublicMetadata(existing, incoming)
  // Timestamps are metadata, not a license to change the versioned content.
  function content(value: T) {
    const { createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = value as T & { createdAt?: string; updatedAt?: string }
    return rest
  }
  return !isDeepStrictEqual(content(existing), content(merged))
}
