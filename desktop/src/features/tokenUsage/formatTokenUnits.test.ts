import { describe, expect, it } from 'vitest'

import { describeTokenAmount, formatTokenAmount, formatTokenAmountExact } from './formatTokenUnits'

describe('formatTokenAmount', () => {
  it('counts in 万 and 亿 for Chinese', () => {
    expect(formatTokenAmount(8_432, 'zh').text).toBe('8,432')
    expect(formatTokenAmount(12_480, 'zh').text).toBe('1.2万')
    expect(formatTokenAmount(1_250_000, 'zh').text).toBe('125万')
    expect(formatTokenAmount(342_000_000, 'zh').text).toBe('3.4亿')
    expect(formatTokenAmount(2_100_000_000, 'zh').text).toBe('21亿')
    expect(formatTokenAmount(24_100_000_000, 'zh')).toEqual({ value: '241', unit: '亿', text: '241亿' })
    expect(formatTokenAmount(1_500_000_000_000, 'zh').text).toBe('1.5万亿')
  })

  it('counts in k / M / B / T for English', () => {
    expect(formatTokenAmount(847, 'en').text).toBe('847')
    expect(formatTokenAmount(1_250, 'en').text).toBe('1.3k')
    expect(formatTokenAmount(12_480, 'en').text).toBe('12.5k')
    expect(formatTokenAmount(342_000_000, 'en').text).toBe('342M')
    expect(formatTokenAmount(24_100_000_000, 'en')).toEqual({ value: '24.1', unit: 'B', text: '24.1B' })
    expect(formatTokenAmount(1_500_000_000_000, 'en').text).toBe('1.5T')
  })

  it('uses each East Asian language\'s own characters', () => {
    expect(formatTokenAmount(24_100_000_000, 'zh-TW').text).toBe('241億')
    expect(formatTokenAmount(24_100_000_000, 'jp').text).toBe('241億')
    expect(formatTokenAmount(24_100_000_000, 'kr').text).toBe('241억')
    expect(formatTokenAmount(50_000, 'zh-TW').text).toBe('5萬')
    expect(formatTokenAmount(50_000, 'kr').text).toBe('5만')
    expect(formatTokenAmount(3_000_000_000_000, 'jp').text).toBe('3兆')
    expect(formatTokenAmount(3_000_000_000_000, 'kr').text).toBe('3조')
  })

  it('rolls a rounded value over into the next unit instead of printing 1000k', () => {
    expect(formatTokenAmount(999_950, 'en').text).toBe('1M')
    expect(formatTokenAmount(99_995_000, 'zh').text).toBe('1亿')
  })

  it('drops a trailing .0 and keeps whole numbers at three digits', () => {
    expect(formatTokenAmount(2_000_000_000, 'en').text).toBe('2B')
    expect(formatTokenAmount(123_456_000, 'en').text).toBe('123M')
    expect(formatTokenAmount(1_234_000_000_000_000, 'en').text).toBe('1,234T')
  })

  it('shows a placeholder for values that are not token counts', () => {
    expect(formatTokenAmount(Number.NaN, 'en').text).toBe('--')
    expect(formatTokenAmount(-1, 'zh').text).toBe('--')
    expect(formatTokenAmount(0, 'zh').text).toBe('0')
  })
})

describe('describeTokenAmount', () => {
  it('gives the exact number and the other family\'s notation', () => {
    expect(formatTokenAmountExact(24_100_000_000)).toBe('24,100,000,000')
    expect(describeTokenAmount(24_100_000_000, 'zh')).toEqual({ exact: '24,100,000,000', alternate: '24.1B' })
    expect(describeTokenAmount(24_100_000_000, 'en')).toEqual({ exact: '24,100,000,000', alternate: '241亿' })
    expect(describeTokenAmount(24_100_000_000, 'jp').alternate).toBe('24.1B')
  })
})
