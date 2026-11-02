import type { ChatItem, TokenUsage } from './types'

/**
 * 本轮输出 token 的数量与流速。
 *
 * 口径（与桌面 StreamingIndicator 一致，只是多算了思考文字）：
 * - 数量：协议在回合结束前不给真实 usage（`message_complete` 才带），所以运行中用
 *   本轮已流出的文字字符数 ÷ 4 估算；拿到真实 usage 时（`finished`）用真实值，两者的
 *   来源用 `source` 区分。
 * - 速度：最近几秒的滑动速率，不是整轮均值；采样不足、停顿时返回 null（隐藏），
 *   不显示 0。
 */

export const CHARS_PER_TOKEN = 4
/** 速率只看最近这么长的采样。 */
export const RATE_WINDOW_MS = 5000
/** 窗口内首尾采样至少隔这么久才给速率，避免刚开始就出现跳动的数字。 */
export const RATE_MIN_SPAN_MS = 1000
/** 这么久没有新增 token 就认为停顿（工具执行、等批准），隐藏速率。 */
export const RATE_STALL_MS = 3000
const MAX_SAMPLES = 24

export type RateSample = { at: number; tokens: number }
export type TurnTokens = { tokens: number; source: 'usage' | 'estimate' }

/** 最后一条用户消息之后，主 Agent 已流出的文字字符数（回答 + 思考；子 Agent 内部的不算）。 */
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

/** 一轮已输出的 token：有结束时的真实 usage 用真实值，否则按字符数估算。 */
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
 * 追加一个采样。时钟回拨、同一时刻重复、token 回退（会话重新同步、新一轮开始）
 * 都以新采样重新开始，旧窗口作废，不会算出负速率。
 */
export function pushRateSample(samples: readonly RateSample[], sample: RateSample): RateSample[] {
  if (!Number.isFinite(sample.at) || !Number.isFinite(sample.tokens) || sample.tokens < 0)
    return [...samples]
  const last = samples.at(-1)
  if (last && (sample.at < last.at || sample.tokens < last.tokens)) return [sample]
  const next = last && sample.at === last.at ? [...samples.slice(0, -1), sample] : [...samples, sample]
  const oldest = sample.at - (RATE_WINDOW_MS + RATE_STALL_MS)
  // 最老的一条保留到刚好越过窗口，停顿判断要拿它做参照。
  let start = 0
  while (start < next.length - 1 && next[start + 1].at <= oldest) start++
  return next.slice(Math.max(start, next.length - MAX_SAMPLES))
}

/** 最近几秒的输出速率（token/秒）；数据不足或停顿时返回 null。 */
export function streamRate(samples: readonly RateSample[], now: number): number | null {
  const last = samples.at(-1)
  if (!last || !Number.isFinite(now)) return null
  // 采样器停了（页面后台、计时器被挂起）或时钟回拨：宁可不显示。
  if (now < last.at || now - last.at > RATE_STALL_MS) return null
  const stallRef = [...samples].reverse().find((sample) => sample.at <= last.at - RATE_STALL_MS)
  if (stallRef && last.tokens - stallRef.tokens <= 0) return null
  const first = samples.find((sample) => sample.at >= last.at - RATE_WINDOW_MS)
  if (!first || last.at - first.at < RATE_MIN_SPAN_MS) return null
  const delta = last.tokens - first.tokens
  if (delta <= 0) return null
  return delta / ((last.at - first.at) / 1000)
}

/** 847 / 1.2k / 12k / 1.2M：去掉多余的 .0，进位时不出现 “1000k”。 */
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
 * 状态行里的可选段：`↓1.2k tokens · 38 tok/s`。没有 token 数就整段为空；速率为 null
 * 只省略速率。`compact` 去掉 “tokens” 一词，给前面还有命令的窄屏用。
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
