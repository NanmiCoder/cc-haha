import type { ActivityStatsResponse } from '../../api/activityStats'
import { addDays, localDateKey } from './heatmapModel'

/** How many categorical colors the themes define for models (`--color-series-1..5`). */
export const SERIES_COUNT = 5

export const OTHER_MODELS_ID = '__other__'

/** Written out in full so the token-usage guard can see each variable is defined. */
const SERIES_COLORS = [
  'var(--color-series-1)',
  'var(--color-series-2)',
  'var(--color-series-3)',
  'var(--color-series-4)',
  'var(--color-series-5)',
] as const

/** The themed color that draws a ranked model's `series` (1-based). */
export function seriesColor(series: number): string {
  return SERIES_COLORS[(Math.max(series, 1) - 1) % SERIES_COLORS.length]!
}

type ModelUsage = ActivityStatsResponse['modelUsage'][string]

export type RankedModel = {
  /** Raw model id, or `OTHER_MODELS_ID` for the folded tail. */
  id: string
  label: string
  /** 1..SERIES_COUNT: which `--color-series-N` draws this model. */
  series: number
  total: number
  /** Input + output + cache writes, i.e. what the model actually had to process. */
  fresh: number
  cached: number
  costUSD: number
  unpriced: boolean
}

export function getModelTokenTotal(usage: ModelUsage | undefined) {
  if (!usage) return 0
  return (
    (usage.inputTokens ?? 0) +
    (usage.outputTokens ?? 0) +
    (usage.cacheReadInputTokens ?? 0) +
    (usage.cacheCreationInputTokens ?? 0)
  )
}

/**
 * Tokens the model actually had to process, as opposed to prefix it read back from cache. Cache
 * reads dominate the headline total — over 90% of it on a heavy agentic workload — and bill at a
 * tenth of input, so the raw total on its own says very little about what was spent.
 */
export function getFreshTokenTotal(usage: ModelUsage | undefined) {
  if (!usage) return 0
  return (
    (usage.inputTokens ?? 0) +
    (usage.outputTokens ?? 0) +
    (usage.cacheCreationInputTokens ?? 0)
  )
}

const ACRONYMS = new Set(['gpt', 'glm'])

/**
 * "claude-opus-5-5-20260101" → "Opus 5.5". The vendor prefix and a trailing
 * build date say nothing a reader needs, and a version split on hyphens
 * ("5 5") reads as two numbers rather than one.
 */
export function formatModelName(model: string) {
  const parts = model
    .replace(/^claude-/i, '')
    .replace(/-\d{8}$/, '')
    .split('-')
    .filter(Boolean)

  const words: string[] = []
  for (const part of parts) {
    const previous = words[words.length - 1]
    if (/^\d{1,2}$/.test(part) && previous !== undefined && /^\d{1,2}(\.\d{1,2})*$/.test(previous)) {
      words[words.length - 1] = `${previous}.${part}`
    } else {
      words.push(part)
    }
  }

  return words
    .map((word) => (ACRONYMS.has(word.toLowerCase()) ? word.toUpperCase() : word.replace(/^\w/, (char) => char.toUpperCase())))
    .join(' ')
}

/**
 * Models by total tokens, each assigned one of the five series colors. A sixth
 * model has no color of its own, so everything past the fourth folds into one
 * "other" row rather than reusing a color two models would then share.
 */
export function rankModels(stats: ActivityStatsResponse | null, otherLabel: string): RankedModel[] {
  const unpriced = new Set(stats?.unpricedModels ?? [])
  const rows = Object.entries(stats?.modelUsage ?? {})
    .map(([id, usage]) => ({
      id,
      label: formatModelName(id),
      total: getModelTokenTotal(usage),
      fresh: getFreshTokenTotal(usage),
      cached: usage.cacheReadInputTokens ?? 0,
      costUSD: usage.costUSD ?? 0,
      unpriced: unpriced.has(id),
    }))
    .filter((row) => row.total > 0)
    .sort((a, b) => b.total - a.total || a.id.localeCompare(b.id))

  if (rows.length <= SERIES_COUNT) {
    return rows.map((row, index) => ({ ...row, series: index + 1 }))
  }

  const head = rows.slice(0, SERIES_COUNT - 1).map((row, index) => ({ ...row, series: index + 1 }))
  const tail = rows.slice(SERIES_COUNT - 1)
  return [
    ...head,
    {
      id: OTHER_MODELS_ID,
      label: otherLabel,
      series: SERIES_COUNT,
      total: tail.reduce((sum, row) => sum + row.total, 0),
      fresh: tail.reduce((sum, row) => sum + row.fresh, 0),
      cached: tail.reduce((sum, row) => sum + row.cached, 0),
      costUSD: tail.reduce((sum, row) => sum + row.costUSD, 0),
      unpriced: tail.some((row) => row.unpriced),
    },
  ]
}

