import type { ChatItem, TokenUsage } from './types'

/**
 * Count and rate of output tokens this turn.
 *
 * Counting rule (same as desktop StreamingIndicator, except thinking text is also counted): 
 * - Count: the protocol gives no real usage before the turn ends (only `message_complete` carries it), so while running use
 *   characters of text streamed this turn ÷ 4 as an estimate; when real usage arrives (`finished`) use the real value, and the two
 *   sources are distinguished by `source`.
 * - Speed: sliding rate over the last few seconds, not a whole-turn average; returns null (hidden) with too few samples or during a pause, 
 *   does not show 0.
 */

export const CHARS_PER_TOKEN = 4
/** The rate only looks at samples within this span. */
export const RATE_WINDOW_MS = 5000
/** The first and last samples in the window must be at least this far apart before giving a rate, to avoid jumpy numbers at the start. */
export const RATE_MIN_SPAN_MS = 1000
/** No new tokens for this long counts as a pause (tool running, waiting for approval), hiding the rate. */
export const RATE_STALL_MS = 3000
const MAX_SAMPLES = 24

export type RateSample = { at: number; tokens: number }
export type TurnTokens = { tokens: number; source: 'usage' | 'estimate' }

/** Characters of text streamed by the main agent after the last user message (answer + thinking; not inside subagents). */
export function turnOutputChars(items: readonly ChatItem[]): number {
  let chars = 0
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]
    if (item.type === 'user') break
    if (item.parentToolUseId) continue
    if (item.type === 'assistant' || item.type === 'thinking') chars += item.text.length
  }
  return chars
}

export function estimateTokens(chars: number): number {
  return Number.isFinite(chars) && chars > 0 ? Math.round(chars / CHARS_PER_TOKEN) : 0
}

/** Tokens output in a turn: use real usage at the end if available, otherwise estimate from characters. */
export function turnOutputTokens(input: {
  items: readonly ChatItem[]
  finished?: Pick<TokenUsage, 'output_tokens'>
}): TurnTokens {
  const real = input.finished?.output_tokens
  if (typeof real === 'number' && Number.isFinite(real) && real > 0)
    return { tokens: Math.round(real), source: 'usage' }
  return { tokens: estimateTokens(turnOutputChars(input.items)), source: 'estimate' }
}

/**
 * Append a sample. Clock moving back, duplicate at the same instant, or token rollback (session resync, new turn starting)
 * all restart from the new sample, voiding the old window, so no negative rate is computed.
 */
export function pushRateSample(samples: readonly RateSample[], sample: RateSample): RateSample[] {
  if (!Number.isFinite(sample.at) || !Number.isFinite(sample.tokens) || sample.tokens < 0)
    return [...samples]
  const last = samples.at(-1)
  if (last && (sample.at < last.at || sample.tokens < last.tokens)) return [sample]
  const next = last && sample.at === last.at ? [...samples.slice(0, -1), sample] : [...samples, sample]
  const oldest = sample.at - (RATE_WINDOW_MS + RATE_STALL_MS)
  // Keep the oldest one until it just crosses the window, since the pause check uses it as a reference.
  let start = 0
  while (start < next.length - 1 && next[start + 1].at <= oldest) start++
  return next.slice(Math.max(start, next.length - MAX_SAMPLES))
}

/** Output rate over the last few seconds (tokens/s); returns null with insufficient data or during a pause. */
export function streamRate(samples: readonly RateSample[], now: number): number | null {
  const last = samples.at(-1)
  if (!last || !Number.isFinite(now)) return null
  // Sampler stopped (page in background, timers suspended) or clock moved back: better not to show.
  if (now < last.at || now - last.at > RATE_STALL_MS) return null
  const stallRef = [...samples].reverse().find((sample) => sample.at <= last.at - RATE_STALL_MS)
  if (stallRef && last.tokens - stallRef.tokens <= 0) return null
  const first = samples.find((sample) => sample.at >= last.at - RATE_WINDOW_MS)
  if (!first || last.at - first.at < RATE_MIN_SPAN_MS) return null
  const delta = last.tokens - first.tokens
  if (delta <= 0) return null
  return delta / ((last.at - first.at) / 1000)
}

/** 847 / 1.2k / 12k / 1.2M: drop the extra .0, and never show "1000k" when rounding up. */
export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0'
  if (value < 1000) return String(Math.round(value))
  const thousands = Number((value / 1000).toFixed(1))
  if (thousands < 1000) return `${thousands}k`
  return `${Number((value / 1_000_000).toFixed(1))}M`
}

export function formatRate(rate: number): string {
  return rate >= 10 ? String(Math.round(rate)) : rate.toFixed(1).replace(/\.0$/, '')
}

/**
 * Optional segment in the status line: `↓1.2k tokens · 38 tok/s`. Without a token count the whole segment is empty; a rate of null
 * only the rate is omitted. `compact` drops the word "tokens", for narrow screens with a command in front.
 */
export function captionTokens(input: {
  tokens?: number
  rate?: number | null
  compact?: boolean
}): string {
  const { tokens, rate, compact } = input
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) return ''
  const parts = [`↓${formatTokenCount(tokens)}${compact ? '' : ' tokens'}`]
  if (typeof rate === 'number' && Number.isFinite(rate) && rate >= 0.1)
    parts.push(`${formatRate(rate)} tok/s`)
  return parts.join(' · ')
}
