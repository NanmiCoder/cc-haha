import type { ApiClient } from '../../core/client'
import { formatTokenCount } from '../../core/streamRate'
import type { TokenUsage } from '../../core/types'

/**
 * Data and text for "how much context is used now".
 *
 * There are three data sources, from most to least reliable: 
 * - live: the current context reported by the CLI in `/inspection` on the computer (what the desktop ring uses); 
 * - estimate: when the CLI is not running, the context estimated by the server from the transcript; 
 * - turn: `state.usage` already on the phone (usage at the end of the last turn). When a turn calls the model several times, 
 *   cache reads accumulate per call, so it can only be an approximation and does not trigger the amber warning.
 */

export type ContextSnapshot = {
  used: number
  /** Context window size; undefined when the server did not provide it. */
  window?: number
  categories: { name: string; tokens: number }[]
  model?: string
  /** true means a transcript estimate rather than a live CLI report. */
  estimate: boolean
}

export type SessionUsageStats = {
  /** Output tokens ÷ time the model was actually running; null without API duration. */
  tokensPerSecond: number | null
  /** Cache hit rate 0..1; null before any prompt was sent. */
  cacheHitRate: number | null
  /** Cost formatted by the server, shown as is. */
  cost?: string
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined

/** Context from `/inspection`: live first, then estimate; null if neither. */
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

/** Session totals from `/inspection?usageOnly=1`: generation speed, cache hits, cost. */
export function parseSessionUsage(raw: unknown): SessionUsageStats | null {
  const usage = record(record(raw)?.usage)
  if (!usage) return null
  const input = count(usage.totalInputTokens) ?? 0
  const output = count(usage.totalOutputTokens) ?? 0
  const cacheRead = count(usage.totalCacheReadInputTokens) ?? 0
  const cacheWrite = count(usage.totalCacheCreationInputTokens) ?? 0
  // When nothing has been produced yet, none of them can say anything true.
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

/** Fetch context and session totals in one go; the two do not hold each other back, and either failing only makes that one null. */
export async function fetchContextInspection(
  client: Pick<ApiClient, 'get'>,
  sessionId: string,
  signal?: AbortSignal
): Promise<{ snapshot: ContextSnapshot | null; stats: SessionUsageStats | null; failed: boolean }> {
  const [context, usage] = await Promise.allSettled([
    // The server caps CLI control requests at 20 seconds, so the client waits a bit longer to get the estimate fallback.
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
  /** Rounded integer percentage; undefined when window or usage is unknown. */
  percent?: number
  /** Progress bar fill 0..1 (only fills up even over the window). */
  fill: number
  tone: ContextTone
  /** The source is not a live CLI report; the number is only approximate. */
  approximate: boolean
  percentLabel?: string
  /** "Used 76k / 200k (38%)", "Used 76k", "No data yet". */
  headline: string
  /** Short phrase for the menu header: "Context 38%"; without data it is "Context usage". */
  menuLabel: string
  /** Amber warning; absent when tone is ok / unknown. */
  notice?: string
}

export const WARN_PERCENT = 80
export const FULL_PERCENT = 95

/** "Prompt usage" in the last turn's usage: input + cache read + cache write. */
export function usagePromptTokens(usage: TokenUsage | undefined): number | undefined {
  if (!usage) return undefined
  const total =
    (count(usage.input_tokens) ?? 0) + (count(usage.cache_read_tokens) ?? 0) + (count(usage.cache_creation_tokens) ?? 0)
  return total > 0 ? total : undefined
}

export function contextSummary(input: {
  snapshot?: ContextSnapshot | null
  usage?: TokenUsage
  /** Window derived from the model catalog / model id (`contextWindow(...)`), used only when the snapshot gives no window. */
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
      headline: 'No data yet',
      menuLabel: 'Context usage',
    }
  const approximate = source !== 'live'
  const raw = knownWindow ? (used / knownWindow) * 100 : undefined
  // The approximate source (last turn usage) can accumulate past the window across calls, so it is capped at 100 and never warns.
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
  const prefix = approximate ? 'about ' : ''
  const headline =
    knownWindow && percentLabel
      ? `Used ${prefix}${usedLabel} / ${formatTokenCount(knownWindow)} (${percentLabel})`
      : `Used ${prefix}${usedLabel}`
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
    menuLabel: percentLabel ? `Context ${approximate ? 'about ' : ''}${percentLabel}` : 'Context usage',
    notice:
      tone === 'full'
        ? `Context is almost full (${percentLabel}); the computer will automatically compact earlier conversation.`
        : tone === 'warn'
          ? `Context used ${percentLabel}; near the limit the computer automatically compacts earlier conversation.`
          : undefined,
  }
}

/** A row for the menu header: "Model name · context 38%"; when the model name is unavailable only context. */
export function menuContextLine(modelLabel: string | undefined, summary: ContextSummary): string {
  return [modelLabel?.trim(), summary.menuLabel].filter(Boolean).join(' · ')
}

export type UsageRow = { key: string; label: string; value: string }

/** Token breakdown of the last turn: show whichever fields exist, without making up missing ones. */
export function usageRows(usage: TokenUsage | undefined): UsageRow[] {
  if (!usage) return []
  const rows: [string, string, number | undefined][] = [
    ['input', 'Input', count(usage.input_tokens)],
    ['output', 'Output', count(usage.output_tokens)],
    ['cache_read', 'Cache read', count(usage.cache_read_tokens)],
    ['cache_creation', 'Cache write', count(usage.cache_creation_tokens)],
  ]
  return rows.flatMap(([key, label, value]) =>
    value === undefined ? [] : [{ key, label, value: formatTokenCount(value) }]
  )
}

const categoryNames: Record<string, string> = {
  'system prompt': 'System prompt',
  'system tools': 'System tools',
  'mcp tools': 'MCP Tools',
  'custom agents': 'Custom Agent',
  'memory files': 'Memory files',
  skills: 'Skills',
  messages: 'Messages',
}
/** Placeholders that take no context: free space, autocompact buffer. */
const ignoredCategories = new Set(['free space', 'autocompact buffer'])

export type CategoryRow = { key: string; label: string; value: string; fill: number }

/** Context composition: largest usage first, at most `limit` items; shares relative to the window size (or total when unknown). */
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

/** Cache hit rate: write 100% only when exactly 100%, so 99.96% cannot round to "all hits". */
export function formatCacheHit(rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0) return '0%'
  if (rate >= 1) return '100%'
  const percent = rate * 100
  const one = percent.toFixed(1)
  if (one !== '100.0') return `${one.replace(/\.0$/, '')}%`
  return '99.9%'
}
