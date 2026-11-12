import { describe, expect, test } from 'bun:test'
import type { ApiClient } from '../../core/client'
import {
  categoryRows,
  contextSummary,
  fetchContextInspection,
  formatCacheHit,
  menuContextLine,
  parseContextInspection,
  parseSessionUsage,
  usageRows,
  type ContextSnapshot,
} from './contextUsage'

const snapshot = (patch: Partial<ContextSnapshot> = {}): ContextSnapshot => ({
  used: 76_000,
  window: 200_000,
  categories: [],
  estimate: false,
  ...patch,
})

describe('parseContextInspection', () => {
  const live = {
    context: {
      totalTokens: 76_123,
      rawMaxTokens: 200_000,
      maxTokens: 167_000,
      model: ' claude-x ',
      categories: [
        { name: 'Messages', tokens: 50_000 },
        { name: 'Skills', tokens: 900, isDeferred: true },
        { name: 'Free space', tokens: 100_000 },
        { name: 'broken' },
      ],
    },
  }
  test('Live context: window from rawMaxTokens, dropping deferred items and bad entries', () => {
    expect(parseContextInspection(live)).toEqual({
      used: 76_123,
      window: 200_000,
      categories: [
        { name: 'Messages', tokens: 50_000 },
        { name: 'Free space', tokens: 100_000 },
      ],
      model: 'claude-x',
      estimate: false,
    })
  })
  test('rawMaxTokens falls back when missing to maxTokens', () => {
    expect(parseContextInspection({ context: { totalTokens: 10, maxTokens: 50 } })?.window).toBe(50)
  })
  test('Marked estimate when there is only a transcript estimate; when both live and estimate exist live wins', () => {
    expect(parseContextInspection({ contextEstimate: { totalTokens: 5, rawMaxTokens: 100 } })?.estimate).toBe(true)
    const both = parseContextInspection({ ...live, contextEstimate: { totalTokens: 1, rawMaxTokens: 1 } })
    expect(both).toMatchObject({ used: 76_123, estimate: false })
  })
  test('Returns when there is no usable data or numbers are invalid null', () => {
    expect(parseContextInspection(null)).toBeNull()
    expect(parseContextInspection({})).toBeNull()
    expect(parseContextInspection({ context: { totalTokens: 'many' } })).toBeNull()
    expect(parseContextInspection({ context: { totalTokens: -1 } })).toBeNull()
    expect(parseContextInspection({ context: { totalTokens: 10, rawMaxTokens: 0, maxTokens: 0 } })?.window).toBeUndefined()
  })
})

describe('parseSessionUsage', () => {
  test('Speed is output tokens ÷ API duration, hit rate is computed on the prompt side', () => {
    const stats = parseSessionUsage({
      usage: {
        totalInputTokens: 100,
        totalOutputTokens: 600,
        totalCacheReadInputTokens: 300,
        totalCacheCreationInputTokens: 100,
        totalAPIDuration: 12_000,
        costDisplay: '$0.42',
      },
    })
    expect(stats).toEqual({ tokensPerSecond: 50, cacheHitRate: 0.6, cost: '$0.42' })
  })
  test('No speed is made up without API duration; returns when nothing was produced null', () => {
    expect(parseSessionUsage({ usage: { totalInputTokens: 10, totalOutputTokens: 5 } })?.tokensPerSecond).toBeNull()
    expect(parseSessionUsage({ usage: { totalInputTokens: 0, totalOutputTokens: 0 } })).toBeNull()
    expect(parseSessionUsage({})).toBeNull()
  })
})

