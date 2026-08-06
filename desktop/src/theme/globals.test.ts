import { describe, expect, it } from 'vitest'

import css from './globals.css?raw'
import { THEME_MODES } from '../types/settings'
import { THEME_BACKGROUNDS } from './systemAppearance'

const normalizedCss = css.replace(/\r\n/g, '\n')

/** Concatenates every block written against `selector` (see contrast.test.ts). */
function getThemeBlock(selector: string) {
  const bodies: string[] = []
  let cursor = 0
  for (;;) {
    const start = normalizedCss.indexOf(`${selector} {`, cursor)
    if (start < 0) break
    const bodyStart = normalizedCss.indexOf('{', start)
    let depth = 0
    let closed = false
    for (let index = bodyStart; index < normalizedCss.length; index += 1) {
      const char = normalizedCss[index]
      if (char === '{') depth += 1
      if (char === '}') {
        depth -= 1
        if (depth === 0) {
          bodies.push(normalizedCss.slice(bodyStart + 1, index))
          cursor = index
          closed = true
          break
        }
      }
    }
    if (!closed) throw new Error(`Theme block not closed: ${selector}`)
  }

  expect(bodies.length, `Missing block: ${selector}`).toBeGreaterThan(0)
  return bodies.join('\n')
}

function getCssBetween(startMarker: string, endMarker: string) {
  const start = normalizedCss.indexOf(startMarker)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = normalizedCss.indexOf(endMarker, start)
  expect(end).toBeGreaterThan(start)
  return normalizedCss.slice(start, end)
}

/**
 * The six 「纸 · 墨 · 印」 palettes. Each block holds only raw `--cc-*` color
 * values; the shared `:root` semantic layer turns those into the `--color-*`
 * tokens components consume, so the mapping is written once instead of copied
 * per theme.
 */
const themes = [
  ':root,\n[data-theme="white"]',
  '[data-theme="paper"]',
  '[data-theme="warm-classic"]',
  '[data-theme="celadon"]',
  '[data-theme="dark"]',
  '[data-theme="ink-blue"]',
] as const

