export type Rgba = { r: number; g: number; b: number; a: number }

const HEX_PATTERN = /^#([0-9a-f]+)$/i
const FUNCTIONAL_PATTERN = /^rgba?\(([^)]*)\)$/i

function clampChannel(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(255, Math.max(0, Math.round(value)))
}

function clampAlpha(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(1, Math.max(0, value))
}

function parseChannel(token: string): number | null {
  const raw = token.trim()
  if (!raw) return null
  const percent = raw.endsWith('%')
  const parsed = Number.parseFloat(percent ? raw.slice(0, -1) : raw)
  if (Number.isNaN(parsed)) return null
  return clampChannel(percent ? (parsed / 100) * 255 : parsed)
}

function parseAlpha(token: string | undefined): number | null {
  if (token === undefined) return 1
  const raw = token.trim()
  if (!raw) return null
  const percent = raw.endsWith('%')
  const parsed = Number.parseFloat(percent ? raw.slice(0, -1) : raw)
  if (Number.isNaN(parsed)) return null
  return clampAlpha(percent ? parsed / 100 : parsed)
}

function expand(hexDigit: string): number {
  return Number.parseInt(hexDigit + hexDigit, 16)
}

function parseHex(digits: string): Rgba | null {
  if (digits.length === 3 || digits.length === 4) {
    return {
      r: expand(digits[0]!),
      g: expand(digits[1]!),
      b: expand(digits[2]!),
      a: digits.length === 4 ? expand(digits[3]!) / 255 : 1,
    }
  }
  if (digits.length === 6 || digits.length === 8) {
    return {
      r: Number.parseInt(digits.slice(0, 2), 16),
      g: Number.parseInt(digits.slice(2, 4), 16),
      b: Number.parseInt(digits.slice(4, 6), 16),
      a: digits.length === 8 ? Number.parseInt(digits.slice(6, 8), 16) / 255 : 1,
    }
  }
  return null
}

/**
 * Parse the color forms getComputedStyle returns (rgb/rgba/hex/transparent), plus the modern
 * space syntax users may type, `rgb(0 0 0 / 50%)`. Returns null when unrecognized; callers
 * should keep the user's raw input instead of guessing a color.
 */
export function parseCssColor(input: string): Rgba | null {
  const value = input.trim().toLowerCase()
  if (!value) return null
  if (value === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }

  const hex = HEX_PATTERN.exec(value)
  if (hex) return parseHex(hex[1]!)

  const functional = FUNCTIONAL_PATTERN.exec(value)
  if (!functional) return null

  const [channelPart, slashAlpha, ...extraSlashes] = functional[1]!.split('/')
  if (extraSlashes.length > 0) return null
  const tokens = channelPart!.trim().split(/[\s,]+/).filter(Boolean)
  const [red, green, blue, commaAlpha] = tokens
  if (!red || !green || !blue) return null
  if (slashAlpha !== undefined && commaAlpha !== undefined) return null
  if (tokens.length > 4) return null

  const r = parseChannel(red)
  const g = parseChannel(green)
  const b = parseChannel(blue)
  const a = parseAlpha(slashAlpha ?? commaAlpha)
  if (r === null || g === null || b === null || a === null) return null
  return { r, g, b, a }
}

/** `<input type="color">` only accepts #rrggbb; alpha is dropped here. */
export function toHexColor(color: Rgba): string {
  const channel = (value: number) => clampChannel(value).toString(16).padStart(2, '0')
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`
}

/** Canonical form written back to the page and diff: transparent when fully clear, rgba() when translucent, hex otherwise. */
export function formatCssColor(color: Rgba): string {
  const alpha = clampAlpha(color.a)
  if (alpha <= 0) return 'transparent'
  if (alpha >= 1) return toHexColor(color)
  return `rgba(${clampChannel(color.r)}, ${clampChannel(color.g)}, ${clampChannel(color.b)}, ${Number(alpha.toFixed(3))})`
}

/** Dark backgrounds need a light foreground; used to pick the contrast color for swatch borders / checkerboards. */
export function isDarkColor(color: Rgba): boolean {
  const luminance = (0.299 * color.r + 0.587 * color.g + 0.114 * color.b) / 255
  return luminance < 0.5
}
