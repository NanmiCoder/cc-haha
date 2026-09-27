import type { UIMessage } from '../types/chat'

const messageBytes = new WeakMap<UIMessage, number>()

export function copyChatPreview(value: string, maxChars: number, tail = false): string {
  if (value.length <= maxChars) return value
  const slice = tail ? value.slice(-maxChars) : value.slice(0, maxChars)
  return new TextDecoder().decode(new TextEncoder().encode(slice))
}

/** Estimate retention without serializing or modifying an operational payload. */
export function retainedMessageBytes(message: UIMessage): number {
  const cached = messageBytes.get(message)
  if (cached !== undefined) return cached
  let bytes = 256
  const pending: unknown[] = [message]
  const seen = new Set<object>()
  while (pending.length) {
    const value = pending.pop()
    if (typeof value === 'string') bytes += value.length * 2
    else if (value && typeof value === 'object') {
      if (seen.has(value)) continue
      seen.add(value)
      bytes += 64
      for (const [key, child] of Object.entries(value)) {
        bytes += 32 + key.length * 2
        pending.push(child)
      }
    } else bytes += 8
  }
  messageBytes.set(message, bytes)
  return bytes
}

/**
 * Transcript rows are never evicted from a mounted timeline. The server bounds
 * history by bytes; a text preview is not a valid replacement for a row that
 * feeds replay matching, image/diff rendering, copy and rewind.
 */
export const CHAT_TERMINAL_ACTIVITY_MAX_PER_SESSION = 500
export const CHAT_TERMINAL_ACTIVITY_MAX_TOTAL = 4000
const activityCache = new WeakMap<object, { budget: number; terminalLimit: number; result: object }>()

// UI projections retain every active lifecycle, plus recent terminal evidence.
// Runtime/provider input and pending permission requests live elsewhere.
export function boundActivityText<T extends object>(
  records: Record<string, T> | undefined,
  budget: number,
  terminalLimit = CHAT_TERMINAL_ACTIVITY_MAX_PER_SESSION,
): Record<string, T> | undefined {
  if (!records) return records
  const cached = activityCache.get(records)
  if (cached?.budget === budget && cached.terminalLimit === terminalLimit) return cached.result as Record<string, T>
  const fields = ['prompt', 'result', 'summary', 'description'] as const
  const entries = Object.entries(records)
  const terminal = entries.filter(([, entry]) => {
    const status = (entry as Record<string, unknown>).status
    return status === 'completed' || status === 'failed' || status === 'stopped'
  })
  let result = records
  if (terminal.length > terminalLimit) {
    function time(entry: T): number {
      const value = entry as Record<string, unknown>
      const timestamp = value.updatedAt ?? value.timestamp ?? value.startedAt
      const parsed = typeof timestamp === 'number' ? timestamp : typeof timestamp === 'string' ? Date.parse(timestamp) : 0
      return Number.isFinite(parsed) ? parsed : 0
    }
    // Stable sort keeps insertion order for bookends without timestamps.
    terminal.sort((a, b) => time(a[1]) - time(b[1]))
    const dropped = new Set(terminal.slice(0, terminal.length - terminalLimit).map(([id]) => id))
    result = Object.fromEntries(entries.filter(([id]) => !dropped.has(id)))
  }
  const retained = result === records ? entries : Object.entries(result)
  const maxChars = Math.min(16 * 1024, Math.floor(budget / (2 * Math.max(1, retained.length) * fields.length)))
  for (const [id, entry] of retained) {
    let next = entry
    for (const field of fields) {
      const value = (entry as Record<string, unknown>)[field]
      if (typeof value !== 'string' || value.length <= maxChars) continue
      if (next === entry) next = { ...entry }
      const target = next as Record<string, unknown>
      target[field] = copyChatPreview(value, maxChars)
    }
    if (next === entry) continue
    if (result === records) result = { ...records }
    result[id] = next
  }
  const memo = { budget, terminalLimit, result }
  activityCache.set(records, memo)
  activityCache.set(result, memo)
  return result
}
