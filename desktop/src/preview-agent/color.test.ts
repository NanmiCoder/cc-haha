import { describe, expect, it } from 'vitest'
import { formatCssColor, isDarkColor, parseCssColor, toHexColor } from './color'

describe('parseCssColor', () => {
  it('parses the rgb / rgba forms getComputedStyle returns', () => {
    expect(parseCssColor('rgb(26, 29, 41)')).toEqual({ r: 26, g: 29, b: 41, a: 1 })
    expect(parseCssColor('rgba(255, 255, 255, 0.5)')).toEqual({ r: 255, g: 255, b: 255, a: 0.5 })
    expect(parseCssColor('rgba(0, 0, 0, 0)')).toEqual({ r: 0, g: 0, b: 0, a: 0 })
  })

  it('parses 3/4/6/8-digit hex', () => {
    expect(parseCssColor('#abc')).toEqual({ r: 170, g: 187, b: 204, a: 1 })
    expect(parseCssColor('#1a1d29')).toEqual({ r: 26, g: 29, b: 41, a: 1 })
    expect(parseCssColor('#ff000080')).toEqual({ r: 255, g: 0, b: 0, a: 128 / 255 })
    expect(parseCssColor('#F00')).toEqual({ r: 255, g: 0, b: 0, a: 1 })
  })

  it('parses transparent and the modern space / slash syntax', () => {
    expect(parseCssColor('transparent')).toEqual({ r: 0, g: 0, b: 0, a: 0 })
    expect(parseCssColor('rgb(10 20 30)')).toEqual({ r: 10, g: 20, b: 30, a: 1 })
    expect(parseCssColor('rgb(10 20 30 / 50%)')).toEqual({ r: 10, g: 20, b: 30, a: 0.5 })
  })

  it('clamps channels to 0-255 and alpha to 0-1', () => {
    expect(parseCssColor('rgb(300, -20, 12)')).toEqual({ r: 255, g: 0, b: 12, a: 1 })
    expect(parseCssColor('rgba(0, 0, 0, 2)')).toEqual({ r: 0, g: 0, b: 0, a: 1 })
  })

  it('returns null for unrecognized input instead of guessing', () => {
    expect(parseCssColor('')).toBeNull()
    expect(parseCssColor('   ')).toBeNull()
    expect(parseCssColor('rebeccapurple')).toBeNull()
    expect(parseCssColor('#ab')).toBeNull()
    expect(parseCssColor('#abcde')).toBeNull()
    expect(parseCssColor('rgb(1, 2)')).toBeNull()
    expect(parseCssColor('rgb(1, 2, 3, 4, 5)')).toBeNull()
    expect(parseCssColor('rgb(a, b, c)')).toBeNull()
    expect(parseCssColor('color(srgb 0 0 0)')).toBeNull()
  })
})

describe('toHexColor', () => {
  it('outputs zero-padded 6-digit hex and drops alpha', () => {
    expect(toHexColor({ r: 26, g: 29, b: 41, a: 1 })).toBe('#1a1d29')
    expect(toHexColor({ r: 0, g: 0, b: 0, a: 0 })).toBe('#000000')
    expect(toHexColor({ r: 255, g: 255, b: 255, a: 0.2 })).toBe('#ffffff')
  })
})

describe('formatCssColor', () => {
  it('writes hex when opaque, rgba when translucent, transparent when clear', () => {
    expect(formatCssColor({ r: 26, g: 29, b: 41, a: 1 })).toBe('#1a1d29')
    expect(formatCssColor({ r: 255, g: 0, b: 0, a: 0.5 })).toBe('rgba(255, 0, 0, 0.5)')
    expect(formatCssColor({ r: 12, g: 34, b: 56, a: 0 })).toBe('transparent')
  })

  it('keeps three decimals of alpha to avoid float noise', () => {
    expect(formatCssColor({ r: 0, g: 0, b: 0, a: 128 / 255 })).toBe('rgba(0, 0, 0, 0.502)')
  })

  it('round-trips with parseCssColor', () => {
    for (const value of ['#1a1d29', 'rgba(255, 0, 0, 0.5)', 'transparent']) {
      expect(formatCssColor(parseCssColor(value)!)).toBe(value)
    }
  })
})

describe('isDarkColor', () => {
  it('decides dark vs light by perceived luminance', () => {
    expect(isDarkColor({ r: 0, g: 0, b: 0, a: 1 })).toBe(true)
    expect(isDarkColor({ r: 26, g: 29, b: 41, a: 1 })).toBe(true)
    expect(isDarkColor({ r: 255, g: 255, b: 255, a: 1 })).toBe(false)
    expect(isDarkColor({ r: 255, g: 255, b: 0, a: 1 })).toBe(false)
  })
})
