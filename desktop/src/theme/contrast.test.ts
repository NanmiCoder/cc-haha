import { describe, expect, it } from 'vitest'

import rawCss from './globals.css?raw'

const css = rawCss.replace(/\r\n/g, '\n')

/**
 * Contrast guard for the status palette.
 *
 * This exists because the light theme shipped a warning badge at 2.66:1 —
 * unreadable, and invisible to every other kind of test: the structure was
 * right, the ARIA was right, the token names were right, and the two other
 * themes were fine. It only showed up when the colors were actually resolved
 * and measured.
 *
 * Tokens are resolved from the stylesheet rather than from a browser, so this
 * runs in the normal unit suite.
 */

type Rgb = { r: number; g: number; b: number; a: number }

/**
 * Each theme resolves through three layers: its own `--cc-*` source block,
 * then the shared `:root` semantic layer that maps `--color-*` onto those
 * sources, then `@theme` for anything Tailwind supplies statically.
 *
 * The two ink themes additionally override part of the semantic layer, so
 * their combined block is listed ahead of `:root`.
 */
const THEME_BLOCKS = {
  white: [':root,\n[data-theme="white"]', ':root', '@theme'],
  paper: ['[data-theme="paper"]', ':root', '@theme'],
  'warm-classic': ['[data-theme="warm-classic"]', ':root', '@theme'],
  celadon: ['[data-theme="celadon"]', ':root', '@theme'],
  dark: ['[data-theme="dark"]', '[data-theme="dark"],\n[data-theme="ink-blue"]', ':root', '@theme'],
  'ink-blue': ['[data-theme="ink-blue"]', '[data-theme="dark"],\n[data-theme="ink-blue"]', ':root', '@theme'],
} as const

/**
 * Concatenates every block written against `selector`.
 *
 * A selector legitimately appears more than once — `:root` carries the
 * layering scale, the ANSI palette, and the semantic layer as separate blocks
 * — and later declarations win. Reading only the first match resolved
 * `--color-surface` against the z-index scale and threw "unresolved token".
 */
function blockBody(selector: string): string {
  const bodies: string[] = []
  let cursor = 0
  for (;;) {
    const start = css.indexOf(`${selector} {`, cursor)
    if (start < 0) break
    const open = css.indexOf('{', start)
    let depth = 0
    for (let i = open; i < css.length; i += 1) {
      if (css[i] === '{') depth += 1
      if (css[i] === '}') {
        depth -= 1
        if (depth === 0) {
          bodies.push(css.slice(open + 1, i))
          cursor = i
          break
        }
      }
    }
    if (cursor < open) throw new Error(`Unclosed block: ${selector}`)
  }
  if (bodies.length === 0) throw new Error(`Missing block: ${selector}`)
  // Later blocks win, so search them first.
  return bodies.reverse().join('\n')
}

/** Reads a token from the first block that defines it, following aliases. */
function resolve(token: string, selectors: readonly string[], seen = new Set<string>()): string {
  if (seen.has(token)) throw new Error(`Cyclic token: ${token}`)
  seen.add(token)

  for (const selector of selectors) {
    const match = blockBody(selector).match(new RegExp(`${token}\\s*:\\s*([^;]+);`))
    if (!match) continue
    const value = match[1]!.trim()
    const alias = value.match(/^var\(\s*(--[\w-]+)\s*\)$/)
    return alias ? resolve(alias[1]!, selectors, seen) : value
  }
  throw new Error(`Unresolved token: ${token}`)
}

function parseColor(value: string): Rgb {
  const hex = value.match(/^#([0-9a-f]{6})$/i)
  if (hex) {
    const n = parseInt(hex[1]!, 16)
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 }
  }
  const rgba = value.match(/^rgba?\(([^)]+)\)$/i)
  if (rgba) {
    const parts = rgba[1]!.split(',').map((p) => Number(p.trim()))
    return { r: parts[0]!, g: parts[1]!, b: parts[2]!, a: parts[3] ?? 1 }
  }
  throw new Error(`Unsupported color: ${value}`)
}

