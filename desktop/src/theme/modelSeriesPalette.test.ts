import { describe, expect, it } from 'vitest'

import css from './globals.css?raw'

/**
 * The colors that tell models apart in the Token usage charts, held to the gates a categorical
 * palette has to clear to be read at a glance. The previous set looked muted and was: four of its
 * five colors had too little chroma to read as colors at all, and two neighbours sat only ΔE 13.6
 * apart. Nothing in the stylesheet would have said so.
 *
 * Thresholds (OKLab ΔE ×100 and OKLCH): chroma ≥ 0.10 so a hue reads as a hue; neighbours ≥ 15 apart
 * for full-color vision and ≥ 8 under protanopia / deuteranopia (Machado 2009, severity 1); marks
 * ≥ 3:1 against the theme ground. Slot 5 is the neutral gray every other model shares, so it is held
 * to separation but not to chroma or contrast: it is meant to recede, and the legend names it.
 */

const normalizedCss = css.replace(/\r\n/g, '\n')

const themes = [
  ':root,\n[data-theme="white"]',
  '[data-theme="paper"]',
  '[data-theme="warm-classic"]',
  '[data-theme="celadon"]',
  '[data-theme="dark"]',
  '[data-theme="ink-blue"]',
] as const

/** Every block written against `selector`: a theme can also be named in a shared rule elsewhere. */
function themeBlock(selector: string) {
  const bodies: string[] = []
  let cursor = 0
  for (;;) {
    const start = normalizedCss.indexOf(`${selector} {`, cursor)
    if (start < 0) break
    const open = normalizedCss.indexOf('{', start)
    let depth = 0
    for (let index = open; index < normalizedCss.length; index += 1) {
      if (normalizedCss[index] === '{') depth += 1
      if (normalizedCss[index] === '}') {
        depth -= 1
        if (depth === 0) {
          bodies.push(normalizedCss.slice(open + 1, index))
          cursor = index
          break
        }
      }
    }
  }
  expect(bodies.length, `missing theme block ${selector}`).toBeGreaterThan(0)
  return bodies.join('\n')
}

function token(block: string, name: string) {
  const match = new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6})\\b`).exec(block)
  expect(match, `${name} should be a hex color`).not.toBeNull()
  return match![1]!.toUpperCase()
}

type Rgb = [number, number, number]

const linear = (hex: string): Rgb =>
  [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as Rgb

function oklab([r, g, b]: Rgb): Rgb {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

const PROTAN = [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]]
const DEUTAN = [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]]

function simulate(rgb: Rgb, matrix: number[][]): Rgb {
  return matrix.map((row) => Math.max(0, Math.min(1, row[0]! * rgb[0] + row[1]! * rgb[1] + row[2]! * rgb[2]))) as Rgb
}

function deltaE(a: string, b: string, matrix?: number[][]) {
  const [la, lb] = [linear(a), linear(b)]
  const [x, y] = [oklab(matrix ? simulate(la, matrix) : la), oklab(matrix ? simulate(lb, matrix) : lb)]
  return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2])
}

const lightness = (hex: string) => oklab(linear(hex))[0]
const chroma = (hex: string) => Math.hypot(oklab(linear(hex))[1], oklab(linear(hex))[2])

function contrast(a: string, b: string) {
  const luminance = (hex: string) => {
    const [r, g, bl] = linear(hex)
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl
  }
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

describe('model series palette', () => {
  for (const selector of themes) {
    const name = selector.replace(/^:root,\n/, '')

    it(`${name}: four real hues that stay apart, then a neutral gray for the rest`, () => {
      const block = themeBlock(selector)
      const ground = token(block, '--cc-bg')
      const series = [1, 2, 3, 4, 5].map((slot) => token(block, `--cc-series-${slot}`))
      const colored = series.slice(0, 4)
      const dark = lightness(ground) < 0.5
      const [lo, hi] = dark ? [0.48, 0.67] : [0.43, 0.77]

      for (const hex of colored) {
        expect(chroma(hex), `${name} ${hex} reads as gray`).toBeGreaterThanOrEqual(0.1)
        expect(lightness(hex), `${name} ${hex} is outside the lightness band`).toBeGreaterThanOrEqual(lo)
        expect(lightness(hex), `${name} ${hex} is outside the lightness band`).toBeLessThanOrEqual(hi)
        expect(contrast(hex, ground), `${name} ${hex} is under 3:1 on its ground`).toBeGreaterThanOrEqual(3)
      }

      // Neighbours are what touch in a stack, and the legend reads in the same order.
      for (let slot = 0; slot < series.length - 1; slot += 1) {
        const [a, b] = [series[slot]!, series[slot + 1]!]
        expect(deltaE(a, b), `${name} ${a} and ${b} are hard to tell apart`).toBeGreaterThanOrEqual(15)
        const cvd = Math.min(deltaE(a, b, PROTAN), deltaE(a, b, DEUTAN))
        expect(cvd, `${name} ${a} and ${b} merge for a color-blind reader`).toBeGreaterThanOrEqual(8)
      }

      // "Other" must not be mistaken for a model.
      expect(chroma(series[4]!), `${name} the "other" gray carries a hue`).toBeLessThan(0.05)
    })

    it(`${name}: the brand accent is not also a model color`, () => {
      const block = themeBlock(selector)
      const accent = token(block, '--cc-ac')
      for (const slot of [1, 2, 3, 4, 5]) {
        expect(token(block, `--cc-series-${slot}`)).not.toBe(accent)
      }
    })
  }
})