describe('desktop theme tokens', () => {
  /**
   * The source variables every palette owes the semantic layer. A palette that
   * skips one does not fail loudly — the token inherits whatever the previous
   * `:root` block left behind, so e.g. celadon would quietly render pure-white's
   * borders. This list is the contract that makes that a red test.
   */
  const requiredSourceTokens = [
    '--cc-bg', '--cc-s0', '--cc-s1', '--cc-s2', '--cc-bd', '--cc-bd2',
    '--cc-t1', '--cc-t2', '--cc-t3',
    '--cc-ac', '--cc-ac2', '--cc-ac-soft', '--cc-ac-soft-hover', '--cc-ac-border',
    '--cc-ac-ink', '--cc-on-ac',
    '--cc-ok', '--cc-ok-soft', '--cc-ok-ink',
    '--cc-wn', '--cc-wn-soft', '--cc-wn-ink',
    '--cc-er', '--cc-er-soft', '--cc-er-soft-hover', '--cc-er-ink',
    '--cc-info', '--cc-info-soft', '--cc-info-ink',
    '--cc-teal', '--cc-teal-soft', '--cc-teal-border', '--cc-teal-icon',
    '--cc-diff-add', '--cc-diff-add-gutter', '--cc-diff-add-word',
    '--cc-diff-del', '--cc-diff-del-gutter', '--cc-diff-del-word',
    '--cc-diff-mark', '--cc-diff-mark-gutter', '--cc-code',
    '--cc-heat-0', '--cc-heat-1', '--cc-heat-2', '--cc-heat-3', '--cc-heat-4',
    '--cc-shadow-card', '--cc-shadow-composer', '--cc-shadow-overlay',
    '--cc-bg-rgb', '--cc-s1-rgb', '--cc-t1-rgb', '--cc-t2-rgb',
    '--cc-bd2-rgb', '--cc-ac-rgb', '--cc-er-rgb', '--cc-scrim-rgb',
  ]

  /** Consumed by components; defined once in the semantic layer. */
  const requiredSemanticTokens = [
    '--color-activity-heat-0',
    '--color-activity-heat-1',
    '--color-activity-heat-2',
    '--color-activity-heat-3',
    '--color-activity-heat-4',
    '--color-activity-cell-border',
    '--color-activity-cell-border-hover',
    '--color-activity-cell-border-active',
    '--shadow-activity-cell-hover',
    '--color-activity-tooltip-surface',
    '--color-activity-tooltip-border',
    '--color-activity-tooltip-text',
    '--color-activity-tooltip-muted',
    '--color-success-container',
    '--color-info',
    '--color-info-container',
    '--color-warning-container',
    '--color-goal-accent',
    '--color-goal-surface',
    '--color-goal-border',
    '--color-goal-icon-bg',
    '--color-goal-chip-bg',
    '--color-goal-chip-border',
    '--color-brand',
    '--color-brand-hover',
    '--color-border-focus',
    '--color-surface-selected',
    '--color-surface-dialog',
    '--color-switch-checked-bg',
    '--color-switch-thumb',
    '--color-btn-primary-bg',
    '--color-btn-primary-fg',
    '--shadow-card',
    '--shadow-composer',
    '--shadow-overlay',
    '--color-text-secondary-a72',
    '--color-text-secondary-a68',
    '--color-text-primary-a88',
    '--color-text-primary-a82',
    '--color-text-primary-a78',
    '--color-surface-hover-a34',
    '--color-surface-hover-a54',
    '--color-outline-a72',
    '--color-outline-a78',
    '--color-outline-a92',
  ]

  it('defines the full source palette for every supported theme', () => {
    for (const theme of themes) {
      const block = getThemeBlock(theme)

      for (const token of requiredSourceTokens) {
        expect(block, `${theme} should define ${token}`).toContain(`${token}:`)
      }
    }
  })

  it('defines every semantic token once, in the shared layer', () => {
    const root = getThemeBlock(':root')

    for (const token of requiredSemanticTokens) {
      expect(root, `the semantic layer should define ${token}`).toContain(`${token}:`)
    }
  })

  it('keeps the startup sidebar width aligned with the compact store default', () => {
    expect(getThemeBlock(':root')).toContain('--sidebar-width: 280px;')
  })

  it('gives each theme its own color-scheme so native controls match the ground', () => {
    // Regression guard for the ink-blue palette: it is a dark ground but is not
    // the theme literally named `dark`, so anything testing `theme === 'dark'`
    // renders its scrollbars and form controls in the light variant.
    for (const theme of themes) {
      expect(getThemeBlock(theme), `${theme} should declare color-scheme`).toContain('color-scheme:')
    }
    expect(getThemeBlock('[data-theme="ink-blue"]')).toContain('color-scheme: dark;')
  })

  it('binds the dark utility variant to both ink themes', () => {
    // `dark:` utilities compile against this list. Omitting ink-blue makes
    // every one of them silently render its light branch on that theme.
    expect(normalizedCss).toContain('[data-theme="ink-blue"], [data-theme="ink-blue"] *')
  })

  it('keeps activity heatmap colors on the app theme accent instead of the old blue ramp', () => {
    expect(css).not.toContain('#DCEEFF')
    expect(css).not.toContain('#B6D9FF')
    expect(css).not.toContain('#2387E8')
    expect(css).toContain('--color-activity-heat-4: var(--cc-heat-4);')
    expect(css).toContain('.activity-heat-cell:hover')
    expect(css).toContain('box-shadow: var(--shadow-activity-cell-hover);')
  })

  it('maps switch activation to the theme brand color', () => {
    expect(getThemeBlock(':root')).toContain('--color-switch-checked-bg: var(--color-brand);')
  })

  it('uses container queries for the compact activity summary strip', () => {
    const activitySummaryCss = getCssBetween('.activity-summary-panel {', '.activity-heat-cell {')

    expect(activitySummaryCss).toContain('container-type: inline-size;')
    expect(activitySummaryCss).toContain('@container (min-width: 360px)')
    expect(activitySummaryCss).toContain('@container (min-width: 560px)')
    expect(activitySummaryCss).toContain('grid-template-columns: repeat(5, minmax(0, 1fr));')
    expect(activitySummaryCss).toContain('grid-column: auto;')
    expect(activitySummaryCss).not.toContain('grid-column: span 2;')
  })

  it('avoids color-mix in the startup-critical UI zoom shell chrome for Safari 15 WebView support', () => {
    const zoomShellCss = getCssBetween('.settings-zoom-kbd {', '/* ─── Terminal ANSI palette')

    expect(zoomShellCss).not.toContain('color-mix(')
  })

  it('keeps the UI zoom slider thumb visible on both ink grounds', () => {
    // The thumb is a light disc on a light track; on a dark ground it needs an
    // accent border to read at all. Both dark palettes get the override.
    expect(css).toContain('[data-theme="dark"] .settings-zoom-control,\n[data-theme="ink-blue"] .settings-zoom-control')
    expect(css).toContain('--settings-zoom-thumb-bg: var(--color-surface-bright);')
    expect(css).toContain('--settings-zoom-thumb-border: var(--color-brand);')
    expect(css).toContain('box-shadow: var(--settings-zoom-thumb-shadow);')
  })

  it('maps markdown typography colors to theme tokens', () => {
    const markdownProseStart = normalizedCss.indexOf('.markdown-prose {')
    expect(markdownProseStart).toBeGreaterThanOrEqual(0)
    const markdownProseEnd = normalizedCss.indexOf('}', markdownProseStart)
    const markdownProseBlock = normalizedCss.slice(markdownProseStart, markdownProseEnd)

    expect(markdownProseBlock).toContain('--tw-prose-body: var(--color-text-primary);')
    expect(markdownProseBlock).toContain('--tw-prose-quotes: var(--color-text-primary);')
    expect(markdownProseBlock).toContain('--tw-prose-bold: var(--color-text-primary);')
    expect(markdownProseBlock).toContain('--tw-prose-code: var(--color-code-fg);')
    expect(markdownProseBlock).toContain('--tw-prose-pre-bg: var(--color-code-bg);')
    expect(markdownProseBlock).toContain('--tw-prose-td-borders: var(--color-border);')
  })

  it('keeps code viewer line hover and line numbers on theme tokens', () => {
    expect(css).toContain('background: var(--color-surface-hover);')
    expect(css).toContain('--line-numbers-foreground: var(--color-text-tertiary);')
  })

  it('keeps xterm helper and accessibility layers from rendering duplicate terminal text', () => {
    expect(css).toContain('.settings-terminal-host .xterm-accessibility:not(.debug),')
    expect(css).toContain('.settings-terminal-host .xterm-message')
    expect(css).toContain('color: transparent;')
    expect(css).toContain('pointer-events: none;')
    expect(css).toContain('.settings-terminal-host .xterm-helper-textarea')
    expect(css).toContain('left: -9999em;')
    expect(css).toContain('overflow: hidden;')
  })

  it('keeps the pet task card controls above the mascot hit target', () => {
    const mascotCss = getCssBetween('.pet-mascot-button {', '.pet-mascot-wrap {')
    const cardCss = getCssBetween('.pet-activity-card {', '.pet-activity-card[data-expanded=')

    expect(mascotCss).toContain('z-index: 10;')
    expect(cardCss).toContain('z-index: 15;')
  })

  it('restacks the pet task card under the mascot when the host flips it', () => {
    // Reaching the macOS menu bar puts the window's top edge above the work
    // area, and the card lives in exactly that strip. The host asks for the
    // flip; without every one of these rules the card stays behind the menu
    // bar, or lands on the mascot instead of beside it (#1140).
    const stackCss = getCssBetween(
      ".pet-window-stack[data-panel-placement='below'] {",
      '.pet-mascot-button {',
    )
    expect(stackCss).toContain('justify-content: flex-start;')
    expect(stackCss).toContain('padding: 12px 12px 0;')

    const mascotCss = getCssBetween(
      ".pet-window-stack[data-panel-placement='below'] .pet-mascot-wrap {",
      '}',
    )
    expect(mascotCss).toContain('order: 1;')

    const cardCss = getCssBetween(
      ".pet-window-stack[data-panel-placement='below'] .pet-activity-card {",
      '}',
    )
    expect(cardCss).toContain('order: 2;')
    expect(cardCss).toContain('margin-top: 12px;')
    expect(cardCss).toContain('margin-bottom: 0;')

    // The collapse control hangs off the card's mascot-facing edge, so flipping
    // the card has to flip the control with it. Its selector also has to outrank
    // the expanded-state rule that pins `top: auto`, whatever the source order.
    const toggleCss = getCssBetween(
      ".pet-window-stack[data-panel-placement='below'] .pet-activity-card .pet-panel-toggle {",
      '}',
    )
    expect(toggleCss).toContain('top: -31px;')
    expect(toggleCss).toContain('bottom: auto;')
  })

  it('moves the mascot to the outside of the fixed pet window at side edges', () => {
    const leftCss = getCssBetween(
      ".pet-window-stack[data-panel-horizontal='left'] .pet-mascot-wrap {",
      '}',
    )
    const rightCss = getCssBetween(
      ".pet-window-stack[data-panel-horizontal='right'] .pet-mascot-wrap {",
      '}',
    )

    expect(leftCss).toContain('align-self: flex-end;')
    expect(rightCss).toContain('align-self: flex-start;')
  })

  it('binds the dark variant to the app theme attribute, not the operating system', () => {
    // The app ships six themes toggled via `<html data-theme>`. Tailwind's
    // stock `dark:` compiles to `prefers-color-scheme`, which fires on the OS
    // setting and is wrong for every one of them.
    expect(normalizedCss).toContain('@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *')
    expect(normalizedCss).not.toMatch(/@media[^{]*\(\s*prefers-color-scheme/)
  })

  it('defines on-primary-container everywhere on-primary is defined', () => {
    // The light values live in the `@theme` block as the defaults; the white
    // and dark blocks override them. A container color that only exists for
    // some themes is how `--color-on-primary-container` went missing entirely.
    const onPrimary = normalizedCss.match(/--color-on-primary:/g)?.length ?? 0
    const onPrimaryContainer = normalizedCss.match(/--color-on-primary-container:/g)?.length ?? 0
    expect(onPrimary).toBeGreaterThan(0)
    expect(onPrimaryContainer).toBe(onPrimary)
  })
})

/**
 * `.glass-panel` states a translucent fill and a blur in one rule, and reads as
 * frosted only when both land. The blur is the fragile half: where
 * `backdrop-filter` does not run there is no failure for CSS to report — the
 * declaration is simply skipped, the fill stays translucent on its own, and
 * page text reads straight through the panel. That is what put a legible
 * provider list behind the 860px provider form.
 *
 * These pin the two defenses. Dialogs opted out of the coupling entirely;
 * the small floating layers kept it but no longer depend on it for legibility.
 */
describe('overlay opacity contract', () => {
  /** Every value assigned to `token` across the stylesheet, in source order. */
  function declarationsOf(token: string) {
    const pattern = new RegExp(`${token}:\\s*([^;]+);`, 'g')
    const values = [...normalizedCss.matchAll(pattern)].map((match) => match[1]!.trim())
    expect(values.length, `${token} should be declared`).toBeGreaterThan(0)
    return values
  }

  function alphaOf(declaration: string) {
    const match = declaration.match(/,\s*([0-9.]+)\s*\)\s*$/)
    expect(match, `expected a trailing alpha in "${declaration}"`).not.toBeNull()
    return Number(match![1])
  }

  it('gives dialogs a fill with no alpha channel at all, in every theme', () => {
    // Not "mostly opaque" — an rgba() here would put the regression back one
    // decimal at a time.
    for (const value of declarationsOf('--color-surface-dialog')) {
      expect(value, `dialog fill should be opaque, got "${value}"`).not.toMatch(/rgba|hsla/)
      expect(value).not.toMatch(/,\s*[0-9.]+\s*\)\s*$/)
    }
  })

  it('lifts the dialog fill off the ground on both light and ink themes', () => {
    // Light palettes top out at `--cc-bg`; ink palettes bottom out there, so a
    // shared value would sink dark dialogs into the page behind them.
    const values = declarationsOf('--color-surface-dialog')
    expect(values).toContain('var(--cc-bg)')
    expect(values).toContain('var(--cc-s1)')
  })

  it('keeps the glass fill dense enough to stand without the blur', () => {
    // At 0.84 the page was readable through unblurred glass. These floating
    // layers are small enough that the frosted look survives the extra density.
    for (const value of declarationsOf('--color-surface-glass')) {
      expect(alphaOf(value), `glass fill "${value}" is too sheer`).toBeGreaterThanOrEqual(0.9)
    }
  })

  it('drops glass to a fully opaque fill where backdrop-filter is unavailable', () => {
    const fallback = normalizedCss.match(
      /@supports not \(\(backdrop-filter[^)]*\)[^{]*\{\s*\.glass-panel\s*\{([^}]*)\}/,
    )
    expect(fallback, 'expected an @supports fallback for .glass-panel').not.toBeNull()
    expect(fallback![1]).toMatch(/background:\s*rgb\(var\(--cc-bg-rgb\)\)/)
  })

  it('keeps the dialog panel off backdrop-filter entirely', () => {
    const rule = normalizedCss.match(/\n\.dialog-panel \{([^}]*)\}/)
    expect(rule, 'expected a .dialog-panel rule').not.toBeNull()
    expect(rule![1]).not.toMatch(/backdrop-filter/)
    expect(rule![1]).toMatch(/background:\s*var\(--color-surface-dialog\)/)
  })

  it('dims harder behind a modal than behind a non-modal drawer', () => {
    // Now that the panel is opaque the scrim is the only thing separating the
    // dialog from the page, so it carries more weight than the sidebar's.
    const modal = declarationsOf('--color-modal-scrim').map(alphaOf)
    const overlay = declarationsOf('--color-overlay-scrim').map(alphaOf)
    expect(modal).toHaveLength(overlay.length)
    modal.forEach((alpha, index) => {
      expect(alpha, 'modal scrim should be at least as heavy as the overlay scrim')
        .toBeGreaterThanOrEqual(overlay[index]!)
    })
  })
})