describe('fetchContextInspection', () => {
  const clientWith = (handler: (path: string) => unknown) =>
    ({
      get: async (path: string) => {
        const value = handler(path)
        if (value instanceof Error) throw value
        return value
      },
    }) as unknown as Pick<ApiClient, 'get'>

  test('The two requests each take their own data, with the session id escaped in the path', async () => {
    const paths: string[] = []
    const result = await fetchContextInspection(
      clientWith((path) => {
        paths.push(path)
        return path.includes('usageOnly')
          ? { usage: { totalInputTokens: 1, totalOutputTokens: 1 } }
          : { context: { totalTokens: 9, rawMaxTokens: 90 } }
      }),
      'a/b'
    )
    expect(paths.sort()).toEqual([
      '/api/sessions/a%2Fb/inspection?includeContext=0&usageOnly=1',
      '/api/sessions/a%2Fb/inspection?includeContext=1&contextOnly=1',
    ])
    expect(result.snapshot).toMatchObject({ used: 9, window: 90 })
    expect(result.stats).not.toBeNull()
    expect(result.failed).toBe(false)
  })
  test('One path failing does not affect the other; only when both fail mark failed', async () => {
    const half = await fetchContextInspection(
      clientWith((path) => (path.includes('usageOnly') ? new Error('boom') : { context: { totalTokens: 3 } })),
      's'
    )
    expect(half.snapshot?.used).toBe(3)
    expect(half.stats).toBeNull()
    expect(half.failed).toBe(false)
    const none = await fetchContextInspection(clientWith(() => new Error('down')), 's')
    expect(none).toEqual({ snapshot: null, stats: null, failed: true })
  })
})

