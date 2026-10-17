import { describe, expect, it, vi } from 'vitest'

import type { ActivityStatsResponse } from '../../../api/activityStats'
import { translate } from '../../../i18n'
import type { RankedModel } from '../usageModel'
import { buildShareImageData, niceStep } from './data'
import {
  SHARE_SIZES,
  buildShareLayout,
  type DrawOp,
  type ShareImageData,
  type ShareOptions,
  type ShareTheme,
  type TextOp,
} from './layout'
import { paintShareLayout } from './paint'
import { resolveShareTheme } from './theme'

const THEME: ShareTheme = {
  bg: '#201D17', bd: '#383226', bd2: '#4C4433', t1: '#EDE6D6', t2: '#A79B83', t3: '#918777', ac: '#D07B52',
  series: ['#5FAEA2', '#D07B52', '#D9B98A', '#8E9BB8', '#6B6455'],
}

const OPTIONS: ShareOptions = { size: 'portrait', showIdentity: true, showModels: true, showLink: true, showCost: false }

/** 0.55em per character: good enough to prove the unit lands after the number. */
const measure = (op: { text: string; size: number }) => op.text.length * op.size * 0.55

const models = [
  { label: 'DeepSeek V4 Flash', series: 1, amount: '142亿', share: '59%', cost: null },
  { label: 'Claude Opus', series: 2, amount: '46亿', share: '19%', cost: '$412.80' },
]

const DATA: ShareImageData = {
  displayName: 'Ada Lovelace',
  linkText: 'github.com/NanmiCoder/cc-haha',
  dateLabel: '2026.10.17',
  caption: '累计 Token',
  totalValue: '241',
  totalUnit: '亿',
  totalNote: '24.1B · 24,100,000,000',
  summaryLine: '73 天 · 489 次会话',
  models,
  daily: [[10, 5], [0, 0], [60, 20], [30, 10]],
  chartMax: 90,
  gridLines: [{ value: 50, label: '50' }, { value: 100, label: '100 / 日' }],
  peak: { index: 2, label: '单日峰值 80' },
  monthTicks: [{ fraction: 0.5, label: '10月' }],
  streak: { current: 3, longest: 6, currentLabel: '当前连续 3 天', longestLabel: '最长连续 6 天' },
  footerNote: '缓存命中 93%',
}

const texts = (ops: DrawOp[]) => ops.filter((op): op is TextOp => op.kind === 'text').map((op) => op.text)