describe('layering scale', () => {
  const scale = (() => {
    const start = normalizedCss.indexOf('/* ─── Layering scale')
    expect(start).toBeGreaterThanOrEqual(0)
    const blockStart = normalizedCss.indexOf('{', start)
    const blockEnd = normalizedCss.indexOf('}', blockStart)
    const body = normalizedCss.slice(blockStart + 1, blockEnd)
    const values = new Map<string, number>()
    for (const match of body.matchAll(/(--z-[a-z]+):\s*(\d+);/g)) {
      values.set(match[1]!, Number(match[2]))
    }
    return values
  })()

  it('defines every layer used by the overlay components', () => {
    for (const token of ['--z-drawer', '--z-dialog', '--z-sheet', '--z-dropdown', '--z-popover', '--z-tooltip', '--z-toast']) {
      expect(scale.get(token), `${token} missing from the layering scale`).toBeTypeOf('number')
    }
  })

  it('keeps toasts above bottom sheets', () => {
    // Regression: the toast container sat at z-100 while MobileBottomSheet used
    // z-10000, so any confirmation raised from inside a sheet was invisible.
    expect(scale.get('--z-toast')!).toBeGreaterThan(scale.get('--z-sheet')!)
  })

  it('keeps dropdowns and popovers above dialogs', () => {
    // A modal dialog blocks the page behind it, so an open dropdown always
    // belongs to the topmost dialog. Inverting this is what forced
    // DirectoryPicker to hardcode `zIndex: 9999` to stay usable in a modal.
    expect(scale.get('--z-dropdown')!).toBeGreaterThan(scale.get('--z-dialog')!)
    expect(scale.get('--z-popover')!).toBeGreaterThan(scale.get('--z-dialog')!)
    expect(scale.get('--z-tooltip')!).toBeGreaterThan(scale.get('--z-dropdown')!)
  })

  it('orders the scale strictly from base to toast', () => {
    const ordered = [
      '--z-base', '--z-raised', '--z-sticky', '--z-nav', '--z-scrim',
      '--z-drawer', '--z-dialog', '--z-sheet', '--z-dropdown', '--z-popover',
      '--z-tooltip', '--z-toast',
    ]
    const values = ordered.map((token) => scale.get(token)!)
    expect(values).toEqual([...values].sort((a, b) => a - b))
  })
})

