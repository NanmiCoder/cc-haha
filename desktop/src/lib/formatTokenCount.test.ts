import { describe, expect, it } from 'vitest'
import { formatTokenCount } from './formatTokenCount'

describe('formatTokenCount', () => {
  it('formats missing or invalid values as --', () => {
    expect(formatTokenCount()).toBe('--')
    expect(formatTokenCount(Number.NaN)).toBe('--')
    expect(formatTokenCount(-1)).toBe('--')
  })

  it('formats counts below 1000 verbatim', () => {
    expect(formatTokenCount(0)).toBe('0')
    expect(formatTokenCount(847)).toBe('847')
  })

  it('formats thousands with one decimal and a k suffix', () => {
    expect(formatTokenCount(1234)).toBe('1.2k')
    expect(formatTokenCount(38_500)).toBe('38.5k')
    expect(formatTokenCount(124_320)).toBe('124.3k')
  })

  it('drops the trailing .0 to match the CLI notation', () => {
    expect(formatTokenCount(1000)).toBe('1k')
    expect(formatTokenCount(2_000_000)).toBe('2m')
  })

  it('formats millions with an m suffix', () => {
    expect(formatTokenCount(2_400_000)).toBe('2.4m')
  })
})
