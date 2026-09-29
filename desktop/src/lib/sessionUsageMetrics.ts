/**
 * Session-level token accounting for the context panel.
 *
 * The four buckets the CLI reports are disjoint: `input_tokens` never includes cached tokens, so
 * summing them counts each token exactly once. (Providers whose wire format folds cache hits into
 * the prompt total are adapted on the way in — see `src/server/proxy/transform/usage.ts`.)
 *
 * The headline number is *new* tokens (uncached input + output), not every cache hit replayed
 * across a long agent loop. Counting cache reads as spend made a 270k-window session look like
 * 40M "total tokens" — the same prompt billed once per tool round.
 */

export type SessionUsageLike = {
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadInputTokens: number
  totalCacheCreationInputTokens: number
  totalDecodeDuration?: number
  totalAPIDuration?: number
  /**
   * Output tokens of exactly the calls `totalDecodeDuration` covers. Absent/0 for
   * transcript-sourced usage and for snapshots written before the pairing existed.
   */
  totalTimedOutputTokens?: number
}

export type SessionUsageMetrics = {
  /**
   * Uncached input + output. Cache hits are not spend — they are the same prompt seen again —
   * so they stay out of this number.
   */
  totalTokens: number
  /** Prompt-side tokens only: the denominator a cache hit rate is meaningful against. */
  promptTokens: number
  cachedTokens: number
  /** `null` when the session has sent no prompt tokens yet. */
  cacheHitRate: number | null
  /**
   * Output tokens per second of actual generation.
   *
   * Numerator and denominator must describe the **same calls**. The decode-only span
   * excludes the first-token wait, so it is the better denominator — but it is only
   * produced by streamed responses that reached `message_stop`. A session whose calls were
   * served by the non-streaming fallback (or whose streams were truncated) still counts
   * their tokens in `totalOutputTokens` while contributing no span at all, so
   * `totalOutputTokens / totalDecodeDuration` can read hundreds of times too high
   * (observed: 6044 tok/s on a fallback-heavy session).
   *
   * So the decode rate is computed over `totalTimedOutputTokens` — the tokens the same
   * calls reported — and the API span is used (over every call's tokens) only when no
   * decode span exists at all. `null` when neither duration was reported.
   */
  tokensPerSecond: number | null
}

function finite(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Derives the panel's headline numbers.
 *
 * `tokensPerSecond` is generation speed over the calls that measured a span, so a session
 * that partly fell back to non-streaming reads as the rate the model actually ran at
 * instead of dividing every token by the few measured seconds. See the field's doc for why
 * the numerator is not simply `totalOutputTokens`.
 */
export function deriveSessionUsageMetrics(usage: SessionUsageLike): SessionUsageMetrics {
  const input = finite(usage.totalInputTokens)
  const output = finite(usage.totalOutputTokens)
  const cacheRead = finite(usage.totalCacheReadInputTokens)
  const cacheWrite = finite(usage.totalCacheCreationInputTokens)
  const decodeMs = finite(usage.totalDecodeDuration)
  const apiMs = finite(usage.totalAPIDuration)
  const timedOutput = finite(usage.totalTimedOutputTokens)

  const promptTokens = input + cacheRead + cacheWrite
  return {
    totalTokens: input + output,
    promptTokens,
    cachedTokens: cacheRead,
    cacheHitRate: promptTokens > 0 ? cacheRead / promptTokens : null,
    tokensPerSecond: generationSpeed({ output, timedOutput, decodeMs, apiMs }),
  }
}

function generationSpeed({
  output,
  timedOutput,
  decodeMs,
  apiMs,
}: {
  output: number
  timedOutput: number
  decodeMs: number
  apiMs: number
}): number | null {
  // Paired numerator/denominator: the tokens those same calls reported over the span they
  // spent emitting them.
  if (decodeMs > 0 && timedOutput > 0) return timedOutput / (decodeMs / 1000)
  // No decode span anywhere (a transcript, or a session served entirely by the non-streaming
  // fallback): the API clock covers every call, so it is the only denominator that matches
  // the session-wide token total. It includes the first-token wait and so reads low, which
  // is the honest number when no generation span exists.
  if (apiMs > 0 && output > 0) return output / (apiMs / 1000)
  return null
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

/**
 * Request-level (latest-turn) cache hit rate, from the newest assistant usage.
 *
 * Unlike the session-cumulative `cacheHitRate` (which dilutes the ratio across a long agent
 * loop as earlier prompts are replayed), this reads the *most recent* turn only: cache reads as a
 * fraction of that turn's total prompt (fresh input + cache write + cache read). A long-running
 * session therefore reads as the cache actually performs turn-over-turn (~99%), not ~0.5%.
 *
 * Returns `null` when the turn produced no prompt tokens (no honest answer).
 */
export function latestTurnCacheHitRate(usage: {
  input_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
}): number | null {
  const input = finite(usage.input_tokens)
  const cacheRead = finite(usage.cache_read_input_tokens)
  const cacheWrite = finite(usage.cache_creation_input_tokens)
  const promptTokens = input + cacheRead + cacheWrite
  return promptTokens > 0 ? cacheRead / promptTokens : null
}

/** Fixed display-only FX rate for the USD/CNY dual cost readout (not a billing conversion). */
export const CNY_PER_USD = 7.2

/**
 * `¥8.86` / `¥0.0036` — mirrors the server's USD formatting rules (2dp above ¥0.5, else 4dp) so
 * the two currencies read at the same precision next to each other.
 */
export function formatCnyCost(usd: number): string {
  const cny = usd * CNY_PER_USD
  return `¥${cny > 0.5 ? (Math.round(cny * 100) / 100).toFixed(2) : cny.toFixed(4)}`
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
