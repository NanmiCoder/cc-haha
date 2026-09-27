import { describe, expect, it } from 'vitest'
import {
  deriveSessionUsageMetrics,
  formatCacheHitRate,
  formatCompactTokens,
  formatTokensPerSecond,
} from './sessionUsageMetrics'

function usage(overrides: Partial<Parameters<typeof deriveSessionUsageMetrics>[0]> = {}) {
  return {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadInputTokens: 0,
    totalCacheCreationInputTokens: 0,
    ...overrides,
  }
}

describe('deriveSessionUsageMetrics', () => {
  it('counts new tokens as uncached input plus output, not every cache hit', () => {
    const metrics = deriveSessionUsageMetrics(usage({
      totalInputTokens: 1_000,
      totalOutputTokens: 200,
      totalCacheReadInputTokens: 8_000,
      totalCacheCreationInputTokens: 500,
    }))

    // Cache reads are the same prompt seen again. Folding them into the headline made a
    // 270k-window agent loop read as tens of millions of "total tokens".
    expect(metrics.totalTokens).toBe(1_200)
    expect(metrics.promptTokens).toBe(9_500)
    expect(metrics.cachedTokens).toBe(8_000)
  })

  it('measures cache hits against the prompt side, never against output', () => {
    const metrics = deriveSessionUsageMetrics(usage({
      totalInputTokens: 1_000,
      totalOutputTokens: 9_000,
      totalCacheReadInputTokens: 9_000,
    }))

    // 9000 / (1000 + 9000) — a denominator that included output would report 82% here and
    // let a chatty reply make the cache look worse than it is.
    expect(metrics.cacheHitRate).toBeCloseTo(0.9, 10)
  })

  it('withholds a cache hit rate until prompt tokens exist', () => {
    expect(deriveSessionUsageMetrics(usage({ totalOutputTokens: 500 })).cacheHitRate).toBeNull()
  })

  it('derives tokens per second from API wall-clock, including prefill', () => {
    const metrics = deriveSessionUsageMetrics(usage({
      totalOutputTokens: 1_000,
      totalAPIDuration: 5_000,
      totalDecodeDuration: 2_000,
    }))

    // Decode-only would report 500 here and ignore the wait the user actually sat through.
    expect(metrics.tokensPerSecond).toBe(200)
  })

  it('withholds tokens per second when no API duration was reported', () => {
    // Transcript-sourced usage has no request timing. Falling back to session wall clock would
    // divide by a span that includes tool execution and invent a rate.
    const metrics = deriveSessionUsageMetrics(usage({
      totalOutputTokens: 1_000,
      totalAPIDuration: 0,
      totalDecodeDuration: 5_000,
    }))

    expect(metrics.tokensPerSecond).toBeNull()
  })

  it('does not treat a long cached agent loop as tens of millions of new tokens', () => {
    // Session 34680654: 223 API rounds, ~270k window, 98% cache hits. The old headline
    // summed cache reads and printed 40M; the speed used decode-only and printed 512 tok/s.
    const metrics = deriveSessionUsageMetrics(usage({
      totalInputTokens: 225_888,
      totalOutputTokens: 166_998,
      totalCacheReadInputTokens: 53_480_064,
      totalAPIDuration: 1_480_000,
      totalDecodeDuration: 326_000,
    }))

    expect(metrics.totalTokens).toBe(392_886)
    expect(metrics.cacheHitRate).toBeCloseTo(53_480_064 / (225_888 + 53_480_064), 10)
    expect(metrics.tokensPerSecond).toBeCloseTo(166_998 / 1_480, 6)
  })

  it('treats missing and non-finite fields as zero rather than NaN', () => {
    const metrics = deriveSessionUsageMetrics({
      totalInputTokens: Number.NaN,
      totalOutputTokens: 100,
      totalCacheReadInputTokens: undefined as unknown as number,
      totalCacheCreationInputTokens: -5,
      totalAPIDuration: undefined,
    })

    expect(metrics.totalTokens).toBe(100)
    expect(metrics.cacheHitRate).toBeNull()
    expect(metrics.tokensPerSecond).toBeNull()
  })
})

describe('formatCacheHitRate', () => {
  it.each([
    [0, '0%'],
    [0.5, '50.0%'],
    [0.982, '98.2%'],
    [1, '100%'],
  ])('renders %s as %s', (rate, expected) => {
    expect(formatCacheHitRate(rate)).toBe(expected)
  })

  it('never rounds a partial hit up to a flat 100%', () => {
    // 0.9996 * 100 = 99.96 -> toFixed(1) would print "100.0%", which claims a perfect cache.
    expect(formatCacheHitRate(0.9996)).toBe('99.96%')
  })

  it('floors rates that round to 100.00 at two decimals', () => {
    expect(formatCacheHitRate(0.999_999)).toBe('99.99%')
  })

  it('clamps nonsense to a displayable value', () => {
    expect(formatCacheHitRate(Number.NaN)).toBe('0%')
    expect(formatCacheHitRate(-1)).toBe('0%')
  })
})

describe('formatTokensPerSecond', () => {
  it('keeps a decimal only where it carries information', () => {
    expect(formatTokensPerSecond(9.44)).toBe('9.4')
    expect(formatTokensPerSecond(42.6)).toBe('43')
    expect(formatTokensPerSecond(1_234.9)).toBe('1235')
  })

  it('renders an unavailable rate as a placeholder, not zero', () => {
    expect(formatTokensPerSecond(0)).toBe('--')
    expect(formatTokensPerSecond(Number.NaN)).toBe('--')
  })
})

describe('formatCompactTokens', () => {
  it.each([
    [812, '812'],
    [9_500, '9.5K'],
    [375_372, '375K'],
    [8_100_000, '8.1M'],
  ])('renders %s as %s', (value, expected) => {
    expect(formatCompactTokens(value)).toBe(expected)
  })

  it('promotes a value that would round into a four-digit smaller unit', () => {
    // 999_949/1000 rounds to "1000" at zero decimals; showing "1000K" reads as a bug.
    expect(formatCompactTokens(999_949)).toBe('1.0M')
  })
})
