import type { ActivityStatsResponse, DailyActivity } from '../../api/activityStats'
import type { Locale } from '../../i18n'
import { DATE_LOCALES, addDays, localDateKey } from './heatmapModel'

/** How many colors the themes define for models (`--color-series-1..5`). */
export const SERIES_COUNT = 5

/**
 * Models that get a hue of their own: slots 1-4. Slot 5 is the neutral gray every other model shares.
 * Four is what a reader can keep apart in a stack, and what the palette was validated for.
 */
export const COLORED_MODEL_SLOTS = SERIES_COUNT - 1

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

/** The first day each model has usage, from the daily series. Models never seen sort last. */
function firstSeenByModel(stats: ActivityStatsResponse | null) {
  const first = new Map<string, string>()
  for (const day of stats?.dailyModelTokens ?? []) {
    for (const [id, tokens] of Object.entries(day.tokensByModel)) {
      if (tokens <= 0) continue
      const seen = first.get(id)
      if (seen === undefined || day.date < seen) first.set(id, day.date)
    }
  }
  return first
}

/**
 * Models by total tokens, with the colors that tell them apart.
 *
 * A color belongs to a model, not to a rank: the four biggest models take the four hues in the
 * order they first appeared, so two models swapping places does not repaint either of them (a
 * reader who learned "teal is Opus" would otherwise be misled). A color only changes hands when
 * who is among the biggest four changes. Everything past the fourth folds into one gray "other"
 * row rather than reusing a hue two models would then share.
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

  const colored = rows.length <= COLORED_MODEL_SLOTS ? rows : rows.slice(0, COLORED_MODEL_SLOTS)
  const firstSeen = firstSeenByModel(stats)
  const slotById = new Map(
    [...colored]
      .sort((a, b) => (firstSeen.get(a.id) ?? '9999').localeCompare(firstSeen.get(b.id) ?? '9999') || a.id.localeCompare(b.id))
      .map((row, index) => [row.id, index + 1] as const),
  )
  const ranked: RankedModel[] = colored.map((row) => ({ ...row, series: slotById.get(row.id)! }))

  const tail = rows.slice(colored.length)
  if (tail.length > 0) {
    ranked.push({
      id: OTHER_MODELS_ID,
      label: otherLabel,
      series: SERIES_COUNT,
      total: tail.reduce((sum, row) => sum + row.total, 0),
      fresh: tail.reduce((sum, row) => sum + row.fresh, 0),
      cached: tail.reduce((sum, row) => sum + row.cached, 0),
      costUSD: tail.reduce((sum, row) => sum + row.costUSD, 0),
      unpriced: tail.some((row) => row.unpriced),
    })
  }
  return ranked
}

/**
 * Indices of `models` in the order columns stack and the legend reads: by color slot, so the stack
 * is the same shape whoever is ahead, with the gray "other" on top.
 */
export function stackOrder(models: ReadonlyArray<{ series: number }>): number[] {
  return models.map((_, index) => index).sort((a, b) => models[a]!.series - models[b]!.series || a - b)
}

export type DailyModelSeries = {
  date: string
  total: number
  /** Tokens per ranked model, same order as `rankModels`. */
  byModel: number[]
  /** The models behind that day's gray "other" tokens, biggest first, so the day can still name them. */
  otherModels: Array<{ id: string; tokens: number }>
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
    const otherModels: DailyModelSeries['otherModels'] = []
    for (const [id, tokens] of Object.entries(tokensByDate.get(date) ?? {})) {
      const ranked = indexById.get(id)
      const index = ranked ?? otherIndex
      if (index < 0) continue
      byModel[index] = (byModel[index] ?? 0) + tokens
      if (ranked === undefined && tokens > 0) otherModels.push({ id, tokens })
    }
    otherModels.sort((a, b) => b.tokens - a.tokens || a.id.localeCompare(b.id))
    return { date, total: byModel.reduce((sum, tokens) => sum + tokens, 0), byModel, otherModels }
  })
}

