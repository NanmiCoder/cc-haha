import { describe, expect, it } from 'vitest'

import type { ActivityStatsResponse } from '../../api/activityStats'
import {
  OTHER_MODELS_ID,
  formatModelName,
  SERIES_COUNT,
  buildDailyModelSeries,
  buildStreamGeometry,
  getFreshTokenTotal,
  getModelTokenTotal,
  rankModels,
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
  it('orders models by total tokens and hands out series colors in that order', () => {
    const ranked = rankModels(statsWith({
      modelUsage: { 'small-model': usage(10), 'big-model': usage(900), 'idle-model': usage(0) },
    }), 'Other')

    expect(ranked.map((model) => [model.id, model.series])).toEqual([['big-model', 1], ['small-model', 2]])
  })

  it('folds everything past the fourth model into one "other" row so no color is shared', () => {
    const modelUsage = Object.fromEntries(
      Array.from({ length: 7 }, (_, index) => [`model-${index}`, { ...usage(1000 - index * 100), costUSD: 1 }]),
    )
    const ranked = rankModels(statsWith({ modelUsage, unpricedModels: ['model-6'] }), 'Other models')

    expect(ranked).toHaveLength(SERIES_COUNT)
    expect(ranked.map((model) => model.series)).toEqual([1, 2, 3, 4, 5])
    const other = ranked[SERIES_COUNT - 1]!
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
    expect(series[0]).toEqual({ date: '2026-10-14', total: 0, byModel: [0, 0] })
    expect(series[2]).toEqual({ date: '2026-10-16', total: 40, byModel: [30, 10] })
  })

  it('drops models that are not ranked when no "other" row exists to receive them', () => {
    const models = rankModels(stats, 'Other')
    const series = buildDailyModelSeries(stats, models, 1, new Date('2026-10-17T12:00:00'))
    expect(series[0]).toEqual({ date: '2026-10-17', total: 5, byModel: [5, 0] })
  })
})

describe('buildStreamGeometry', () => {
  const day = (date: string, ...byModel: number[]) => ({ date, total: byModel.reduce((a, b) => a + b, 0), byModel })

  it('draws one closed layer per model, centred and inside the box', () => {
    const days = [day('2026-09-29', 10, 5), day('2026-09-30', 20, 10), day('2026-10-01', 60, 30), day('2026-10-02', 20, 10)]
    const geometry = buildStreamGeometry(days, 400, 200)

    expect(geometry.layers).toHaveLength(2)
    for (const layer of geometry.layers) {
      expect(layer.d.startsWith('M')).toBe(true)
      expect(layer.d.endsWith('Z')).toBe(true)
      const ys = [...layer.d.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]))
      expect(Math.min(...ys)).toBeGreaterThanOrEqual(0)
      expect(Math.max(...ys)).toBeLessThanOrEqual(400)
    }
  })

  it('marks the real peak day, not the smoothed one, with its own total', () => {
    const days = [day('2026-09-29', 10), day('2026-09-30', 10), day('2026-10-01', 100), day('2026-10-02', 10), day('2026-10-03', 10)]
    const { peak } = buildStreamGeometry(days, 400, 200)

    expect(peak).toMatchObject({ index: 2, total: 100, date: '2026-10-01', x: 200 })
    expect(peak!.y).toBeGreaterThan(0)
    expect(peak!.y).toBeLessThan(100)
  })

  it('places month ticks on the first of each month', () => {
    const days = [day('2026-09-30', 1), day('2026-10-01', 1), day('2026-10-02', 1)]
    expect(buildStreamGeometry(days, 100, 50).monthTicks).toEqual([{ fraction: 0.5, date: '2026-10-01' }])
  })

  it('has nothing to draw when there is no usage in the window', () => {
    const geometry = buildStreamGeometry([day('2026-10-01', 0), day('2026-10-02', 0)], 100, 50)
    expect(geometry.layers).toEqual([])
    expect(geometry.peak).toBeNull()
  })
})
