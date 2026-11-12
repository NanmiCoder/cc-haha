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

/** One sample per second: the tokens array corresponds to t=0,1,2… seconds. */
const feed = (tokens: number[], start = 10_000) =>
  tokens.reduce<RateSample[]>((samples, value, index) => pushRateSample(samples, { at: start + index * 1000, tokens: value }), [])

describe('turnOutputChars / turnOutputTokens', () => {
  test('Count only answer and thinking text after the last user message', () => {
    const items = [
      item('u1', 'user', 'First question'),
      item('a1', 'assistant', 'x'.repeat(4000)),
      item('u2', 'user', 'Second question'),
      item('t', 'thinking', 'y'.repeat(40)),
      item('tool', 'tool', '', { toolName: 'Bash', partialInput: 'z'.repeat(999) }),
      item('a2', 'assistant', 'z'.repeat(80)),
    ]
    expect(turnOutputChars(items)).toBe(120)
  })
  test('Text inside subagents does not count as main agent output', () => {
    const items = [
      item('u', 'user', 'Q'),
      item('a', 'assistant', 'x'.repeat(40)),
      item('sub', 'assistant', 'y'.repeat(4000), { parentToolUseId: 'tool-1' }),
    ]
    expect(turnOutputChars(items)).toBe(40)
  })
  test('With no user message or no output it is 0', () => {
    expect(turnOutputChars([])).toBe(0)
    expect(turnOutputChars([item('u', 'user', 'Q')])).toBe(0)
  })
  test('While running estimate as characters ÷ 4, with source marked estimate', () => {
    const items = [item('u', 'user', 'Q'), item('a', 'assistant', 'x'.repeat(4800))]
    expect(turnOutputTokens({ items })).toEqual({ tokens: 1200, source: 'estimate' })
  })
  test('With real usage use the real value, with source marked usage', () => {
    const items = [item('u', 'user', 'Q'), item('a', 'assistant', 'x'.repeat(4800))]
    expect(turnOutputTokens({ items, finished: { output_tokens: 1534 } })).toEqual({ tokens: 1534, source: 'usage' })
  })
  test('Fall back to the estimate when real usage is 0 or not a finite number', () => {
    const items = [item('u', 'user', 'Q'), item('a', 'assistant', 'x'.repeat(400))]
    expect(turnOutputTokens({ items, finished: { output_tokens: 0 } }).source).toBe('estimate')
    expect(turnOutputTokens({ items, finished: { output_tokens: Number.NaN } }).source).toBe('estimate')
  })
  test('estimateTokens For invalid input return 0', () => {
    expect(estimateTokens(-5)).toBe(0)
    expect(estimateTokens(Number.NaN)).toBe(0)
    expect(estimateTokens(10)).toBe(3)
  })
})

describe('pushRateSample', () => {
  test('Append by time, keeping only the newest at the same instant', () => {
    let samples = pushRateSample([], { at: 1000, tokens: 10 })
    samples = pushRateSample(samples, { at: 1000, tokens: 12 })
    expect(samples).toEqual([{ at: 1000, tokens: 12 }])
  })
  test('token On rollback (resync, new turn) restart from the new sample', () => {
    const samples = pushRateSample(feed([100, 200, 300]), { at: 13_000, tokens: 20 })
    expect(samples).toEqual([{ at: 13_000, tokens: 20 }])
  })
  test('Restart from the new sample when the clock moves back', () => {
    const samples = pushRateSample(feed([100, 200]), { at: 5000, tokens: 300 })
    expect(samples).toEqual([{ at: 5000, tokens: 300 }])
  })
  test('Invalid samples are ignored and do not pollute the window', () => {
    const base = feed([100, 200])
    expect(pushRateSample(base, { at: Number.NaN, tokens: 1 })).toEqual(base)
    expect(pushRateSample(base, { at: 99_999, tokens: Number.POSITIVE_INFINITY })).toEqual(base)
    expect(pushRateSample(base, { at: 99_999, tokens: -1 })).toEqual(base)
  })
  test('Old samples outside the window are dropped, with a length cap', () => {
    const long = feed(Array.from({ length: 200 }, (_, i) => i * 10))
    expect(long.length).toBeLessThanOrEqual(24)
    const span = long.at(-1)!.at - long[0].at
    expect(span).toBeLessThanOrEqual(RATE_WINDOW_MS + 3000 + 1000)
  })
})

