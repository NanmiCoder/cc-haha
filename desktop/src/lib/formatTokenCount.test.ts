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
    expect(formatTokenCount(2_000_000)).toBe('2M')
  })

  it('formats millions with an uppercase M so they never read as minutes', () => {
    expect(formatTokenCount(2_400_000)).toBe('2.4M')
    expect(formatTokenCount(145_900_000)).toBe('145.9M')
  })

  it('formats billions with a B suffix instead of growing into four-digit M values', () => {
    expect(formatTokenCount(1_500_000_000)).toBe('1.5B')
    expect(formatTokenCount(20_000_000_000)).toBe('20B')
  })

  it('uses one notation for every surface that renders token usage (#1465)', () => {
    // The activity settings page used to keep a second formatter whose rounding
    // and casing disagreed with this one for the same input.
    expect(formatTokenCount(1_200)).toBe('1.2k')
    expect(formatTokenCount(1_500)).toBe('1.5k')
    expect(formatTokenCount(2_000_000)).toBe('2M')
  })
})
