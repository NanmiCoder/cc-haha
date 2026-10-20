import { describe, expect, it } from 'vitest'

import type { ActivityStatsResponse } from '../../api/activityStats'
import {
  COLORED_MODEL_SLOTS,
  COLUMN_TOP_PAD,
  OTHER_MODELS_ID,
  formatModelName,
  SERIES_COUNT,
  buildDailyModelSeries,
  buildColumnGeometry,
  dayModelShares,
  formatShare,
  getFreshTokenTotal,
  getModelTokenTotal,
  NAMED_OTHER_MODELS,
  rankModels,
  stackOrder,
  summarizeDay,
} from './usageModel'

function statsWith(overrides: Partial<ActivityStatsResponse>): ActivityStatsResponse {
  return {
    range: 'all',
    generatedAt: '2026-10-17T12:00:00.000Z',
    totalSessions: 0,
    totalMessages: 0,
    totalDays: 0,
    activeDays: 0,
    streaks: { currentStreak: 0, longestStreak: 0, currentStreakStart: null, longestStreakStart: null, longestStreakEnd: null },
    dailyActivity: [],
    dailyModelTokens: [],
    longestSession: null,
    modelUsage: {},
    toolUsage: {},
    skillUsage: {},
    firstSessionDate: null,
    lastSessionDate: null,
    peakActivityDay: null,
    peakActivityHour: null,
    totalSpeculationTimeSavedMs: 0,
    ...overrides,
  }
}

const usage = (input: number, cacheRead = 0) => ({ inputTokens: input, outputTokens: 0, cacheReadInputTokens: cacheRead })

describe('token totals', () => {
  it('counts cache reads in the total but not in the fresh figure', () => {
    const modelUsage = { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 100, cacheCreationInputTokens: 7 }
    expect(getModelTokenTotal(modelUsage)).toBe(122)
    expect(getFreshTokenTotal(modelUsage)).toBe(22)
    expect(getModelTokenTotal(undefined)).toBe(0)
  })
})