describe('streamRate', () => {
  test('No samples or only one sample: not shown', () => {
    expect(streamRate([], 10_000)).toBeNull()
    expect(streamRate(feed([100]), 10_000)).toBeNull()
  })
  test('Two samples less than 1 second apart: not shown', () => {
    const samples = pushRateSample(pushRateSample([], { at: 10_000, tokens: 0 }), { at: 10_900, tokens: 50 })
    expect(streamRate(samples, 10_900)).toBeNull()
  })
  test('Exactly 1 second apart gives a rate', () => {
    expect(streamRate(feed([0, 40]), 11_000)).toBe(40)
  })
  test('Steady output gives a steady rate', () => {
    expect(streamRate(feed([0, 38, 76, 114, 152]), 14_000)).toBeCloseTo(38, 5)
  })
  test('It is a sliding rate over the last few seconds, not a whole-turn average', () => {
    // First 10 seconds at 10 tok/s, then 6 seconds at 100 tok/s: the average is about 44, and the window rate should be close to 100
    const tokens = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 200, 300, 400, 500, 600, 700]
    const samples = feed(tokens)
    const rate = streamRate(samples, 10_000 + 16_000)!
    expect(rate).toBeGreaterThan(90)
    expect(rate).toBeLessThanOrEqual(100)
  })
  test('The window never exceeds 5 seconds at any time', () => {
    const samples = feed([0, 0, 0, 0, 0, 0, 100, 200])
    // Window [t=2..7], start tokens=0, end 200, span 5s
    expect(streamRate(samples, 10_000 + 7000)).toBe(40)
  })
  test('Hidden after a pause of 3 seconds or more, instead of showing 0', () => {
    const samples = feed([0, 100, 200, 300, 300, 300, 300])
    expect(streamRate(samples, 10_000 + 6000)).toBeNull()
  })
  test('Just after a pause of under 3 seconds the rate decays smoothly instead of dropping to 0', () => {
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
  test('Output resumes after a pause and the rate recovers', () => {
    const samples = feed([0, 100, 200, 200, 200, 200, 200, 300, 400])
    expect(streamRate(samples, 10_000 + 8000)).toBeGreaterThan(0)
  })
  test('Sampler stalled (last sample more than 3 seconds ago): not shown', () => {
    expect(streamRate(feed([0, 100, 200]), 12_000 + 3001)).toBeNull()
  })
  test('Current time earlier than the last sample (clock moved back): not shown', () => {
    expect(streamRate(feed([0, 100, 200]), 11_000)).toBeNull()
  })
  test('No growth within the window: not shown', () => {
    expect(streamRate(feed([500, 500, 500]), 12_000)).toBeNull()
  })
  test('After reset with only one sample, the old rate is not reused', () => {
    const samples = pushRateSample(feed([0, 100, 200]), { at: 13_000, tokens: 5 })
    expect(streamRate(samples, 13_000)).toBeNull()
  })
  test('Page opened midway: tokens already present at the start are not counted in the rate', () => {
    // The first sample is already 5000, then each second +50
    expect(streamRate(feed([5000, 5050, 5100]), 12_000)).toBe(50)
  })
})

describe('formatTokenCount / formatRate', () => {
  test('Magnitude and rounding', () => {
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
  test('Only rates below one decimal keep decimals', () => {
    expect(formatRate(38.4)).toBe('38')
    expect(formatRate(9.96)).toBe('10')
    expect(formatRate(4.25)).toBe('4.3')
    expect(formatRate(3)).toBe('3')
  })
})

describe('captionTokens', () => {
  test('Full text', () => {
    expect(captionTokens({ tokens: 1234, rate: 38.2 })).toBe('↓1.2k tokens · 38 tok/s')
  })
  test('Without a rate only the count is shown', () => {
    expect(captionTokens({ tokens: 1234, rate: null })).toBe('↓1.2k tokens')
    expect(captionTokens({ tokens: 1234 })).toBe('↓1.2k tokens')
  })
  test('Without a token count the whole segment is empty, even with a rate', () => {
    expect(captionTokens({ rate: 40 })).toBe('')
    expect(captionTokens({ tokens: 0, rate: 40 })).toBe('')
    expect(captionTokens({ tokens: Number.NaN })).toBe('')
  })
  test('Compact mode drops the word tokens', () => {
    expect(captionTokens({ tokens: 850, rate: 12, compact: true })).toBe('↓850 · 12 tok/s')
  })
  test('Rates of 0, negative or tiny values are not shown', () => {
    expect(captionTokens({ tokens: 100, rate: 0 })).toBe('↓100 tokens')
    expect(captionTokens({ tokens: 100, rate: -3 })).toBe('↓100 tokens')
    expect(captionTokens({ tokens: 100, rate: 0.01 })).toBe('↓100 tokens')
  })
})
