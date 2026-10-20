import { describe, expect, it } from 'vitest'

import type { ActivityStatsResponse } from '../../../api/activityStats'
import { translate } from '../../../i18n'
import { buildShareImageData } from './data'
import { buildShareLayout, type DrawOp, type ShareImageData, type ShareOptions, type ShareTheme, type TextOp } from './layout'

const THEME: ShareTheme = {
  bg: '#201D17', bd: '#383226', bd2: '#4C4433', t1: '#EDE6D6', t2: '#A79B83', t3: '#918777', ac: '#D07B52',
  series: ['#5FAEA2', '#D07B52', '#D9B98A', '#8E9BB8', '#6B6455'],
}

const OPTIONS: ShareOptions = { size: 'portrait', showIdentity: true, showModels: true, showLink: true, showCost: false }

/** CJK glyphs are about 1em wide, Latin about 0.55em (0.6em in mono): close enough to a real canvas to catch overflow. */
const measure = (op: { text: string; size: number; family?: string }) =>
  Array.from(op.text).reduce((width, char) => width + op.size * (char.charCodeAt(0) > 255 ? 1 : op.family === 'mono' ? 0.6 : 0.55), 0)

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

describe('free-text profile fields on the card', () => {
  // The server accepts a name of 80 characters and a second line of 160.
  const long: ShareImageData = {
    ...DATA,
    displayName: '测'.repeat(80),
    linkText: `github.com/${'x'.repeat(149)}`,
    models: [{ ...models[0]!, label: 'A very long model identifier that keeps going and going' }, models[1]!],
  }

  it.each(['portrait', 'square', 'wide'] as const)('clips a long name, link and model label inside the %s card', (size) => {
    const { width, ops } = buildShareLayout(long, THEME, { ...OPTIONS, size }, measure)
    const rightEdge = width - (size === 'wide' ? 48 : size === 'square' ? 72 : 76)

    for (const op of ops) {
      if (op.kind !== 'text' || (op.align ?? 'left') !== 'left') continue
      expect(op.x + measure(op)).toBeLessThanOrEqual(rightEdge + 0.5)
    }
    const name = ops.find((op): op is TextOp => op.kind === 'text' && op.text.startsWith('测'))!
    expect(name.text.endsWith('…')).toBe(true)
    expect(name.text.length).toBeLessThan(long.displayName.length)
  })

  it('keeps the link clear of the note on the other side of the footer', () => {
    const { ops } = buildShareLayout(long, THEME, OPTIONS, measure)
    const link = ops.find((op): op is TextOp => op.kind === 'text' && op.text.startsWith('github.com/'))!
    const note = ops.find((op): op is TextOp => op.kind === 'text' && op.text === long.footerNote)!
    expect(link.text.endsWith('…')).toBe(true)
    expect(link.x + measure(link)).toBeLessThan(note.x - measure(note))
  })

  it('leaves text that already fits untouched', () => {
    const { ops } = buildShareLayout(DATA, THEME, OPTIONS, measure)
    expect(texts(ops)).toContain(DATA.displayName)
    expect(texts(ops)).toContain(DATA.linkText)
    expect(texts(ops).some((text) => text.includes('…'))).toBe(false)
  })
})

describe('a window with no usage', () => {
  const quiet: ShareImageData = { ...DATA, daily: [[0, 0], [0, 0]], peak: null, gridLines: [], chartMax: 1 }

  it('draws no chart and gives the model list the whole width', () => {
    const { ops } = buildShareLayout(quiet, THEME, OPTIONS, measure)
    // No bars: the only rects left are the streak ticks.
    expect(ops.filter((op) => op.kind === 'rect' && op.h !== 34)).toHaveLength(0)
    const row = ops.find((op): op is TextOp => op.kind === 'text' && op.text === 'DeepSeek V4 Flash')!
    expect(row.x).toBe(76 + 26)
    expect(ops.some((op) => op.kind === 'line' && op.x1 === 76 && op.x2 === 1004)).toBe(true)
  })

  it('still draws the streak and footer below the list', () => {
    const { ops } = buildShareLayout(quiet, THEME, OPTIONS, measure)
    expect(texts(ops)).toContain('当前连续 3 天')
    expect(texts(ops)).toContain(DATA.linkText)
  })

  it('has no axis in the data either', () => {
    const data = buildShareImageData({
      stats: {
        activeDays: 1,
        totalSessions: 1,
        streaks: { currentStreak: 0, longestStreak: 0, currentStreakStart: null, longestStreakStart: null, longestStreakEnd: null },
      } as ActivityStatsResponse,
      models: [{ id: 'a', label: 'A', series: 1, total: 10, fresh: 10, cached: 0, costUSD: 0, unpriced: true }],
      daily: [{ date: '2026-10-16', total: 0, byModel: [0], otherModels: [] }, { date: '2026-10-17', total: 0, byModel: [0], otherModels: [] }],
      totalTokens: 10,
      locale: 'en',
      t: (key, params) => translate('en', key, params),
      profile: { displayName: 'Ada', subtitle: '' },
      now: new Date('2026-10-17T12:00:00'),
    })
    expect(data.gridLines).toEqual([])
    expect(data.peak).toBeNull()
  })
})
