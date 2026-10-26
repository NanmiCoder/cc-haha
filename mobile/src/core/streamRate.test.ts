import { describe, expect, test } from 'bun:test'
import {
  captionTokens,
  estimateTokens,
  formatRate,
  formatTokenCount,
  pushRateSample,
  RATE_WINDOW_MS,
  streamRate,
  turnOutputChars,
  turnOutputTokens,
  type RateSample,
} from './streamRate'
import type { ChatItem } from './types'

const item = (id: string, type: ChatItem['type'], text: string, patch: Partial<ChatItem> = {}): ChatItem => ({
  id,
  type,
  text,
  ...patch,
})

/** 每秒一个采样：tokens 数组依次对应 t=0,1,2… 秒。 */
const feed = (tokens: number[], start = 10_000) =>
  tokens.reduce<RateSample[]>((samples, value, index) => pushRateSample(samples, { at: start + index * 1000, tokens: value }), [])

describe('turnOutputChars / turnOutputTokens', () => {
  test('只数最后一条用户消息之后的回答与思考文字', () => {
    const items = [
      item('u1', 'user', '第一问'),
      item('a1', 'assistant', 'x'.repeat(4000)),
      item('u2', 'user', '第二问'),
      item('t', 'thinking', 'y'.repeat(40)),
      item('tool', 'tool', '', { toolName: 'Bash', partialInput: 'z'.repeat(999) }),
      item('a2', 'assistant', 'z'.repeat(80)),
    ]
    expect(turnOutputChars(items)).toBe(120)
  })
  test('子 Agent 内部的文字不算主 Agent 的输出', () => {
    const items = [
      item('u', 'user', '问'),
      item('a', 'assistant', 'x'.repeat(40)),
      item('sub', 'assistant', 'y'.repeat(4000), { parentToolUseId: 'tool-1' }),
    ]
    expect(turnOutputChars(items)).toBe(40)
  })
  test('没有用户消息或没有输出时是 0', () => {
    expect(turnOutputChars([])).toBe(0)
    expect(turnOutputChars([item('u', 'user', '问')])).toBe(0)
  })
  test('运行中按字符数 ÷ 4 估算，来源标为 estimate', () => {
    const items = [item('u', 'user', '问'), item('a', 'assistant', 'x'.repeat(4800))]
    expect(turnOutputTokens({ items })).toEqual({ tokens: 1200, source: 'estimate' })
  })
  test('有真实 usage 用真实值，来源标为 usage', () => {
    const items = [item('u', 'user', '问'), item('a', 'assistant', 'x'.repeat(4800))]
    expect(turnOutputTokens({ items, finished: { output_tokens: 1534 } })).toEqual({ tokens: 1534, source: 'usage' })
  })
  test('真实 usage 为 0 或不是有限数时退回估算', () => {
    const items = [item('u', 'user', '问'), item('a', 'assistant', 'x'.repeat(400))]
    expect(turnOutputTokens({ items, finished: { output_tokens: 0 } }).source).toBe('estimate')
    expect(turnOutputTokens({ items, finished: { output_tokens: Number.NaN } }).source).toBe('estimate')
  })
  test('estimateTokens 对非法输入返回 0', () => {
    expect(estimateTokens(-5)).toBe(0)
    expect(estimateTokens(Number.NaN)).toBe(0)
    expect(estimateTokens(10)).toBe(3)
  })
})

describe('pushRateSample', () => {
  test('按时间追加，同一时刻只留最新一个', () => {
    let samples = pushRateSample([], { at: 1000, tokens: 10 })
    samples = pushRateSample(samples, { at: 1000, tokens: 12 })
    expect(samples).toEqual([{ at: 1000, tokens: 12 }])
  })
  test('token 回退（重新同步、新一轮）时以新采样重新开始', () => {
    const samples = pushRateSample(feed([100, 200, 300]), { at: 13_000, tokens: 20 })
    expect(samples).toEqual([{ at: 13_000, tokens: 20 }])
  })
  test('时钟回拨时以新采样重新开始', () => {
    const samples = pushRateSample(feed([100, 200]), { at: 5000, tokens: 300 })
    expect(samples).toEqual([{ at: 5000, tokens: 300 }])
  })
  test('非法采样被忽略，不污染窗口', () => {
    const base = feed([100, 200])
    expect(pushRateSample(base, { at: Number.NaN, tokens: 1 })).toEqual(base)
    expect(pushRateSample(base, { at: 99_999, tokens: Number.POSITIVE_INFINITY })).toEqual(base)
    expect(pushRateSample(base, { at: 99_999, tokens: -1 })).toEqual(base)
  })
  test('窗口之外的旧采样被丢弃，长度有上限', () => {
    const long = feed(Array.from({ length: 200 }, (_, i) => i * 10))
    expect(long.length).toBeLessThanOrEqual(24)
    const span = long.at(-1)!.at - long[0].at
    expect(span).toBeLessThanOrEqual(RATE_WINDOW_MS + 3000 + 1000)
  })
})