/** Flattens a translucent color onto an opaque one, as the compositor would. */
function flatten(fg: Rgb, bg: Rgb): Rgb {
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  }
}

function luminance({ r, g, b }: Rgb): number {
  const channel = (v: number) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrast(fg: Rgb, bg: Rgb): number {
  const a = luminance(fg)
  const b = luminance(bg)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/** WCAG AA for text below 18.66px, which every badge and status label is. */
const AA_SMALL_TEXT = 4.5

/** WCAG 1.4.11 for non-text UI boundaries (checkbox outlines and the like). */
const AA_CONTROL_BOUNDARY = 3.0

const STATUS_PAIRS = [
  { name: 'success', fill: '--color-success-container', text: '--color-on-success-container' },
  { name: 'warning', fill: '--color-warning-container', text: '--color-on-warning-container' },
  { name: 'danger', fill: '--color-error-container', text: '--color-on-error-container' },
  { name: 'info', fill: '--color-info-container', text: '--color-on-info-container' },
  // `--color-brand` itself is the identity color, used for borders, icons and
  // underlines where AA against a soft fill does not apply. Chip text on the
  // soft fill uses the darkened pair — on the two ink palettes the raw accent
  // only reaches 4.3–4.5:1.
  { name: 'brand', fill: '--color-brand-soft', text: '--color-on-brand-soft' },
  { name: 'neutral', fill: '--color-surface-container', text: '--color-text-secondary' },
  // Tertiary is the weakest text tier, but it is NOT decorative: stat-card
  // labels, row meta lines and card source captions have no other outlet.
  // It shipped at 2.48–3.39:1 across all six palettes while this file stayed
  // green, because nothing asserted it — the exact blind spot that let the
  // 2.66:1 warning badge through before this suite existed.
  { name: 'tertiary-on-card', fill: '--color-surface-container', text: '--color-text-tertiary' },
  { name: 'tertiary-on-page', fill: '--color-surface', text: '--color-text-tertiary' },
  // Popovers/dropdowns sit on the lowest container — a brighter (light themes)
  // or darker (ink themes) face than the two above. Celadon clears it by only
  // ~0.2, so this is the pair most likely to regress on a palette tweak.
  { name: 'tertiary-on-popover', fill: '--color-surface-container-lowest', text: '--color-text-tertiary' },
] as const

describe('status palette contrast', () => {
  for (const [theme, selectors] of Object.entries(THEME_BLOCKS)) {
    describe(theme, () => {
      const surface = parseColor(resolve('--color-surface', selectors))

      for (const pair of STATUS_PAIRS) {
        it(`keeps ${pair.name} badge text readable on its own fill`, () => {
          // Dark's containers are translucent; composite before measuring.
          const fill = flatten(parseColor(resolve(pair.fill, selectors)), surface)
          const text = flatten(parseColor(resolve(pair.text, selectors)), fill)
          const ratio = contrast(text, fill)

          expect(
            Number(ratio.toFixed(2)),
            `${theme}/${pair.name}: ${pair.text} on ${pair.fill} is ${ratio.toFixed(2)}:1, needs ${AA_SMALL_TEXT}:1`,
          ).toBeGreaterThanOrEqual(AA_SMALL_TEXT)
        })
      }
    })
  }
})

describe('control boundary contrast', () => {
  // `--color-border` is a hairline separator (~1.2:1) and must never be used
  // as a control boundary; `--color-border-strong` exists for that. The
  // unchecked sidebar batch checkbox shipped at 1.2:1 before this existed.
  for (const [theme, selectors] of Object.entries(THEME_BLOCKS)) {
    it(`keeps control boundaries visible in ${theme}`, () => {
      const surface = parseColor(resolve('--color-surface', selectors))
      for (const fillToken of ['--color-surface', '--color-surface-container'] as const) {
        const fill = flatten(parseColor(resolve(fillToken, selectors)), surface)
        const border = flatten(parseColor(resolve('--color-border-strong', selectors)), fill)
        expect(
          Number(contrast(border, fill).toFixed(2)),
          `${theme}: --color-border-strong on ${fillToken}`,
        ).toBeGreaterThanOrEqual(AA_CONTROL_BOUNDARY)
      }
    })
  }
})

describe('primary action contrast', () => {
  for (const [theme, selectors] of Object.entries(THEME_BLOCKS)) {
    it(`keeps the accent chip readable in ${theme}`, () => {
      const container = parseColor(resolve('--color-primary-container', selectors))
      const onContainer = parseColor(resolve('--color-on-primary-container', selectors))
      expect(
        Number(contrast(onContainer, container).toFixed(2)),
        `${theme}: --color-on-primary-container on --color-primary-container`,
      ).toBeGreaterThanOrEqual(AA_SMALL_TEXT)
    })
  }
})

/**
 * Link affordance contrast.
 *
 * #1145 was reported as "the URL looks the same color as the body text and
 * can't be clicked". Measuring the palette confirmed the first half exactly:
 * `--color-text-accent` against `--color-text-primary` is only 1.95–2.55:1
 * across the six themes, so in dense Chinese text a link with
 * `prose-a:no-underline` is genuinely indistinguishable from prose.
 *
 * The underline therefore carries the whole affordance, and it has to be
 * visible on its own. The first attempt used `--color-primary-fixed-dim`,
 * which measures 1.49–1.76:1 against the page — invisible, and no structural
 * test would have caught it.
 */
describe('revealed-line highlight', () => {
  // #1146 marks the line a `foo.ts:42` reference points at. That mark IS the
  // feedback that the jump landed, so an invisible one means the feature appears
  // to do nothing — the #1145 trap, and equally invisible to structural tests.
  //
  // Measured across all six themes, EVERY soft/container fill lands between 1.02
  // and 1.11 against `--color-code-bg` (warm-classic, the default, gives
  // `--color-brand-soft` just 1.05). That is a property of a soft palette, not a
  // bad token choice: no fill in it can carry this on its own. So the inset
  // left rule in `--color-brand` is the load-bearing part and the tint is only
  // support — which is what these two assertions pin down.
  for (const [theme, selectors] of Object.entries(THEME_BLOCKS)) {
    it(`keeps the reveal rule visible against the code background in ${theme}`, () => {
      const surface = parseColor(resolve('--color-surface', selectors))
      const codeBg = flatten(parseColor(resolve('--color-code-bg', selectors)), surface)
      const rule = flatten(parseColor(resolve('--color-brand', selectors)), codeBg)

      expect(
        Number(contrast(rule, codeBg).toFixed(2)),
        `${theme}: --color-brand inset rule on --color-code-bg`,
      ).toBeGreaterThanOrEqual(AA_CONTROL_BOUNDARY)
    })

    it(`keeps code text readable on the reveal fill in ${theme}`, () => {
      const surface = parseColor(resolve('--color-surface', selectors))
      const codeBg = flatten(parseColor(resolve('--color-code-bg', selectors)), surface)
      const revealFill = flatten(parseColor(resolve('--color-brand-soft', selectors)), codeBg)
      const codeText = flatten(parseColor(resolve('--color-code-fg', selectors)), revealFill)

      expect(
        Number(contrast(codeText, revealFill).toFixed(2)),
        `${theme}: --color-code-fg on the revealed line`,
      ).toBeGreaterThanOrEqual(AA_SMALL_TEXT)
    })
  }
})

describe('link affordance contrast', () => {
  const LINK_SURFACES = ['--color-surface', '--color-surface-user-msg'] as const

  for (const [theme, selectors] of Object.entries(THEME_BLOCKS)) {
    it(`keeps the link underline visible in ${theme}`, () => {
      const surface = parseColor(resolve('--color-surface', selectors))

      for (const surfaceToken of LINK_SURFACES) {
        const fill = flatten(parseColor(resolve(surfaceToken, selectors)), surface)
        const underline = flatten(parseColor(resolve('--color-text-accent', selectors)), fill)
        expect(
          Number(contrast(underline, fill).toFixed(2)),
          `${theme}: --color-text-accent underline on ${surfaceToken}`,
        ).toBeGreaterThanOrEqual(AA_CONTROL_BOUNDARY)
      }
    })

    it(`keeps link text itself readable in ${theme}`, () => {
      const surface = parseColor(resolve('--color-surface', selectors))
      for (const surfaceToken of LINK_SURFACES) {
        const fill = flatten(parseColor(resolve(surfaceToken, selectors)), surface)
        const text = flatten(parseColor(resolve('--color-text-accent', selectors)), fill)
        expect(
          Number(contrast(text, fill).toFixed(2)),
          `${theme}: --color-text-accent text on ${surfaceToken}`,
        ).toBeGreaterThanOrEqual(AA_SMALL_TEXT)
      }
    })
  }
})

describe('tab strip outlines', () => {
  /**
   * The tab strip's trough is deliberately the sidebar's own ground rather
   * than a darkened Chrome-style band — that is what keeps the titlebar from
   * reading as a separate stripe across the top of the window. The price is
   * that the selected tab's paper fill sits at only 1.05–1.10:1 against it in
   * every one of the six themes, so these two tokens are the entire reason the
   * rounded shape is visible at all. A corner nobody can see is not a corner,
   * and what is left when they fail is exactly the flat smear #1123 reported.
   *
   * Neither can be replaced by `--color-border` or `--color-outline`: both are
   * calibrated against paper, and on the trough they land at 1.12:1
   * (invisible) and 1.36–2.01:1 (a drawn box), in opposite directions between
   * the light and ink families.
   */
  const TROUGH = '--color-surface-sidebar'
  /** Enough to trace a 1px curve; below this the corner stops resolving. */
  const EDGE_MIN = 1.3
  /**
   * The hairline between two idle tabs is bounded on both sides: too faint and
   * a row of same-length titles smears back together, too strong and the strip
   * turns into a table of cells.
   */
  const SEPARATOR_MIN = 1.18
  const SEPARATOR_MAX = 1.35

  for (const [theme, selectors] of Object.entries(THEME_BLOCKS)) {
    it(`draws the selected tab's outline on the trough in ${theme}`, () => {
      const trough = parseColor(resolve(TROUGH, selectors))
      const edge = flatten(parseColor(resolve('--color-tab-edge', selectors)), trough)

      expect(
        Number(contrast(edge, trough).toFixed(2)),
        `${theme}: --color-tab-edge on ${TROUGH}`,
      ).toBeGreaterThanOrEqual(EDGE_MIN)
    })

    it(`carries that outline across the tab's own fill in ${theme}`, () => {
      // The 1px border straddles the boundary: half of it lies over the tab's
      // paper. If it vanishes there, the curve is drawn on its outer half only.
      const paper = parseColor(resolve('--color-surface', selectors))
      const edge = flatten(parseColor(resolve('--color-tab-edge', selectors)), paper)

      expect(
        Number(contrast(edge, paper).toFixed(2)),
        `${theme}: --color-tab-edge on --color-surface`,
      ).toBeGreaterThanOrEqual(1.2)
    })

    it(`keeps the hairline between idle tabs present but quiet in ${theme}`, () => {
      const trough = parseColor(resolve(TROUGH, selectors))
      const separator = flatten(parseColor(resolve('--color-tab-separator', selectors)), trough)
      const ratio = Number(contrast(separator, trough).toFixed(2))

      expect(ratio, `${theme}: --color-tab-separator on ${TROUGH} is too faint`)
        .toBeGreaterThanOrEqual(SEPARATOR_MIN)
      expect(ratio, `${theme}: --color-tab-separator on ${TROUGH} shouts`)
        .toBeLessThanOrEqual(SEPARATOR_MAX)
    })
  }
})