describe('buildShareLayout', () => {
  it.each(['portrait', 'square', 'wide'] as const)('keeps every drawn thing inside the %s canvas', (size) => {
    const { width, height, ops } = buildShareLayout(DATA, THEME, { ...OPTIONS, size }, measure)
    expect({ width, height }).toEqual(SHARE_SIZES[size])

    for (const op of ops) {
      if (op.kind === 'rect') {
        expect(op.x).toBeGreaterThanOrEqual(0)
        expect(op.y).toBeGreaterThanOrEqual(0)
        expect(op.x + op.w).toBeLessThanOrEqual(width + 0.001)
        expect(op.y + op.h).toBeLessThanOrEqual(height + 0.001)
      }
      if (op.kind === 'text') {
        expect(op.y).toBeGreaterThan(0)
        expect(op.y).toBeLessThanOrEqual(height)
      }
    }
  })

  it('puts the unit right after the number and the project link in the footer', () => {
    const { ops } = buildShareLayout(DATA, THEME, OPTIONS, measure)
    const total = ops.find((op): op is TextOp => op.kind === 'text' && op.text === '241')!
    const unit = ops.find((op): op is TextOp => op.kind === 'text' && op.text === '亿')!
    expect(unit.x).toBeGreaterThan(total.x + measure(total))
    expect(unit.y).toBe(total.y)
    expect(unit.fill).toBe(THEME.ac)

    const link = ops.find((op): op is TextOp => op.kind === 'text' && op.text === DATA.linkText)!
    expect(link.y).toBeGreaterThan(SHARE_SIZES.portrait.height - 80)
  })

  it('draws the chart with the series color of each model and a peak label', () => {
    const { ops } = buildShareLayout(DATA, THEME, OPTIONS, measure)
    const fills = new Set(ops.filter((op) => op.kind === 'rect').map((op) => (op as { fill: string }).fill))
    expect(fills.has(THEME.series[0]!)).toBe(true)
    expect(fills.has(THEME.series[1]!)).toBe(true)
    expect(texts(ops)).toContain('单日峰值 80')
    expect(texts(ops)).toContain('100 / 日')
  })

  it('leaves out what the user turned off', () => {
    const bare = buildShareLayout(DATA, THEME, { ...OPTIONS, showIdentity: false, showModels: false, showLink: false }, measure)
    const out = texts(bare.ops)
    expect(out).toContain('cc-haha') // the brand mark stays; the name line goes
    expect(out).not.toContain(DATA.displayName)
    expect(out).not.toContain(DATA.summaryLine)
    expect(out).not.toContain('DeepSeek V4 Flash')
    expect(out).not.toContain(DATA.linkText)
    expect(bare.ops.some((op) => op.kind === 'image' && op.source === 'avatar')).toBe(false)
    // The caption stands in for the identity block it no longer has.
    expect(out).toContain('累计 Token')
  })

  it('shows cost only when asked, and never for an unpriced model', () => {
    expect(texts(buildShareLayout(DATA, THEME, OPTIONS, measure).ops)).not.toContain('$412.80')
    const withCost = texts(buildShareLayout(DATA, THEME, { ...OPTIONS, showCost: true }, measure).ops)
    expect(withCost).toContain('$412.80')
    expect(withCost.filter((text) => text.startsWith('$'))).toHaveLength(1)
  })

  it('draws one tick per streak day with the current run highlighted', () => {
    const { ops } = buildShareLayout(DATA, THEME, OPTIONS, measure)
    const ticks = ops.filter((op) => op.kind === 'rect' && op.h === 34)
    expect(ticks).toHaveLength(6)
    expect(ticks.filter((op) => (op as { fill: string }).fill === THEME.ac)).toHaveLength(3)
  })
})

describe('buildShareImageData', () => {
  const stats = {
    range: 'all', generatedAt: '', totalSessions: 489, totalMessages: 0, totalDays: 80, activeDays: 73,
    streaks: { currentStreak: 10, longestStreak: 31, currentStreakStart: null, longestStreakStart: null, longestStreakEnd: null },
    dailyActivity: [], dailyModelTokens: [], longestSession: null, modelUsage: {}, toolUsage: {}, skillUsage: {},
    firstSessionDate: null, lastSessionDate: null, peakActivityDay: null, peakActivityHour: null, totalSpeculationTimeSavedMs: 0,
  } as ActivityStatsResponse
  const ranked: RankedModel[] = [
    { id: 'a', label: 'A', series: 1, total: 900, fresh: 100, cached: 800, costUSD: 0, unpriced: true },
    { id: 'b', label: 'B', series: 2, total: 100, fresh: 100, cached: 0, costUSD: 2.5, unpriced: false },
  ]
  const build = (locale: 'en' | 'zh') => buildShareImageData({
    stats,
    models: ranked,
    daily: [
      { date: '2026-09-30', total: 0, byModel: [0, 0] },
      { date: '2026-10-01', total: 500, byModel: [400, 100] },
      { date: '2026-10-02', total: 200, byModel: [200, 0] },
    ],
    totalTokens: 24_100_000_000,
    locale,
    t: (key, params) => translate(locale, key, params),
    profile: { displayName: 'Ada', subtitle: 'github.com/NanmiCoder/cc-haha' },
    now: new Date('2026-10-17T12:00:00'),
  })

  it('prints the total in the reader\'s units and names the other notation for Chinese readers only', () => {
    const zh = build('zh')
    expect([zh.totalValue, zh.totalUnit, zh.totalNote]).toEqual(['241', '亿', '24.1B · 24,100,000,000'])
    const en = build('en')
    expect([en.totalValue, en.totalUnit, en.totalNote]).toEqual(['24.1', 'B', '24,100,000,000'])
    expect(zh.dateLabel).toBe('2026.10.17')
  })

  it('marks the peak, scales the axis to it and prices only priced models', () => {
    const data = build('en')
    expect(data.peak?.index).toBe(1)
    expect(data.chartMax).toBeGreaterThan(500)
    expect(data.gridLines.length).toBeGreaterThan(0)
    expect(data.gridLines.every((line) => line.value <= data.chartMax)).toBe(true)
    expect(data.models.map((model) => model.cost)).toEqual([null, '$2.50'])
    expect(data.models[0]!.share).toBe('90%')
    expect(data.monthTicks).toEqual([{ fraction: 0.5, label: expect.stringMatching(/Oct/) }])
    expect(data.streak).toMatchObject({ current: 10, longest: 31 })
    expect(data.footerNote).toContain('80%')
  })
})