describe('formatModelName', () => {
  it('reads like the name people say', () => {
    expect(formatModelName('claude-opus-5-5')).toBe('Opus 5.5')
    expect(formatModelName('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5')
    expect(formatModelName('claude-sonnet')).toBe('Sonnet')
    expect(formatModelName('deepseek-v4-flash')).toBe('Deepseek V4 Flash')
    expect(formatModelName('glm-4.6')).toBe('GLM 4.6')
    expect(formatModelName('gpt-5-codex')).toBe('GPT 5 Codex')
    expect(formatModelName('kimi-k3')).toBe('Kimi K3')
  })
})

describe('rankModels', () => {
  it('lists models by total tokens, each with a color slot of its own', () => {
    const ranked = rankModels(statsWith({
      modelUsage: { 'small-model': usage(10), 'big-model': usage(900), 'idle-model': usage(0) },
    }), 'Other')

    expect(ranked.map((model) => model.id)).toEqual(['big-model', 'small-model'])
    expect(new Set(ranked.map((model) => model.series)).size).toBe(2)
  })

  it('hands the hues out in the order the models first appeared, not in the order of their totals', () => {
    const stats = statsWith({
      modelUsage: { late: usage(900), early: usage(50), middle: usage(300) },
      dailyModelTokens: [
        { date: '2026-08-01', tokensByModel: { early: 20 } },
        { date: '2026-09-01', tokensByModel: { middle: 10, early: 30 } },
        { date: '2026-10-01', tokensByModel: { late: 900 } },
      ],
    })
    const slots = Object.fromEntries(rankModels(stats, 'Other').map((model) => [model.id, model.series]))
    expect(slots).toEqual({ early: 1, middle: 2, late: 3 })
  })

  it('keeps a model\'s color when another model overtakes it', () => {
    const daily: Array<{ date: string; tokensByModel: Record<string, number> }> = [
      { date: '2026-08-01', tokensByModel: { a: 10 } },
      { date: '2026-09-01', tokensByModel: { b: 10 } },
    ]
    const before = rankModels(statsWith({ modelUsage: { a: usage(900), b: usage(100) }, dailyModelTokens: daily }), 'Other')
    // b has since been used far more than a. By rank each would trade colors; by model neither does.
    const after = rankModels(statsWith({ modelUsage: { a: usage(900), b: usage(5000) }, dailyModelTokens: daily }), 'Other')

    expect(after.map((model) => model.id)).toEqual(['b', 'a'])
    const slotOf = (ranked: typeof before, id: string) => ranked.find((model) => model.id === id)!.series
    expect(slotOf(after, 'a')).toBe(slotOf(before, 'a'))
    expect(slotOf(after, 'b')).toBe(slotOf(before, 'b'))
  })

  it('does not repaint the four colored models when a smaller fifth one appears', () => {
    const base = Object.fromEntries(['m1', 'm2', 'm3', 'm4'].map((id, index) => [id, usage(1000 - index * 100)]))
    const daily = ['m1', 'm2', 'm3', 'm4', 'm5'].map((id, index) => ({ date: `2026-0${index + 1}-01`, tokensByModel: { [id]: 1 } }))
    const four = rankModels(statsWith({ modelUsage: base, dailyModelTokens: daily }), 'Other')
    const five = rankModels(statsWith({ modelUsage: { ...base, m5: usage(10) }, dailyModelTokens: daily }), 'Other')

    for (const model of four) expect(five.find((other) => other.id === model.id)!.series).toBe(model.series)
    expect(five.at(-1)).toMatchObject({ id: OTHER_MODELS_ID, series: SERIES_COUNT, total: 10 })
  })

  it('folds everything past the fourth biggest model into one gray "other" row so no hue is shared', () => {
    const modelUsage = Object.fromEntries(
      Array.from({ length: 7 }, (_, index) => [`model-${index}`, { ...usage(1000 - index * 100), costUSD: 1 }]),
    )
    const ranked = rankModels(statsWith({ modelUsage, unpricedModels: ['model-6'] }), 'Other models')

    expect(ranked).toHaveLength(COLORED_MODEL_SLOTS + 1)
    expect(ranked.slice(0, COLORED_MODEL_SLOTS).map((model) => model.id)).toEqual(['model-0', 'model-1', 'model-2', 'model-3'])
    expect(ranked.map((model) => model.series).sort()).toEqual([1, 2, 3, 4, SERIES_COUNT])
    const other = ranked[COLORED_MODEL_SLOTS]!
    expect(other.id).toBe(OTHER_MODELS_ID)
    expect(other.label).toBe('Other models')
    expect(other.total).toBe(600 + 500 + 400)
    expect(other.costUSD).toBe(3)
    // One unpriced member makes the folded cost a floor.
    expect(other.unpriced).toBe(true)
  })

  it('returns nothing for a profile with no usage', () => {
    expect(rankModels(null, 'Other')).toEqual([])
  })
})

describe('stackOrder', () => {
  it('follows the color slots, so the stack keeps its shape and the gray "other" ends on top', () => {
    expect(stackOrder([{ series: 3 }, { series: 1 }, { series: SERIES_COUNT }, { series: 2 }])).toEqual([1, 3, 0, 2])
  })
})

describe('buildDailyModelSeries', () => {
  const stats = statsWith({
    modelUsage: { a: usage(100), b: usage(50) },
    dailyModelTokens: [
      { date: '2026-10-16', tokensByModel: { a: 30, b: 10 } },
      { date: '2026-10-17', tokensByModel: { a: 5, 'unranked-model': 7 } },
    ],
  })

  it('zero-fills the trailing window and ends on today', () => {
    const models = rankModels(stats, 'Other')
    const series = buildDailyModelSeries(stats, models, 4, new Date('2026-10-17T12:00:00'))

    expect(series.map((day) => day.date)).toEqual(['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17'])
    expect(series[0]).toEqual({ date: '2026-10-14', total: 0, byModel: [0, 0], otherModels: [] })
    expect(series[2]).toEqual({ date: '2026-10-16', total: 40, byModel: [30, 10], otherModels: [] })
  })

  it('drops models that are not ranked when no "other" row exists to receive them', () => {
    const models = rankModels(stats, 'Other')
    const series = buildDailyModelSeries(stats, models, 1, new Date('2026-10-17T12:00:00'))
    expect(series[0]).toEqual({ date: '2026-10-17', total: 5, byModel: [5, 0], otherModels: [] })
  })

  it('keeps the names behind each day\'s "other" tokens, biggest first', () => {
    const tail = statsWith({
      modelUsage: { m1: usage(900), m2: usage(800), m3: usage(700), m4: usage(600), small: usage(5), tiny: usage(3) },
      dailyModelTokens: [{ date: '2026-10-17', tokensByModel: { m1: 10, tiny: 3, small: 5, idle: 0 } }],
    })
    const models = rankModels(tail, 'Other')
    const [day] = buildDailyModelSeries(tail, models, 1, new Date('2026-10-17T12:00:00'))

    expect(day!.otherModels).toEqual([{ id: 'small', tokens: 5 }, { id: 'tiny', tokens: 3 }])
    expect(day!.byModel[models.findIndex((model) => model.id === OTHER_MODELS_ID)]).toBe(8)
    expect(day!.total).toBe(18)
  })
})

describe('dayModelShares', () => {
  const model = (id: string, series: number) => ({
    id,
    label: id === OTHER_MODELS_ID ? 'Other' : id.toUpperCase(),
    series,
    total: 1,
    fresh: 0,
    cached: 0,
    costUSD: 0,
    unpriced: false,
  })
  const models = [model('a', 1), model('b', 2), model(OTHER_MODELS_ID, SERIES_COUNT)]
  const day = (byModel: number[], otherModels: Array<{ id: string; tokens: number }>) => ({
    date: '2026-10-17',
    total: byModel.reduce((sum, tokens) => sum + tokens, 0),
    byModel,
    otherModels,
  })
  const tail = (...tokens: number[]) => tokens.map((amount, index) => ({ id: `m${index + 1}`, tokens: amount }))
  const sum = (rows: Array<{ tokens: number }>) => rows.reduce((total, row) => total + row.tokens, 0)

  it('names each model behind the gray "other" slot, in gray, ranked by size among the rest', () => {
    const rows = dayModelShares(day([25, 0, 75], [{ id: 'glm-4.6', tokens: 45 }, { id: 'kimi-k2', tokens: 30 }]), models)
    expect(rows.map((row) => [row.id, row.label, row.series, row.tokens, row.share])).toEqual([
      ['glm-4.6', 'GLM 4.6', SERIES_COUNT, 45, 0.45],
      ['kimi-k2', 'Kimi K2', SERIES_COUNT, 30, 0.3],
      ['a', 'A', 1, 25, 0.25],
    ])
  })

  it('sums the smallest "other" models into one last row past the named few, and still adds up to the day', () => {
    const busy = day([5, 0, 100], tail(40, 30, 20, 6, 4))
    const rows = dayModelShares(busy, models)

    expect(rows.map((row) => [row.label, row.tokens, row.foldedCount])).toEqual([
      ['M1', 40, undefined],
      ['M2', 30, undefined],
      ['M3', 20, undefined],
      ['A', 5, undefined],
      // Bigger than A, but it stands for the leftovers, so it closes the list.
      ['Other', 10, 2],
    ])
    expect(rows.filter((row) => row.id.startsWith('m'))).toHaveLength(NAMED_OTHER_MODELS)
    expect(sum(rows)).toBe(busy.total)
  })

  it('names one more model rather than fold a single one away', () => {
    const rows = dayModelShares(day([0, 0, 100], tail(40, 30, 20, 10)), models)
    expect(rows.map((row) => row.label)).toEqual(['M1', 'M2', 'M3', 'M4'])
    expect(rows.some((row) => row.foldedCount)).toBe(false)
  })

  it('keeps a single "other" row when the day carries no names for it', () => {
    expect(dayModelShares(day([60, 0, 40], []), models).map((row) => [row.label, row.tokens])).toEqual([
      ['A', 60],
      ['Other', 40],
    ])
  })

  it('has no rows for an idle day', () => {
    expect(dayModelShares(day([0, 0, 0], []), models)).toEqual([])
  })
})

describe('buildColumnGeometry', () => {
  const day = (date: string, ...byModel: number[]) => ({ date, total: byModel.reduce((a, b) => a + b, 0), byModel, otherModels: [] })
  const model = (id: string, series: number) => ({ id, label: id, series, total: 1, fresh: 0, cached: 0, costUSD: 0, unpriced: false })
  const two = [model('a', 1), model('b', 2)]
  /** [x, top, bottom] of every segment in one layer's path. */
  const segments = (d: string) => [...d.matchAll(/M([\d.]+) ([\d.]+)h[\d.]+V([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])] as const)

  it('draws one path per model with usage, bottom to top in color-slot order', () => {
    const swapped = [model('a', 2), model('b', 1)]
    const geometry = buildColumnGeometry([day('2026-10-01', 10, 20), day('2026-10-02', 5, 0)], swapped, 400, 200)

    // b holds slot 1, so it is the bottom layer even though a is listed first.
    expect(geometry.layers.map((layer) => layer.modelIndex)).toEqual([1, 0])
    expect(buildColumnGeometry([day('2026-10-01', 10, 0)], two, 400, 200).layers.map((layer) => layer.modelIndex)).toEqual([0])
  })

  it('puts every column on one zero baseline and one scale, so heights compare', () => {
    const geometry = buildColumnGeometry([day('2026-10-01', 10, 10), day('2026-10-02', 5, 5), day('2026-10-03', 0, 0)], two, 300, 200)
    const [big, small, idle] = geometry.dayTops
    // 20 against 10: exactly twice the height above the bottom edge.
    expect((200 - big!) / (200 - small!)).toBeCloseTo(2, 5)
    expect(idle).toBe(200)

    // The lowest segment of the tallest column ends at the baseline, give or take its gap.
    const bottoms = segments(geometry.layers[0]!.d).map(([, , bottom]) => bottom)
    expect(Math.max(...bottoms)).toBeGreaterThan(198)
    expect(Math.max(...bottoms)).toBeLessThanOrEqual(200)
  })

  it('leaves an idle day empty instead of bridging it', () => {
    const geometry = buildColumnGeometry([day('2026-10-01', 10), day('2026-10-02', 0), day('2026-10-03', 10)], [model('a', 1)], 300, 200)
    const xs = segments(geometry.layers[0]!.d).map(([x]) => x)
    expect(xs).toHaveLength(2)
    // Slots are 100 wide; the middle one (100 to 200) holds nothing.
    expect(xs.every((x) => x < 100 || x >= 200)).toBe(true)
  })

  it('separates stacked segments with a gap of surface', () => {
    const geometry = buildColumnGeometry([day('2026-10-01', 50, 50)], two, 100, 200)
    const [lower] = segments(geometry.layers[0]!.d)
    const [upper] = segments(geometry.layers[1]!.d)
    // The upper segment's bottom edge stops short of the lower one's top edge.
    expect(lower![1] - upper![2]).toBeGreaterThanOrEqual(1.4)
  })

  it('marks the busiest day with its own total, centred on its column, clear of the label room', () => {
    const days = [day('2026-09-29', 10), day('2026-09-30', 10), day('2026-10-01', 100), day('2026-10-02', 10), day('2026-10-03', 10)]
    const { peak } = buildColumnGeometry(days, [model('a', 1)], 500, 200)

    expect(peak).toMatchObject({ index: 2, total: 100, date: '2026-10-01', x: 250 })
    expect(peak!.y).toBeGreaterThan(COLUMN_TOP_PAD)
    expect(peak!.y).toBeLessThan(100)
  })

  it('draws grid lines at round values, rising up the chart', () => {
    const geometry = buildColumnGeometry([day('2026-10-01', 4_000_000), day('2026-10-02', 1_000_000)], [model('a', 1)], 300, 200)
    expect(geometry.grid.map((line) => line.value)).toEqual([1_000_000, 2_000_000, 3_000_000, 4_000_000])
    const ys = geometry.grid.map((line) => line.y)
    expect([...ys].sort((a, b) => b - a)).toEqual(ys)
  })

  it('places month ticks on the first of each month, over that day\'s column', () => {
    const days = [day('2026-09-30', 1), day('2026-10-01', 1), day('2026-10-02', 1), day('2026-10-03', 1)]
    expect(buildColumnGeometry(days, [model('a', 1)], 100, 50).monthTicks).toEqual([{ fraction: 0.375, date: '2026-10-01' }])
  })

  it('records where each day\'s column ends, so a marker can sit on the day it belongs to', () => {
    const days = [day('2026-09-29', 10), day('2026-09-30', 10), day('2026-10-01', 100)]
    const geometry = buildColumnGeometry(days, [model('a', 1)], 400, 200)
    expect(geometry.dayTops).toHaveLength(days.length)
    expect(geometry.dayTops[2]).toBe(geometry.peak!.y)
  })

  it('has nothing to draw when there is no usage in the window', () => {
    const geometry = buildColumnGeometry([day('2026-10-01', 0), day('2026-10-02', 0)], two, 100, 50)
    expect(geometry).toMatchObject({ layers: [], grid: [], dayTops: [], peak: null, monthTicks: [] })
  })
})

describe('summarizeDay', () => {
  const models = rankModels(statsWith({ modelUsage: { a: usage(900), b: usage(100) } }), 'Other')
  const day = (date: string, ...byModel: number[]) => ({ date, total: byModel.reduce((a, b) => a + b, 0), byModel, otherModels: [] })
  const days = [
    day('2026-10-14', 0, 0),
    day('2026-10-15', 60, 20),
    day('2026-10-16', 100, 100),
    day('2026-10-17', 10, 0),
  ]
  const activity = new Map([['2026-10-16', { sessionCount: 4, messageCount: 50, toolCallCount: 120 }]])

  it('places a day against the busiest day and the average active day', () => {
    const peakDay = summarizeDay(days, 2, models, activity)!
    expect(peakDay).toMatchObject({ date: '2026-10-16', total: 200, peak: 200, ofPeak: 1, rank: 1, activeDays: 3 })
    // The idle day is not counted: (80 + 200 + 10) / 3, not / 4.
    expect(peakDay.average).toBeCloseTo(96.667, 2)

    expect(summarizeDay(days, 1, models, activity)).toMatchObject({ total: 80, ofPeak: 0.4, rank: 2 })
    expect(summarizeDay(days, 3, models, activity)).toMatchObject({ total: 10, rank: 3 })
  })

  it('gives tied days the same rank', () => {
    const tied = [day('2026-10-15', 50, 0), day('2026-10-16', 50, 0), day('2026-10-17', 5, 0)]
    expect(summarizeDay(tied, 0, models, activity)!.rank).toBe(1)
    expect(summarizeDay(tied, 1, models, activity)!.rank).toBe(1)
    expect(summarizeDay(tied, 2, models, activity)!.rank).toBe(3)
  })

  it('lists the models that ran that day, biggest first, with their share of it', () => {
    const summary = summarizeDay(days, 1, models, activity)!
    expect(summary.models.map((model) => [model.id, model.series, model.tokens, model.share])).toEqual([
      ['a', 1, 60, 0.75],
      ['b', 2, 20, 0.25],
    ])
    // A model that did not run is left out rather than listed at 0%.
    expect(summarizeDay(days, 3, models, activity)!.models.map((model) => model.id)).toEqual(['a'])
    const reversed = summarizeDay([day('2026-10-17', 5, 30)], 0, models, activity)!
    expect(reversed.models.map((model) => model.id)).toEqual(['b', 'a'])
  })

  it('carries that date\'s activity, and zeros where the stats have none', () => {
    expect(summarizeDay(days, 2, models, activity)).toMatchObject({ sessionCount: 4, messageCount: 50, toolCallCount: 120 })
    expect(summarizeDay(days, 1, models, activity)).toMatchObject({ sessionCount: 0, messageCount: 0, toolCallCount: 0 })
  })

  it('has nothing to open for an idle day or an index outside the window', () => {
    expect(summarizeDay(days, 0, models, activity)).toBeNull()
    expect(summarizeDay(days, -1, models, activity)).toBeNull()
    expect(summarizeDay(days, 4, models, activity)).toBeNull()
  })
})

describe('formatShare', () => {
  it('keeps a decimal only where a whole number would round a small share away', () => {
    expect(formatShare(1, 2, 'en')).toBe('50%')
    expect(formatShare(34, 1000, 'en')).toBe('3.4%')
    expect(formatShare(5, 0, 'en')).toBe('0%')
  })
})
