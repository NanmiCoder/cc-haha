/**
 * Session-level token accounting for the context panel.
 *
 * The four buckets the CLI reports are disjoint: `input_tokens` never includes cached tokens, so
 * summing them counts each token exactly once. (Providers whose wire format folds cache hits into
 * the prompt total are adapted on the way in — see `src/server/proxy/transform/usage.ts`.) That
 * invariant is the reason this file can add first and ask questions later; a source that ever
 * reports inclusive input would silently inflate both the total and the cache hit rate.
 */

export type SessionUsageLike = {
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadInputTokens: number
  totalCacheCreationInputTokens: number
  totalDecodeDuration?: number
}

export type SessionUsageMetrics = {
  /** Every token the session moved, counting a cached token once. */
  totalTokens: number
  /** Prompt-side tokens only: the denominator a cache hit rate is meaningful against. */
  promptTokens: number
  cachedTokens: number
  /** `null` when the session has sent no prompt tokens yet. */
  cacheHitRate: number | null
  /** `null` when no decode span was reported — see below. */
  tokensPerSecond: number | null
}

function finite(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Derives the panel's headline numbers.
 *
 * `tokensPerSecond` divides output tokens by the time the model actually spent emitting them, so
 * tool execution and prefill wait are excluded. A caller that only has a transcript (no decode
 * spans) gets `null` rather than a rate computed against wall clock: dividing by a span that
 * includes 40 seconds of `Bash` would report a speed the model never ran at.
 */
export function deriveSessionUsageMetrics(usage: SessionUsageLike): SessionUsageMetrics {
  const input = finite(usage.totalInputTokens)
  const output = finite(usage.totalOutputTokens)
  const cacheRead = finite(usage.totalCacheReadInputTokens)
  const cacheWrite = finite(usage.totalCacheCreationInputTokens)
  const decodeMs = finite(usage.totalDecodeDuration)

  const promptTokens = input + cacheRead + cacheWrite
  return {
    totalTokens: promptTokens + output,
    promptTokens,
    cachedTokens: cacheRead,
    cacheHitRate: promptTokens > 0 ? cacheRead / promptTokens : null,
    tokensPerSecond: decodeMs > 0 && output > 0 ? output / (decodeMs / 1000) : null,
  }
}

/**
 * Formats a cache hit rate without ever rounding a partial hit up to a flat 100%.
 *
 * A session at 99.96% is *not* fully cached, and printing "100%" would tell the user something
 * false about both their bill and their prompt stability. Widening the precision is the honest
 * fix; only a rate that is exactly 1 renders as 100%.
 */
export function formatCacheHitRate(rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0) return '0%'
  if (rate >= 1) return '100%'
  const percent = rate * 100
  const oneDecimal = percent.toFixed(1)
  if (oneDecimal !== '100.0') return `${oneDecimal}%`
  const twoDecimals = percent.toFixed(2)
  // 99.995% and up still rounds to 100.00; floor it so the maximum shown below
  // a true hit is visibly below a true hit.
  return twoDecimals === '100.00' ? '99.99%' : `${twoDecimals}%`
}

/** `100`, `42`, `9.4` — one decimal only while the number is small enough to need it. */
export function formatTokensPerSecond(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '--'
  return value >= 10 ? `${Math.round(value)}` : `${value.toFixed(1)}`
}

/** `1.2M`, `375K`, `812` — compact enough for a stat row, never a lie about magnitude. */
export function formatCompactTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value < 1_000) return `${Math.round(value)}`
  const thousands = value / 1_000
  const decimals = thousands >= 100 ? 0 : 1
  // Rounding can push a value just under the next unit up to a full thousand of the smaller one
  // (999_949 reads as "1000K"); promote it so the row never shows four digits of a smaller unit.
  if (Number(thousands.toFixed(decimals)) >= 1_000) {
    return `${(value / 1_000_000).toFixed(1)}M`
  }
  return `${thousands.toFixed(decimals)}K`
}