export type DailyModelSeries = {
  date: string
  total: number
  /** Tokens per ranked model, same order as `rankModels`. */
  byModel: number[]
}

/** The trailing `dayCount` days ending `today`, zero-filled, split by ranked model. */
export function buildDailyModelSeries(
  stats: ActivityStatsResponse | null,
  models: RankedModel[],
  dayCount: number,
  today: Date,
): DailyModelSeries[] {
  const indexById = new Map(models.map((model, index) => [model.id, index]))
  const otherIndex = models.findIndex((model) => model.id === OTHER_MODELS_ID)
  const tokensByDate = new Map((stats?.dailyModelTokens ?? []).map((day) => [day.date, day.tokensByModel]))

  const end = new Date(today)
  end.setHours(0, 0, 0, 0)
  return Array.from({ length: dayCount }, (_, offset) => {
    const date = localDateKey(addDays(end, offset - (dayCount - 1)))
    const byModel = models.map(() => 0)
    for (const [id, tokens] of Object.entries(tokensByDate.get(date) ?? {})) {
      const index = indexById.get(id) ?? otherIndex
      if (index >= 0) byModel[index] = (byModel[index] ?? 0) + tokens
    }
    return { date, total: byModel.reduce((sum, tokens) => sum + tokens, 0), byModel }
  })
}

export type StreamGeometry = {
  width: number
  height: number
  /** One closed path per model, bottom to top. */
  layers: Array<{ modelIndex: number; d: string }>
  peak: { index: number; x: number; y: number; total: number; date: string } | null
  /** First-of-month positions as a fraction of the width, for the axis row. */
  monthTicks: Array<{ fraction: number; date: string }>
}

const SMOOTH_RADIUS = 2

function smoothed(values: number[]) {
  return values.map((_, index) => {
    let sum = 0
    let count = 0
    for (let offset = -SMOOTH_RADIUS; offset <= SMOOTH_RADIUS; offset += 1) {
      const value = values[index + offset]
      if (value === undefined) continue
      sum += value
      count += 1
    }
    return sum / count
  })
}

/** Cubic path through points with the control handles at each segment's midpoint in x. */
function curveThrough(points: Array<[number, number]>) {
  const first = points[0]
  if (!first) return ''
  let path = `M${first[0].toFixed(1)} ${first[1].toFixed(1)}`
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!
    const current = points[index]!
    const midX = (previous[0] + current[0]) / 2
    path += ` C${midX.toFixed(1)} ${previous[1].toFixed(1)} ${midX.toFixed(1)} ${current[1].toFixed(1)} ${current[0].toFixed(1)} ${current[1].toFixed(1)}`
  }
  return path
}

/**
 * A centred stream: every day's stack is as thick as that day's (smoothed)
 * total, split by model share, and the stack sits on the vertical midline. The
 * shape carries rhythm and mix, not a readable scale, so the peak is labelled
 * with its real number instead.
 */
export function buildStreamGeometry(days: DailyModelSeries[], width: number, height: number): StreamGeometry {
  const modelCount = days[0]?.byModel.length ?? 0
  const maxTotal = Math.max(...days.map((day) => day.total), 0)
  if (days.length < 2 || modelCount === 0 || maxTotal <= 0) {
    return { width, height, layers: [], peak: null, monthTicks: [] }
  }

  const smoothTotals = smoothed(days.map((day) => day.total))
  const scale = (height * 0.92) / Math.max(...smoothTotals)
  const mid = height / 2
  const xAt = (index: number) => (index / (days.length - 1)) * width

  // Per day, per model: [top, bottom] in px.
  const stacks = days.map((day, index) => {
    const thickness = smoothTotals[index]! * scale
    let y = mid - thickness / 2
    return day.byModel.map((tokens) => {
      const share = day.total > 0 ? tokens / day.total : 0
      const top = y
      y += thickness * share
      return [top, y] as const
    })
  })

  const layers = Array.from({ length: modelCount }, (_, modelIndex) => {
    const upper = stacks.map((stack, index) => [xAt(index), stack[modelIndex]![0]] as [number, number])
    const lower = stacks.map((stack, index) => [xAt(index), stack[modelIndex]![1]] as [number, number]).reverse()
    const lowerPath = curveThrough(lower).replace(/^M/, 'L')
    return { modelIndex, d: `${curveThrough(upper)} ${lowerPath} Z` }
  })

  const peakIndex = days.reduce((best, day, index) => (day.total > days[best]!.total ? index : best), 0)
  const peakDay = days[peakIndex]!
  const peak = {
    index: peakIndex,
    x: xAt(peakIndex),
    y: stacks[peakIndex]![0]![0],
    total: peakDay.total,
    date: peakDay.date,
  }

  const monthTicks = days.flatMap((day, index) => (
    day.date.endsWith('-01') ? [{ fraction: index / (days.length - 1), date: day.date }] : []
  ))

  return { width, height, layers, peak, monthTicks }
}
