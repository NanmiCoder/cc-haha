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
  test('实时上下文：窗口取 rawMaxTokens，去掉延迟加载项和坏条目', () => {
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
  test('rawMaxTokens 缺失时退回 maxTokens', () => {
    expect(parseContextInspection({ context: { totalTokens: 10, maxTokens: 50 } })?.window).toBe(50)
  })
  test('只有 transcript 估算时标为 estimate；实时和估算同时有以实时为准', () => {
    expect(parseContextInspection({ contextEstimate: { totalTokens: 5, rawMaxTokens: 100 } })?.estimate).toBe(true)
    const both = parseContextInspection({ ...live, contextEstimate: { totalTokens: 1, rawMaxTokens: 1 } })
    expect(both).toMatchObject({ used: 76_123, estimate: false })
  })
  test('没有可用数据或数字非法返回 null', () => {
    expect(parseContextInspection(null)).toBeNull()
    expect(parseContextInspection({})).toBeNull()
    expect(parseContextInspection({ context: { totalTokens: 'many' } })).toBeNull()
    expect(parseContextInspection({ context: { totalTokens: -1 } })).toBeNull()
    expect(parseContextInspection({ context: { totalTokens: 10, rawMaxTokens: 0, maxTokens: 0 } })?.window).toBeUndefined()
  })
})