/** A share of a whole as a locale percentage: one decimal below 10%, where a whole number would round it to nothing. */
export function formatShare(part: number, whole: number, locale: Locale) {
  if (whole <= 0) return '0%'
  return new Intl.NumberFormat(DATE_LOCALES[locale], {
    maximumFractionDigits: part / whole < 0.1 ? 1 : 0,
    style: 'percent',
  }).format(part / whole)
}

export type DayActivity = Pick<DailyActivity, 'sessionCount' | 'messageCount' | 'toolCallCount'>

export type DayModelShare = {
  id: string
  label: string
  series: number
  tokens: number
  /** 0..1 of that day's total. */
  share: number
  /** Set on the row that sums a busy day's smallest "other" models: how many it stands for. */
  foldedCount?: number
}

/** How many of a day's "other" models are named before the rest are summed into one row. */
export const NAMED_OTHER_MODELS = 3

/**
 * Which models carried one day, biggest first. The models in the gray "other" slot are named one
 * by one, since one gray can't say which they were; past `NAMED_OTHER_MODELS` the smallest are
 * summed into a last row so the list stays short.
 */
export function dayModelShares(day: DailyModelSeries, models: RankedModel[]): DayModelShare[] {
  if (day.total <= 0) return []
  const rows: DayModelShare[] = []
  let folded: DayModelShare | null = null
  for (const [modelIndex, tokens] of day.byModel.entries()) {
    const model = models[modelIndex]
    if (!model || tokens <= 0) continue
    if (model.id !== OTHER_MODELS_ID || day.otherModels.length === 0) {
      rows.push({ id: model.id, label: model.label, series: model.series, tokens, share: tokens / day.total })
      continue
    }
    // Folding a single model would only hide its name, so a day folds two or more or none.
    const named = day.otherModels.length > NAMED_OTHER_MODELS + 1 ? day.otherModels.slice(0, NAMED_OTHER_MODELS) : day.otherModels
    for (const other of named) {
      rows.push({ id: other.id, label: formatModelName(other.id), series: model.series, tokens: other.tokens, share: other.tokens / day.total })
    }
    const foldedCount = day.otherModels.length - named.length
    if (foldedCount > 0) {
      // The slot's own total minus what was named, so the rows always add up to the day.
      const rest = tokens - named.reduce((sum, other) => sum + other.tokens, 0)
      folded = { id: model.id, label: model.label, series: model.series, tokens: rest, share: rest / day.total, foldedCount }
    }
  }
  rows.sort((a, b) => b.tokens - a.tokens)
  return folded ? [...rows, folded] : rows
}

/** What a click on one day of the stream shows: where it sits against the rest of the window, and what it was made of. */
export type DaySummary = {
  date: string
  total: number
  /** The busiest day in the window, the same one the stream labels. */
  peak: number
  /** `total / peak`, 0..1. */
  ofPeak: number
  /** Mean over the days that had any usage; idle days would drag it toward zero. */
  average: number
  /** 1 is the busiest day; ties share a rank. */
  rank: number
  activeDays: number
  /** Models that ran that day, as `dayModelShares` lists them. */
  models: DayModelShare[]
  sessionCount: number
  messageCount: number
  toolCallCount: number
}

/** `null` for a day with no usage (nothing to open) or an index outside the window. */
export function summarizeDay(
  days: DailyModelSeries[],
  index: number,
  models: RankedModel[],
  activity: ReadonlyMap<string, DayActivity>,
): DaySummary | null {
  const day = days[index]
  if (!day || day.total <= 0) return null

  const active = days.filter((candidate) => candidate.total > 0)
  const peak = Math.max(...active.map((candidate) => candidate.total))
  const counts = activity.get(day.date)

  return {
    date: day.date,
    total: day.total,
    peak,
    ofPeak: day.total / peak,
    average: active.reduce((sum, candidate) => sum + candidate.total, 0) / active.length,
    rank: 1 + active.filter((candidate) => candidate.total > day.total).length,
    activeDays: active.length,
    models: dayModelShares(day, models),
    sessionCount: counts?.sessionCount ?? 0,
    messageCount: counts?.messageCount ?? 0,
    toolCallCount: counts?.toolCallCount ?? 0,
  }
}

