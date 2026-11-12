import { describe, expect, it } from 'vitest'

import { describeTokenAmount, formatTokenAmount, formatTokenAmountExact } from './formatTokenUnits'

describe('formatTokenAmount', () => {
  it('counts in k / M / B / T for English', () => {
    expect(formatTokenAmount(847, 'en').text).toBe('847')
    expect(formatTokenAmount(1_250, 'en').text).toBe('1.3k')
    expect(formatTokenAmount(12_480, 'en').text).toBe('12.5k')
    expect(formatTokenAmount(342_000_000, 'en').text).toBe('342M')
    expect(formatTokenAmount(24_100_000_000, 'en')).toEqual({ value: '24.1', unit: 'B', text: '24.1B' })
    expect(formatTokenAmount(1_500_000_000_000, 'en').text).toBe('1.5T')
  })

  it('rolls a rounded value over into the next unit instead of printing 1000k', () => {
    expect(formatTokenAmount(999_950, 'en').text).toBe('1M')
    expect(formatTokenAmount(999_950_000, 'en').text).toBe('1B')
  })

  it('drops a trailing .0 and keeps whole numbers at three digits', () => {
    expect(formatTokenAmount(2_000_000_000, 'en').text).toBe('2B')
    expect(formatTokenAmount(123_456_000, 'en').text).toBe('123M')
    expect(formatTokenAmount(1_234_000_000_000_000, 'en').text).toBe('1,234T')
  })

  it('shows a placeholder for values that are not token counts', () => {
    expect(formatTokenAmount(Number.NaN, 'en').text).toBe('--')
    expect(formatTokenAmount(-1, 'en').text).toBe('--')
    expect(formatTokenAmount(0, 'en').text).toBe('0')
  })
})

describe('describeTokenAmount', () => {
  it('gives the exact number', () => {
    expect(formatTokenAmountExact(24_100_000_000)).toBe('24,100,000,000')
    expect(describeTokenAmount(24_100_000_000, 'en')).toEqual({ exact: '24,100,000,000' })
  })
})
