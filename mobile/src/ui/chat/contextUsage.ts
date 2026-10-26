import type { ApiClient } from '../../core/client'
import { formatTokenCount } from '../../core/streamRate'
import type { TokenUsage } from '../../core/types'

/**
 * “当前上下文用了多少”的数据与文案。
 *
 * 数据来源有三种，可信度从高到低：
 * - live：电脑端 `/inspection` 里 CLI 报告的当前上下文（桌面环形用的就是它）；
 * - estimate：CLI 没在跑时，服务端按 transcript 估出来的上下文；
 * - turn：手机已有的 `state.usage`（最近一轮结束时的用量）。一轮里多次调用模型时，
 *   缓存读取会按次数累加，所以它只能当近似值，不触发琥珀提示。
 */

export type ContextSnapshot = {
  used: number
  /** 上下文窗口大小；服务端没给时为 undefined。 */
  window?: number
  categories: { name: string; tokens: number }[]
  model?: string
  /** true 表示是 transcript 估算而不是 CLI 实时报告。 */
  estimate: boolean
}

export type SessionUsageStats = {
  /** 输出 token ÷ 模型实际在跑的时间；没有 API 时长就是 null。 */
  tokensPerSecond: number | null
  /** 缓存命中率 0..1；还没发过提示就是 null。 */
  cacheHitRate: number | null
  /** 服务端格式化好的费用，原样显示。 */
  cost?: string
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined

/** 取 `/inspection` 里的上下文：实时优先，其次估算；都没有就是 null。 */
export function parseContextInspection(raw: unknown): ContextSnapshot | null {
  const body = record(raw)
  if (!body) return null
  const live = record(body.context)
  const estimate = record(body.contextEstimate)
  const source = live ?? estimate
  if (!source) return null
  const used = count(source.totalTokens)
  if (used === undefined) return null
  const window = [count(source.rawMaxTokens), count(source.maxTokens)].find((value) => value && value > 0)
  const categories = Array.isArray(source.categories)
    ? source.categories.flatMap((entry) => {
        const category = record(entry)
        const tokens = count(category?.tokens)
        return category && typeof category.name === 'string' && tokens !== undefined
          ? [{ name: category.name, tokens, deferred: category.isDeferred === true }]
          : []
      })
    : []
  return {
    used,
    window,
    categories: categories.filter((c) => !c.deferred).map(({ name, tokens }) => ({ name, tokens })),
    model: typeof source.model === 'string' && source.model.trim() ? source.model.trim() : undefined,
    estimate: !live,
  }
}

/** 取 `/inspection?usageOnly=1` 里的会话累计：生成速度、缓存命中、费用。 */
export function parseSessionUsage(raw: unknown): SessionUsageStats | null {
  const usage = record(record(raw)?.usage)
  if (!usage) return null
  const input = count(usage.totalInputTokens) ?? 0
  const output = count(usage.totalOutputTokens) ?? 0
  const cacheRead = count(usage.totalCacheReadInputTokens) ?? 0
  const cacheWrite = count(usage.totalCacheCreationInputTokens) ?? 0
  // 什么都还没产生时，任何一项都说不出真话。
  if (input + output + cacheRead + cacheWrite === 0) return null
  const prompt = input + cacheRead + cacheWrite
  const apiMs = count(usage.totalAPIDuration) ?? 0
  const cost = typeof usage.costDisplay === 'string' && usage.costDisplay.trim() ? usage.costDisplay.trim() : undefined
  return {
    tokensPerSecond: apiMs > 0 && output > 0 ? output / (apiMs / 1000) : null,
    cacheHitRate: prompt > 0 ? cacheRead / prompt : null,
    cost,
  }
}

const inspectionPath = (sessionId: string, query: string) =>
  `/api/sessions/${encodeURIComponent(sessionId)}/inspection?${query}`

/** 一次拉取上下文与会话累计；两路互不拖累，任何一路失败都只是那一路为 null。 */
export async function fetchContextInspection(
  client: Pick<ApiClient, 'get'>,
  sessionId: string,
  signal?: AbortSignal
): Promise<{ snapshot: ContextSnapshot | null; stats: SessionUsageStats | null; failed: boolean }> {
  const [context, usage] = await Promise.allSettled([
    // 服务端给 CLI 的控制请求上限是 20 秒，客户端等得比它久一点才拿得到估算兜底。
    client.get<unknown>(inspectionPath(sessionId, 'includeContext=1&contextOnly=1'), { signal, timeoutMs: 30_000 }),
    client.get<unknown>(inspectionPath(sessionId, 'includeContext=0&usageOnly=1'), { signal, timeoutMs: 10_000 }),
  ])
  return {
    snapshot: context.status === 'fulfilled' ? parseContextInspection(context.value) : null,
    stats: usage.status === 'fulfilled' ? parseSessionUsage(usage.value) : null,
    failed: context.status === 'rejected' && usage.status === 'rejected',
  }
}

export type ContextTone = 'ok' | 'warn' | 'full' | 'unknown'
export type ContextSource = 'live' | 'estimate' | 'turn'

export type ContextSummary = {
  source: ContextSource | null
  used?: number
  window?: number
  /** 四舍五入的整数百分比；窗口或用量未知时为 undefined。 */
  percent?: number
  /** 进度条填充 0..1（超过窗口也只填满）。 */
  fill: number
  tone: ContextTone
  /** 来源不是 CLI 实时报告，数字只是近似。 */
  approximate: boolean
  percentLabel?: string
  /** “已用 76k / 200k（38%）”“已用 76k”“暂无数据”。 */
  headline: string
  /** 菜单头部用的短句：“上下文 38%”；没有数据就是“上下文用量”。 */
  menuLabel: string
  /** 琥珀提示；tone 为 ok / unknown 时没有。 */
  notice?: string
}

export const WARN_PERCENT = 80
export const FULL_PERCENT = 95

/** 最近一轮结束时 usage 里的“占用提示词”：输入 + 缓存读取 + 缓存写入。 */
export function usagePromptTokens(usage: TokenUsage | undefined): number | undefined {
  if (!usage) return undefined
  const total =
    (count(usage.input_tokens) ?? 0) + (count(usage.cache_read_tokens) ?? 0) + (count(usage.cache_creation_tokens) ?? 0)
  return total > 0 ? total : undefined
}

export function contextSummary(input: {
  snapshot?: ContextSnapshot | null
  usage?: TokenUsage
  /** 模型目录 / 模型 id 推出的窗口（`contextWindow(...)`），快照没给窗口时才用。 */
  window?: number
}): ContextSummary {
  const { snapshot, usage } = input
  const source: ContextSource | null = snapshot ? (snapshot.estimate ? 'estimate' : 'live') : usagePromptTokens(usage) !== undefined ? 'turn' : null
  const used = snapshot ? snapshot.used : usagePromptTokens(usage)
  const knownWindow = [snapshot?.window, input.window].find((value) => typeof value === 'number' && value > 0)
  if (used === undefined || source === null)
    return {
      source: null,
      window: knownWindow,
      fill: 0,
      tone: 'unknown',
      approximate: false,
      headline: '暂无数据',
      menuLabel: '上下文用量',
    }
  const approximate = source !== 'live'
  const raw = knownWindow ? (used / knownWindow) * 100 : undefined
  // 近似来源（最近一轮 usage）可能被多次调用累加到超过窗口，封顶 100，也不触发警告。
  const bounded = raw === undefined ? undefined : source === 'turn' ? Math.min(100, raw) : raw
  const percent = bounded === undefined ? undefined : Math.round(bounded)
  const percentLabel =
    bounded === undefined ? undefined : used > 0 && bounded < 1 ? '<1%' : `${percent}%`
  const tone: ContextTone =
    percent === undefined
      ? 'unknown'
      : source === 'turn'
        ? 'ok'
        : percent >= FULL_PERCENT
          ? 'full'
          : percent >= WARN_PERCENT
            ? 'warn'
            : 'ok'
  const usedLabel = formatTokenCount(used)
  const prefix = approximate ? '约 ' : ' '
  const headline =
    knownWindow && percentLabel
      ? `已用${prefix}${usedLabel} / ${formatTokenCount(knownWindow)}（${percentLabel}）`
      : `已用${prefix}${usedLabel}`
  return {
    source,
    used,
    window: knownWindow,
    percent,
    fill: bounded === undefined ? 0 : Math.max(0, Math.min(1, bounded / 100)),
    tone,
    approximate,
    percentLabel,
    headline,
    menuLabel: percentLabel ? `上下文${approximate ? '约 ' : ' '}${percentLabel}` : '上下文用量',
    notice:
      tone === 'full'
        ? `上下文几乎已满（${percentLabel}），电脑会自动压缩较早的对话。`
        : tone === 'warn'
          ? `上下文已用 ${percentLabel}，接近上限时电脑会自动压缩较早的对话。`
          : undefined,
  }
}

/** 菜单头部的一行：“模型名 · 上下文 38%”；模型名取不到就只有上下文。 */
export function menuContextLine(modelLabel: string | undefined, summary: ContextSummary): string {
  return [modelLabel?.trim(), summary.menuLabel].filter(Boolean).join(' · ')
}

export type UsageRow = { key: string; label: string; value: string }

/** 最近一轮的 token 明细：有哪个字段就显示哪个，没有的不编。 */
export function usageRows(usage: TokenUsage | undefined): UsageRow[] {
  if (!usage) return []
  const rows: [string, string, number | undefined][] = [
    ['input', '输入', count(usage.input_tokens)],
    ['output', '输出', count(usage.output_tokens)],
    ['cache_read', '缓存读取', count(usage.cache_read_tokens)],
    ['cache_creation', '缓存写入', count(usage.cache_creation_tokens)],
  ]
  return rows.flatMap(([key, label, value]) =>
    value === undefined ? [] : [{ key, label, value: formatTokenCount(value) }]
  )
}

const categoryNames: Record<string, string> = {
  'system prompt': '系统提示',
  'system tools': '系统工具',
  'mcp tools': 'MCP 工具',
  'custom agents': '自定义 Agent',
  'memory files': '记忆文件',
  skills: '技能',
  messages: '对话消息',
}
/** 不占用上下文的占位项：剩余空间、自动压缩预留。 */
const ignoredCategories = new Set(['free space', 'autocompact buffer'])

export type CategoryRow = { key: string; label: string; value: string; fill: number }

/** 上下文构成：按占用从大到小，最多 `limit` 项；占比相对窗口大小（未知则相对总量）。 */
export function categoryRows(snapshot: ContextSnapshot | null | undefined, limit = 6): CategoryRow[] {
  if (!snapshot) return []
  const rows = snapshot.categories
    .filter((category) => category.tokens > 0 && !ignoredCategories.has(category.name.toLowerCase()))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, limit)
  const base = snapshot.window ?? snapshot.used
  return rows.map((category) => ({
    key: category.name,
    label: categoryNames[category.name.toLowerCase()] ?? category.name,
    value: formatTokenCount(category.tokens),
    fill: base > 0 ? Math.max(0.01, Math.min(1, category.tokens / base)) : 0,
  }))
}

/** 缓存命中率：只有恰好 100% 才写 100%，99.96% 不能被四舍五入成“全命中”。 */
export function formatCacheHit(rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0) return '0%'
  if (rate >= 1) return '100%'
  const percent = rate * 100
  const one = percent.toFixed(1)
  if (one !== '100.0') return `${one.replace(/\.0$/, '')}%`
  return '99.9%'
}
