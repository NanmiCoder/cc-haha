import { describe, expect, mock, test } from 'bun:test'

mock.module('react-native', () => ({
  Platform: {
    OS: 'ios',
    select: <T,>(values: { ios?: T; android?: T; default?: T }) =>
      values.ios ?? values.default,
  },
}))

const { dark, light, type } = await import('./palette')
type PaletteKey = keyof typeof light

function linearizeChannel(channel: number): number {
  const normalized = channel / 255
  return normalized <= 0.03928
    ? normalized / 12.92
    : Math.pow((normalized + 0.055) / 1.055, 2.4)
}

function relativeLuminance(hex: string): number {
  if (!/^#[0-9A-Fa-f]{6}$/.test(hex)) {
    throw new Error(`Expected 6-digit hex color, received ${hex}`)
  }
  const value = parseInt(hex.slice(1), 16)
  const r = linearizeChannel((value >> 16) & 255)
  const g = linearizeChannel((value >> 8) & 255)
  const b = linearizeChannel(value & 255)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrastRatio(foreground: string, background: string): number {
  const l1 = relativeLuminance(foreground)
  const l2 = relativeLuminance(background)
  const lighter = Math.max(l1, l2)
  const darker = Math.min(l1, l2)
  return (lighter + 0.05) / (darker + 0.05)
}

const CONTRAST_PAIRS: readonly (readonly [PaletteKey, PaletteKey])[] = [
  // Primary, secondary, and tertiary inks across all neutral surfaces
  ...(['ink', 'ink2', 'ink3'] as const).flatMap((fg) =>
    (['bg', 'card', 'cardRaised', 'sheet', 'fill', 'bubble'] as const).map(
      (bg) => [fg, bg] as const
    )
  ),
  // Buttons, brand pills, and semantic status pills
  ['btnInk', 'btn'],
  ['onBrand', 'brand'],
  ['brandInk', 'brandSoft'],
  ['attnInk', 'attnSoft'],
  ['okInk', 'okSoft'],
  ['errInk', 'errSoft'],
  ['onErr', 'err'],
  // Diff highlights
  ['addInk', 'addBg'],
  ['delInk', 'delBg'],
  // Syntax highlighting tokens on code surface
  ['kw', 'code'],
  ['str', 'code'],
  ['ty', 'code'],
  ['cm', 'code'],
]

describe('V6C WCAG 2.1 AA contrast compliance (>= 4.5:1)', () => {
  for (const [schemeName, palette] of [
    ['light', light],
    ['dark', dark],
  ] as const) {
    test(`${schemeName} palette satisfies >= 4.5:1 contrast across all foreground/background pairs`, () => {
      expect(type.body.fontSize).toBeGreaterThanOrEqual(14)
      const failures: string[] = []
      for (const [fgKey, bgKey] of CONTRAST_PAIRS) {
        const fg = palette[fgKey]
        const bg = palette[bgKey]
        const ratio = contrastRatio(fg, bg)
        if (ratio < 4.5) {
          failures.push(
            `${schemeName}.${fgKey} (${fg}) on ${schemeName}.${bgKey} (${bg}) = ${ratio.toFixed(2)}:1`
          )
        }
      }
      expect(failures).toEqual([])
    })
  }
})