/** A step of 1, 2 or 5 × 10^k that gives at most four grid lines for `max`. */
export function niceStep(max: number): number {
  if (max <= 0) return 1
  const base = 10 ** Math.floor(Math.log10(max / 4))
  for (const multiple of [1, 2, 5, 10]) {
    if (max / (base * multiple) <= 4) return base * multiple
  }
  return base * 10
}

/** Room kept above the tallest column for the peak label. */
export const COLUMN_TOP_PAD = 44
/** Surface-colored gap between segments of one stacked column, in px. */
const SEGMENT_GAP = 1.5

export type ColumnGeometry = {
  width: number
  height: number
  /** One path per model with usage, bottom to top in `stackOrder`. Every day's segment of that model is in it. */
  layers: Array<{ modelIndex: number; d: string }>
  /** Grid lines at round values, for the axis labels. */
  grid: Array<{ value: number; y: number }>
  /** Where each day's column ends (px from the top); the baseline for a day with no usage. */
  dayTops: number[]
  peak: { index: number; x: number; y: number; total: number; date: string } | null
  /** First-of-month positions as a fraction of the width, centred on that day's column, for the axis row. */
  monthTicks: Array<{ fraction: number; date: string }>
}

/**
 * One column per day on a zero baseline, stacked by model. The value is the height, on one scale
 * from zero, so a day, a stretch or a model can be compared by eye; nothing is smoothed, so an idle
 * day is an empty slot rather than a dip that joins its neighbours.
 */
export function buildColumnGeometry(
  days: DailyModelSeries[],
  models: RankedModel[],
  width: number,
  height: number,
): ColumnGeometry {
  const peakValue = Math.max(...days.map((day) => day.total), 0)
  if (days.length === 0 || models.length === 0 || peakValue <= 0) {
    return { width, height, layers: [], grid: [], dayTops: [], peak: null, monthTicks: [] }
  }

  const step = niceStep(peakValue)
  const chartMax = Math.max(peakValue * 1.1, step)
  const yFor = (value: number) => height - (value / chartMax) * (height - COLUMN_TOP_PAD)
  const slot = width / days.length
  const barWidth = Math.max(slot * 0.78, 1.5)
  const order = stackOrder(models)

  const paths = models.map(() => '')
  days.forEach((day, index) => {
    const x = index * slot + (slot - barWidth) / 2
    let stacked = 0
    for (const modelIndex of order) {
      const tokens = day.byModel[modelIndex] ?? 0
      if (tokens <= 0) continue
      const top = yFor(stacked + tokens)
      const bottom = yFor(stacked)
      stacked += tokens
      const segment = bottom - top
      if (segment < 0.3) continue
      const gap = segment > 2.5 ? SEGMENT_GAP / 2 : 0
      paths[modelIndex] += `M${x.toFixed(2)} ${(top + gap).toFixed(2)}h${barWidth.toFixed(2)}V${(bottom - gap).toFixed(2)}h${(-barWidth).toFixed(2)}Z`
    }
  })

  const grid: ColumnGeometry['grid'] = []
  for (let value = step; value <= chartMax; value += step) grid.push({ value, y: yFor(value) })

  const peakIndex = days.findIndex((day) => day.total === peakValue)
  const centre = (index: number) => (index + 0.5) * slot
  return {
    width,
    height,
    layers: order.filter((modelIndex) => paths[modelIndex] !== '').map((modelIndex) => ({ modelIndex, d: paths[modelIndex]! })),
    grid,
    dayTops: days.map((day) => yFor(day.total)),
    peak: { index: peakIndex, x: centre(peakIndex), y: yFor(peakValue), total: peakValue, date: days[peakIndex]!.date },
    monthTicks: days.flatMap((day, index) => (
      day.date.endsWith('-01') ? [{ fraction: (index + 0.5) / days.length, date: day.date }] : []
    )),
  }
}
