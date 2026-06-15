import { describe, expect, it } from 'vitest'
import { formatClockTime, formatDurationMs, formatTokenCount, formatUsageBrief } from './formatters'

describe('formatDurationMs', () => {
  it('formats missing or invalid values as --', () => {
    expect(formatDurationMs()).toBe('--')
    expect(formatDurationMs(Number.NaN)).toBe('--')
    expect(formatDurationMs(-5)).toBe('--')
  })

  it('formats sub-second durations in milliseconds', () => {
    expect(formatDurationMs(0)).toBe('0ms')
    expect(formatDurationMs(340)).toBe('340ms')
    expect(formatDurationMs(999)).toBe('999ms')
  })

  it('formats seconds with two decimals below 10s and without decimals above', () => {
    expect(formatDurationMs(1250)).toBe('1.25s')
    expect(formatDurationMs(9990)).toBe('9.99s')
    expect(formatDurationMs(10_000)).toBe('10s')
    expect(formatDurationMs(42_300)).toBe('42s')
  })

  it('formats minutes with zero-padded seconds', () => {
    expect(formatDurationMs(60_000)).toBe('1m 00s')
    expect(formatDurationMs(65_000)).toBe('1m 05s')
    expect(formatDurationMs(125_000)).toBe('2m 05s')
  })
})

describe('formatTokenCount', () => {
  // Full coverage lives in ../formatTokenCount.test.ts; this verifies the re-export.
  it('re-exports the shared compact formatter', () => {
    expect(formatTokenCount(1234)).toBe('1.2k')
    expect(formatTokenCount(1000)).toBe('1k')
  })
})

describe('formatUsageBrief', () => {
  it('formats missing usage as --', () => {
    expect(formatUsageBrief()).toBe('--')
  })

  it('formats input and output token counts', () => {
    expect(formatUsageBrief({ inputTokens: 1234, outputTokens: 847 })).toBe('1.2k → 847')
    expect(formatUsageBrief({ inputTokens: 12, outputTokens: 38_500, cacheReadInputTokens: 4 })).toBe('12 → 38.5k')
  })
})

describe('formatClockTime', () => {
  it('formats a valid iso timestamp with the locale time formatter', () => {
    const iso = '2026-06-09T10:09:59.000Z'
    const expected = new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    expect(formatClockTime(iso)).toBe(expected)
  })

  it('returns the input when the timestamp is invalid', () => {
    expect(formatClockTime('not-a-date')).toBe('not-a-date')
  })
})