describe('parseSessionUsage', () => {
  test('速度按输出 token ÷ API 时长，命中率按提示侧计算', () => {
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
  test('没有 API 时长不编速度；什么都没产生返回 null', () => {
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

  test('两路请求各取各的，路径带会话 id 并转义', async () => {
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
  test('一路失败不影响另一路；两路都失败才标 failed', async () => {
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
  test('实时数据：已用 / 窗口（百分比），tone ok', () => {
    const summary = contextSummary({ snapshot: snapshot() })
    expect(summary).toMatchObject({
      source: 'live',
      percent: 38,
      percentLabel: '38%',
      headline: '已用 76k / 200k（38%）',
      menuLabel: '上下文 38%',
      tone: 'ok',
      approximate: false,
    })
    expect(summary.fill).toBeCloseTo(0.38)
    expect(summary.notice).toBeUndefined()
  })
  test('窗口未知：只显示已用 token，不显示百分比', () => {
    const summary = contextSummary({ snapshot: snapshot({ window: undefined }) })
    expect(summary).toMatchObject({ headline: '已用 76k', menuLabel: '上下文用量', tone: 'unknown', fill: 0 })
    expect(summary.percent).toBeUndefined()
    expect(summary.percentLabel).toBeUndefined()
  })
  test('快照没给窗口时用模型目录推出的窗口', () => {
    expect(contextSummary({ snapshot: snapshot({ window: undefined }), window: 100_000 }).percent).toBe(76)
  })
  test('tone 阈值：79 ok / 80 warn / 94 warn / 95 full', () => {
    const at = (percent: number) => contextSummary({ snapshot: snapshot({ used: percent * 1000, window: 100_000 }) })
    expect(at(79).tone).toBe('ok')
    expect(at(80).tone).toBe('warn')
    expect(at(94).tone).toBe('warn')
    expect(at(95).tone).toBe('full')
  })
  test('按四舍五入后的百分比判 tone，标签与颜色一致', () => {
    const summary = contextSummary({ snapshot: snapshot({ used: 79_600, window: 100_000 }) })
    expect(summary.percentLabel).toBe('80%')
    expect(summary.tone).toBe('warn')
  })
  test('警告文案带百分比，已满时换措辞', () => {
    expect(contextSummary({ snapshot: snapshot({ used: 85_000, window: 100_000 }) }).notice).toContain('85%')
    expect(contextSummary({ snapshot: snapshot({ used: 97_000, window: 100_000 }) }).notice).toContain('几乎已满')
  })
  test('超过窗口：百分比如实显示，进度条只填满，tone 为 full', () => {
    const summary = contextSummary({ snapshot: snapshot({ used: 250_000, window: 200_000 }) })
    expect(summary).toMatchObject({ percent: 125, tone: 'full', fill: 1, headline: '已用 250k / 200k（125%）' })
  })
  test('0 用量：0%，不报警；极小用量写 <1%', () => {
    expect(contextSummary({ snapshot: snapshot({ used: 0 }) })).toMatchObject({ percent: 0, percentLabel: '0%', tone: 'ok', fill: 0 })
    expect(contextSummary({ snapshot: snapshot({ used: 300 }) })).toMatchObject({ percentLabel: '<1%', headline: '已用 300 / 200k（<1%）' })
  })
  test('transcript 估算标为近似，仍然可以报警', () => {
    const summary = contextSummary({ snapshot: snapshot({ estimate: true, used: 90_000, window: 100_000 }) })
    expect(summary).toMatchObject({ source: 'estimate', approximate: true, tone: 'warn', menuLabel: '上下文约 90%' })
    expect(summary.headline).toBe('已用约 90k / 100k（90%）')
  })
  test('没有快照退回最近一轮 usage：近似、封顶 100%、永不报警', () => {
    const summary = contextSummary({
      usage: { input_tokens: 2000, output_tokens: 10, cache_read_tokens: 500_000, cache_creation_tokens: 1000 },
      window: 200_000,
    })
    expect(summary).toMatchObject({ source: 'turn', approximate: true, percent: 100, tone: 'ok', fill: 1 })
    expect(summary.notice).toBeUndefined()
    expect(summary.used).toBe(503_000)
  })
  test('快照优先于 usage', () => {
    const summary = contextSummary({
      snapshot: snapshot(),
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    expect(summary.source).toBe('live')
    expect(summary.used).toBe(76_000)
  })
  test('什么数据都没有：暂无数据，菜单只写“上下文用量”', () => {
    expect(contextSummary({})).toMatchObject({ source: null, headline: '暂无数据', menuLabel: '上下文用量', tone: 'unknown' })
    expect(contextSummary({ usage: { input_tokens: 0, output_tokens: 20 }, window: 1000 }).source).toBeNull()
  })
})

describe('menuContextLine', () => {
  test('模型名 · 上下文 N%', () => {
    expect(menuContextLine('DeepSeek V4', contextSummary({ snapshot: snapshot() }))).toBe('DeepSeek V4 · 上下文 38%')
  })
  test('模型名取不到时只有上下文', () => {
    expect(menuContextLine('  ', contextSummary({ snapshot: snapshot() }))).toBe('上下文 38%')
    expect(menuContextLine(undefined, contextSummary({}))).toBe('上下文用量')
  })
})

describe('usageRows', () => {
  test('有哪个字段显示哪个，缓存字段没给就不列', () => {
    expect(usageRows({ input_tokens: 1200, output_tokens: 340 })).toEqual([
      { key: 'input', label: '输入', value: '1.2k' },
      { key: 'output', label: '输出', value: '340' },
    ])
    expect(
      usageRows({ input_tokens: 10, output_tokens: 20, cache_read_tokens: 30_000, cache_creation_tokens: 400 }).map((row) => row.key)
    ).toEqual(['input', 'output', 'cache_read', 'cache_creation'])
  })
  test('没有 usage 或字段非法返回空', () => {
    expect(usageRows(undefined)).toEqual([])
    expect(usageRows({ input_tokens: Number.NaN, output_tokens: -1 })).toEqual([])
  })
})

describe('categoryRows', () => {
  test('按占用排序，去掉占位项和 0，限制条数，名称有中文映射', () => {
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
    expect(rows.map((row) => row.label)).toEqual(['对话消息', '技能', 'Something new'])
    expect(rows[0]).toMatchObject({ value: '50k' })
    expect(rows[0].fill).toBeCloseTo(0.25)
    expect(rows[2].fill).toBeGreaterThan(0)
  })
  test('窗口未知时占比相对总量；没有快照为空', () => {
    const rows = categoryRows(snapshot({ window: undefined, used: 100, categories: [{ name: 'Messages', tokens: 50 }] }))
    expect(rows[0].fill).toBe(0.5)
    expect(categoryRows(null)).toEqual([])
  })
  test('条数上限', () => {
    const categories = Array.from({ length: 10 }, (_, i) => ({ name: `c${i}`, tokens: i + 1 }))
    expect(categoryRows(snapshot({ categories }), 3)).toHaveLength(3)
  })
})

describe('formatCacheHit', () => {
  test('99.96% 不会被写成 100%', () => {
    expect(formatCacheHit(0.9996)).toBe('99.9%')
    expect(formatCacheHit(1)).toBe('100%')
    expect(formatCacheHit(0.6)).toBe('60%')
    expect(formatCacheHit(0)).toBe('0%')
    expect(formatCacheHit(Number.NaN)).toBe('0%')
  })
})