describe('contextSummary', () => {
  test('Live data: used / window (percentage), tone ok', () => {
    const summary = contextSummary({ snapshot: snapshot() })
    expect(summary).toMatchObject({
      source: 'live',
      percent: 38,
      percentLabel: '38%',
      headline: 'Used 76k / 200k (38%)',
      menuLabel: 'Context 38%',
      tone: 'ok',
      approximate: false,
    })
    expect(summary.fill).toBeCloseTo(0.38)
    expect(summary.notice).toBeUndefined()
  })
  test('Unknown window: show only used tokens, no percentage', () => {
    const summary = contextSummary({ snapshot: snapshot({ window: undefined }) })
    expect(summary).toMatchObject({ headline: 'Used 76k', menuLabel: 'Context usage', tone: 'unknown', fill: 0 })
    expect(summary.percent).toBeUndefined()
    expect(summary.percentLabel).toBeUndefined()
  })
  test('When the snapshot gives no window use the one derived from the model catalog', () => {
    expect(contextSummary({ snapshot: snapshot({ window: undefined }), window: 100_000 }).percent).toBe(76)
  })
  test('tone Thresholds: 79 ok / 80 warn / 94 warn / 95 full', () => {
    const at = (percent: number) => contextSummary({ snapshot: snapshot({ used: percent * 1000, window: 100_000 }) })
    expect(at(79).tone).toBe('ok')
    expect(at(80).tone).toBe('warn')
    expect(at(94).tone).toBe('warn')
    expect(at(95).tone).toBe('full')
  })
  test('Decide tone by the rounded percentage, so label and color agree', () => {
    const summary = contextSummary({ snapshot: snapshot({ used: 79_600, window: 100_000 }) })
    expect(summary.percentLabel).toBe('80%')
    expect(summary.tone).toBe('warn')
  })
  test('Warning text includes the percentage, with different wording when full', () => {
    expect(contextSummary({ snapshot: snapshot({ used: 85_000, window: 100_000 }) }).notice).toContain('85%')
    expect(contextSummary({ snapshot: snapshot({ used: 97_000, window: 100_000 }) }).notice).toContain('almost full')
  })
  test('Over the window: percentage shown as is, the progress bar just fills up, tone is full', () => {
    const summary = contextSummary({ snapshot: snapshot({ used: 250_000, window: 200_000 }) })
    expect(summary).toMatchObject({ percent: 125, tone: 'full', fill: 1, headline: 'Used 250k / 200k (125%)' })
  })
  test('0 Usage: 0% does not warn; tiny usage is written as <1%', () => {
    expect(contextSummary({ snapshot: snapshot({ used: 0 }) })).toMatchObject({ percent: 0, percentLabel: '0%', tone: 'ok', fill: 0 })
    expect(contextSummary({ snapshot: snapshot({ used: 300 }) })).toMatchObject({ percentLabel: '<1%', headline: 'Used 300 / 200k (<1%)' })
  })
  test('transcript Estimates are marked approximate and can still warn', () => {
    const summary = contextSummary({ snapshot: snapshot({ estimate: true, used: 90_000, window: 100_000 }) })
    expect(summary).toMatchObject({ source: 'estimate', approximate: true, tone: 'warn', menuLabel: 'Context about 90%' })
    expect(summary.headline).toBe('Used about 90k / 100k (90%)')
  })
  test('Without a snapshot fall back to the last turn’s usage: approximate, capped at 100%, never warns', () => {
    const summary = contextSummary({
      usage: { input_tokens: 2000, output_tokens: 10, cache_read_tokens: 500_000, cache_creation_tokens: 1000 },
      window: 200_000,
    })
    expect(summary).toMatchObject({ source: 'turn', approximate: true, percent: 100, tone: 'ok', fill: 1 })
    expect(summary.notice).toBeUndefined()
    expect(summary.used).toBe(503_000)
  })
  test('Snapshot takes priority over usage', () => {
    const summary = contextSummary({
      snapshot: snapshot(),
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    expect(summary.source).toBe('live')
    expect(summary.used).toBe(76_000)
  })
  test('No data at all: no data yet, and the menu only says “Context usage”', () => {
    expect(contextSummary({})).toMatchObject({ source: null, headline: 'No data yet', menuLabel: 'Context usage', tone: 'unknown' })
    expect(contextSummary({ usage: { input_tokens: 0, output_tokens: 20 }, window: 1000 }).source).toBeNull()
  })
})

describe('menuContextLine', () => {
  test('Model name · context N%', () => {
    expect(menuContextLine('DeepSeek V4', contextSummary({ snapshot: snapshot() }))).toBe('DeepSeek V4 · Context 38%')
  })
  test('When the model name is unavailable only context is shown', () => {
    expect(menuContextLine('  ', contextSummary({ snapshot: snapshot() }))).toBe('Context 38%')
    expect(menuContextLine(undefined, contextSummary({}))).toBe('Context usage')
  })
})

describe('usageRows', () => {
  test('Show whichever fields exist; cache fields are not listed if absent', () => {
    expect(usageRows({ input_tokens: 1200, output_tokens: 340 })).toEqual([
      { key: 'input', label: 'Input', value: '1.2k' },
      { key: 'output', label: 'Output', value: '340' },
    ])
    expect(
      usageRows({ input_tokens: 10, output_tokens: 20, cache_read_tokens: 30_000, cache_creation_tokens: 400 }).map((row) => row.key)
    ).toEqual(['input', 'output', 'cache_read', 'cache_creation'])
  })
  test('Returns empty without usage or with invalid fields', () => {
    expect(usageRows(undefined)).toEqual([])
    expect(usageRows({ input_tokens: Number.NaN, output_tokens: -1 })).toEqual([])
  })
})

describe('categoryRows', () => {
  test('Sorted by usage, dropping placeholders and zeros, capped in count, with names mapped to readable labels', () => {
    const rows = categoryRows(
      snapshot({
        categories: [
          { name: 'Skills', tokens: 2000 },
          { name: 'Messages', tokens: 50_000 },
          { name: 'Free space', tokens: 120_000 },
          { name: 'Autocompact buffer', tokens: 33_000 },
          { name: 'Zero', tokens: 0 },
          { name: 'Something new', tokens: 10 },
        ],
      })
    )
    expect(rows.map((row) => row.label)).toEqual(['Messages', 'Skills', 'Something new'])
    expect(rows[0]).toMatchObject({ value: '50k' })
    expect(rows[0].fill).toBeCloseTo(0.25)
    expect(rows[2].fill).toBeGreaterThan(0)
  })
  test('With an unknown window shares are relative to the total; empty without a snapshot', () => {
    const rows = categoryRows(snapshot({ window: undefined, used: 100, categories: [{ name: 'Messages', tokens: 50 }] }))
    expect(rows[0].fill).toBe(0.5)
    expect(categoryRows(null)).toEqual([])
  })
  test('Count cap', () => {
    const categories = Array.from({ length: 10 }, (_, i) => ({ name: `c${i}`, tokens: i + 1 }))
    expect(categoryRows(snapshot({ categories }), 3)).toHaveLength(3)
  })
})

describe('formatCacheHit', () => {
  test('99.96% is not written as 100%', () => {
    expect(formatCacheHit(0.9996)).toBe('99.9%')
    expect(formatCacheHit(1)).toBe('100%')
    expect(formatCacheHit(0.6)).toBe('60%')
    expect(formatCacheHit(0)).toBe('0%')
    expect(formatCacheHit(Number.NaN)).toBe('0%')
  })
})