describe('animation classes', () => {
  const keyframeNames = new Set(
    [...normalizedCss.matchAll(/@keyframes\s+([\w-]+)/g)].map((match) => match[1]),
  )

  it('pairs every animation reference with a defined keyframe', () => {
    // Regression: `.pet-status-pulse` referenced a `pet-status-pulse` keyframe
    // that never existed, so the class was silently inert.
    const missing: string[] = []
    for (const match of normalizedCss.matchAll(/animation(?:-name)?:\s*([^;]+);/g)) {
      for (const part of match[1]!.split(',')) {
        const name = part.trim().split(/\s+/)[0]
        if (!name || name === 'none' || /^\d/.test(name)) continue
        if (!keyframeNames.has(name)) missing.push(name)
      }
    }
    expect(missing).toEqual([])
  })

  it('defines the overlay entrance animations that replaced tailwindcss-animate', () => {
    // `animate-in slide-in-from-*` came from `tailwindcss-animate`, removed in
    // the shadcn rollback. Toast and Dropdown kept the classes and lost their
    // entrance animation entirely.
    for (const name of ['overlay-fade-in', 'overlay-in-from-top', 'overlay-in-from-bottom', 'overlay-in-from-right']) {
      expect(keyframeNames.has(name), `@keyframes ${name} missing`).toBe(true)
    }
    for (const cls of ['.animate-overlay-in', '.animate-overlay-in-top', '.animate-overlay-in-bottom', '.animate-overlay-in-right']) {
      expect(normalizedCss).toContain(`${cls} {`)
    }
  })
})