describe('streamRate', () => {
  test('没有采样、只有一个采样：不显示', () => {
    expect(streamRate([], 10_000)).toBeNull()
    expect(streamRate(feed([100]), 10_000)).toBeNull()
  })
  test('两个采样但间隔不到 1 秒：不显示', () => {
    const samples = pushRateSample(pushRateSample([], { at: 10_000, tokens: 0 }), { at: 10_900, tokens: 50 })
    expect(streamRate(samples, 10_900)).toBeNull()
  })
  test('间隔刚好 1 秒就给出速率', () => {
    expect(streamRate(feed([0, 40]), 11_000)).toBe(40)
  })
  test('匀速输出得到匀速', () => {
    expect(streamRate(feed([0, 38, 76, 114, 152]), 14_000)).toBeCloseTo(38, 5)
  })
  test('是最近几秒的滑动速率，不是整轮均值', () => {
    // 前 10 秒 10 tok/s，之后 6 秒 100 tok/s：均值约 44，窗口速率应接近 100
    const tokens = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 200, 300, 400, 500, 600, 700]
    const samples = feed(tokens)
    const rate = streamRate(samples, 10_000 + 16_000)!
    expect(rate).toBeGreaterThan(90)
    expect(rate).toBeLessThanOrEqual(100)
  })
  test('任意时刻窗口不超过 5 秒', () => {
    const samples = feed([0, 0, 0, 0, 0, 0, 100, 200])
    // 窗口 [t=2..7]，起点 tokens=0，终点 200，跨度 5s
    expect(streamRate(samples, 10_000 + 7000)).toBe(40)
  })
  test('停顿 3 秒以上隐藏，而不是显示 0', () => {
    const samples = feed([0, 100, 200, 300, 300, 300, 300])
    expect(streamRate(samples, 10_000 + 6000)).toBeNull()
  })
  test('刚停顿不足 3 秒时速率平滑衰减，不骤降为 0', () => {
    const grow = feed([0, 100, 200, 300])
    const afterOne = feed([0, 100, 200, 300, 300])
    const afterTwo = feed([0, 100, 200, 300, 300, 300])
    const a = streamRate(grow, 13_000)!
    const b = streamRate(afterOne, 14_000)!
    const c = streamRate(afterTwo, 15_000)!
    expect(a).toBe(100)
    expect(b).toBeLessThan(a)
    expect(c).toBeLessThan(b)
    expect(c).toBeGreaterThan(0)
  })
  test('停顿后重新输出，速率恢复', () => {
    const samples = feed([0, 100, 200, 200, 200, 200, 200, 300, 400])
    expect(streamRate(samples, 10_000 + 8000)).toBeGreaterThan(0)
  })
  test('采样器停摆（最后一个采样超过 3 秒前）：不显示', () => {
    expect(streamRate(feed([0, 100, 200]), 12_000 + 3001)).toBeNull()
  })
  test('当前时间早于最后采样（时钟回拨）：不显示', () => {
    expect(streamRate(feed([0, 100, 200]), 11_000)).toBeNull()
  })
  test('窗口内没有增长：不显示', () => {
    expect(streamRate(feed([500, 500, 500]), 12_000)).toBeNull()
  })
  test('重置后只有一个采样，不沿用旧速率', () => {
    const samples = pushRateSample(feed([0, 100, 200]), { at: 13_000, tokens: 5 })
    expect(streamRate(samples, 13_000)).toBeNull()
  })
  test('中途才打开页面：初始已有的 token 不计入速率', () => {
    // 第一个采样就是 5000，之后每秒 +50
    expect(streamRate(feed([5000, 5050, 5100]), 12_000)).toBe(50)
  })
})

describe('formatTokenCount / formatRate', () => {
  test('量级与进位', () => {
    expect(formatTokenCount(0)).toBe('0')
    expect(formatTokenCount(847)).toBe('847')
    expect(formatTokenCount(1000)).toBe('1k')
    expect(formatTokenCount(1234)).toBe('1.2k')
    expect(formatTokenCount(76_000)).toBe('76k')
    expect(formatTokenCount(999_960)).toBe('1M')
    expect(formatTokenCount(1_250_000)).toBe('1.3M')
    expect(formatTokenCount(-1)).toBe('0')
    expect(formatTokenCount(Number.NaN)).toBe('0')
  })
  test('速率一位小数以下的才保留小数', () => {
    expect(formatRate(38.4)).toBe('38')
    expect(formatRate(9.96)).toBe('10')
    expect(formatRate(4.25)).toBe('4.3')
    expect(formatRate(3)).toBe('3')
  })
})

describe('captionTokens', () => {
  test('完整文案', () => {
    expect(captionTokens({ tokens: 1234, rate: 38.2 })).toBe('↓1.2k tokens · 38 tok/s')
  })
  test('没有速率只显示数量', () => {
    expect(captionTokens({ tokens: 1234, rate: null })).toBe('↓1.2k tokens')
    expect(captionTokens({ tokens: 1234 })).toBe('↓1.2k tokens')
  })
  test('没有 token 数整段为空，即使有速率', () => {
    expect(captionTokens({ rate: 40 })).toBe('')
    expect(captionTokens({ tokens: 0, rate: 40 })).toBe('')
    expect(captionTokens({ tokens: Number.NaN })).toBe('')
  })
  test('紧凑模式去掉 tokens 一词', () => {
    expect(captionTokens({ tokens: 850, rate: 12, compact: true })).toBe('↓850 · 12 tok/s')
  })
  test('速率为 0、负数或极小值不显示', () => {
    expect(captionTokens({ tokens: 100, rate: 0 })).toBe('↓100 tokens')
    expect(captionTokens({ tokens: 100, rate: -3 })).toBe('↓100 tokens')
    expect(captionTokens({ tokens: 100, rate: 0.01 })).toBe('↓100 tokens')
  })
})