describe('niceStep', () => {
  it('chooses 1, 2 or 5 times a power of ten giving at most four lines', () => {
    expect(niceStep(2_100_000_000)).toBe(1_000_000_000)
    expect(niceStep(18)).toBe(5)
    expect(niceStep(0)).toBe(1)
    for (const max of [3, 7, 40, 1234, 9_999_999]) {
      expect(max / niceStep(max)).toBeLessThanOrEqual(4)
    }
  })
})

describe('resolveShareTheme', () => {
  it('reads each theme\'s own tokens through a detached probe element and cleans it up', () => {
    const style = document.createElement('style')
    style.textContent = `
      :root { --cc-bg: #111111; --cc-series-1: #aaaaaa; }
      [data-theme="paper"] { --cc-bg: #fbf9f4; --cc-t1: #231d12; --cc-series-1: #3b7068; }`
    document.head.appendChild(style)
    try {
      expect(resolveShareTheme('paper').bg).toBe('#fbf9f4')
      expect(resolveShareTheme('paper').series[0]).toBe('#3b7068')
      expect(resolveShareTheme('current').bg).toBe('#111111')
      expect(document.querySelectorAll('[data-theme="paper"]')).toHaveLength(0)
      // A token the stylesheet does not define falls back instead of becoming an empty color.
      expect(resolveShareTheme('current').ac).toBe('#A24A2E')
    } finally {
      style.remove()
    }
  })
})

describe('paintShareLayout', () => {
  it('fills the background first and replays every op through the 2D context', () => {
    const calls: string[] = []
    const ctx = new Proxy({ measureText: () => ({ width: 10 }) } as Record<string, unknown>, {
      get: (target, prop: string) => {
        if (prop in target) return target[prop]
        return (...args: unknown[]) => { calls.push(`${prop}:${args.length}`) }
      },
      set: () => true,
    }) as unknown as CanvasRenderingContext2D
    const layout = buildShareLayout(DATA, THEME, OPTIONS, measure)
    const image = { naturalWidth: 100, naturalHeight: 100 } as unknown as CanvasImageSource
    vi.stubGlobal('Path2D', class {})
    try {
      paintShareLayout(ctx, layout, { avatar: { image, zoom: 1.28 }, icon: image })
    } finally {
      vi.unstubAllGlobals()
    }

    expect(calls[0]).toBe('fillRect:4')
    expect(calls.filter((call) => call.startsWith('fillText')).length).toBe(layout.ops.filter((op) => op.kind === 'text').length)
    expect(calls.filter((call) => call.startsWith('drawImage')).length).toBe(layout.ops.filter((op) => op.kind === 'image').length)
  })
})