describe('terminal palette tokens', () => {
  const ansiSlots = [
    'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
    'bright-black', 'bright-red', 'bright-green', 'bright-yellow',
    'bright-blue', 'bright-magenta', 'bright-cyan', 'bright-white',
  ]

  it('defines all 16 ANSI slots that lib/terminalTheme.ts reads', () => {
    for (const slot of ansiSlots) {
      expect(normalizedCss).toContain(`--color-terminal-ansi-${slot}:`)
    }
  })

  it('defines the terminal ground once and lets ink-blue override it', () => {
    // The handoff pins one warm-ink terminal panel across the paper themes;
    // only ink-blue swaps in a cool ground, so it is the one override.
    const root = getThemeBlock(':root')
    expect(root).toContain('--color-terminal-cursor:')
    expect(root).toContain('--color-terminal-selection:')
    expect(root).toContain('--color-terminal-bg:')

    const inkBlue = getThemeBlock('[data-theme="ink-blue"]')
    expect(inkBlue).toContain('--color-terminal-bg:')
    expect(inkBlue).toContain('--color-terminal-selection:')
  })
})

describe('pre-paint background constants', () => {
  // THEME_BACKGROUNDS feeds the Electron window background and the inline
  // script in index.html, both of which paint before this stylesheet is
  // parsed. A drift here is a visible flash on launch.

  /**
   * Map each palette's `--cc-bg` back to the theme owning it. That is the
   * source value: `--color-background` is an alias resolving to `var(--cc-bg)`,
   * so reading the alias would only ever report the literal string.
   */
  function declaredGrounds(): Record<string, string> {
    const found: Record<string, string> = {}

    for (const match of normalizedCss.matchAll(/--cc-bg:\s*([^;]+);/g)) {
      const before = normalizedCss.slice(0, match.index)
      const blockStart = before.lastIndexOf('{')
      // The selector runs from the end of the previous block or comment.
      const selectorStart = Math.max(
        before.lastIndexOf('}', blockStart),
        before.lastIndexOf('*/', blockStart),
        -1,
      )
      // Take the last line so a leftover comment delimiter or a multi-line
      // selector list does not swallow the part that identifies the theme.
      const selector = before.slice(selectorStart + 1, blockStart).trim().split('\n').pop()!.trim()

      const theme = /\[data-theme="([\w-]+)"\]/.exec(selector)?.[1]
      if (theme) found[theme] = match[1]!.trim().toUpperCase()
    }

    return found
  }

  it('matches the ground of every palette', () => {
    const declared = declaredGrounds()

    for (const [theme, background] of Object.entries(THEME_BACKGROUNDS)) {
      expect(declared[theme], `${theme} has no --cc-bg`).toBeDefined()
      expect(declared[theme], `${theme} ground drifted from THEME_BACKGROUNDS`).toBe(background.toUpperCase())
    }
  })

  it('covers every palette, so a new one cannot ship without a pre-paint color', () => {
    expect(Object.keys(THEME_BACKGROUNDS).sort()).toEqual([...THEME_MODES].sort())
  })
})
