import { describe, expect, it } from 'vitest'

import css from './globals.css?raw'
import { DARK_THEME_MODES, THEME_MODES } from '../types/settings'
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
 * The supported palettes. Each block holds only raw `--cc-*` color
 * values; the shared `:root` semantic layer turns those into the `--color-*`
 * tokens components consume, so the mapping is written once instead of copied
 * per theme.
 */
const themes = [
  ':root,\n[data-theme="white"]',
  '[data-theme="dark"]',
] as const

describe('desktop theme tokens', () => {
  /**
   * The source variables every palette owes the semantic layer. A palette that
   * skips one does not fail loudly — the token inherits whatever the previous
   * `:root` block left behind, so e.g. celadon would quietly render pure-white's
   * borders. This list is the contract that makes that a red test.
   */
  const requiredSourceTokens = [
    '--cc-bg', '--cc-s0', '--cc-s1', '--cc-s2', '--cc-user-msg', '--cc-bd', '--cc-bd2',
    '--cc-bd-strong', '--cc-tab-edge', '--cc-tab-sep',
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
    '--cc-series-1', '--cc-series-2', '--cc-series-3', '--cc-series-4', '--cc-series-5',
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
    '--color-series-1',
    '--color-series-2',
    '--color-series-3',
    '--color-series-4',
    '--color-series-5',
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
    for (const theme of DARK_THEME_MODES) {
      expect(getThemeBlock(`[data-theme="${theme}"]`)).toContain('color-scheme: dark;')
    }
  })

  it('binds the dark utility variant to every dark theme', () => {
    // `dark:` utilities compile against this list. Omitting ink-blue makes
    // every one of them silently render its light branch on that theme.
    for (const theme of DARK_THEME_MODES) {
      expect(normalizedCss).toContain(`[data-theme="${theme}"], [data-theme="${theme}"] *`)
    }
  })

  it('removes muddy SVG surface grain and uses crisp geometric sans for --font-headline', () => {
    expect(normalizedCss).toContain('--surface-grain: none;')
    expect(normalizedCss).not.toContain('feTurbulence')
    const themeBlock = getThemeBlock('@theme')
    expect(themeBlock).toContain('--font-headline: "Plus Jakarta Sans", "Geist", -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;')
    expect(themeBlock).not.toMatch(/--font-headline:[^;]*Noto Serif SC/)
  })

  it('uses dark terminal and syntax colors for every dark palette', () => {
    const selector = DARK_THEME_MODES.map((theme) => `[data-theme="${theme}"]`).join(',\n')
    const block = getThemeBlock(selector)
    expect(block).toContain('--color-terminal-ansi-red: #F67576;')
    expect(block).toContain('--color-code-comment: #999999;')
    expect(block).toContain('--color-diff-syntax-string: #85DF7B;')
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

  it('keeps a path in a chat table cell whole instead of breaking it per letter', () => {
    // In the split workspace the chat column is ~400px; table cells used to wrap
    // `src/lib/validators.ts` one letter at a time.
    expect(css).toMatch(/\.md-table-wrap :is\(td, th\) code \{[^}]*white-space: nowrap;[^}]*word-break: normal;/)
  })

  it('sizes a chat ordered-list gutter in ch so a monospace number stays inside the reply column (#1540)', () => {
    // Prose's fixed 20px gutter holds "1." in a proportional face; in a monospace
    // one "10. " is four cells, hung past the column and clipped at the scroll
    // area's edge in wide / full width.
    const gutter = (selector: string) => {
      const match = normalizedCss.match(new RegExp(`${selector.replace(/[.()>*:]/g, '\\$&')} \\{([^}]*)\\}`))
      return match?.[1] ?? ''
    }
    const base = '.markdown-prose.chat-reading-markdown ol'
    expect(gutter(base)).toMatch(/padding-inline-start: max\(1\.25rem, 3ch\)/)
    expect(gutter(`${base}:has(> li:nth-child(10))`)).toMatch(/padding-inline-start: max\(1\.25rem, 4ch\)/)
    expect(gutter(`${base}:has(> li:nth-child(100))`)).toMatch(/padding-inline-start: max\(1\.25rem, 5ch\)/)
  })

  it('sizes the usage page display numerals from the pane, not the window', () => {
    const usageCss = getCssBetween('.token-usage-root {', '.activity-heat-swatch {')

    expect(usageCss).toContain('container-type: inline-size;')
    // cqw ties the figure to the settings pane the user actually has; the
    // clamp keeps it legible on a narrow pane and from outgrowing a wide one.
    expect(usageCss).toMatch(/\.token-hero-number \{[^}]*font-size: clamp\(\d+px, \d+cqw, \d+px\);/)
    // Safari 15 drops a declaration whose value it cannot parse, so each cqw size is preceded by a
    // plain one for it to fall back to; without that the numeral renders at body size.
    expect(usageCss).toMatch(/\.token-hero-number \{[^}]*font-size: \d+px;[^}]*font-size: clamp\(\d+px, \d+cqw, \d+px\);/)
    expect(usageCss).toMatch(/\.token-hero-unit \{[^}]*font-size: \d+px;[^}]*font-size: clamp\(\d+px, \d+cqw, \d+px\);/)
    // Geist ships only at 500: a heavier request would be synthesized.
    expect(usageCss).toContain("font-family: 'Geist'")
    expect(usageCss).toContain('font-synthesis: none;')
  })

  it('avoids color-mix in the startup-critical UI zoom shell chrome for Safari 15 WebView support', () => {
    const zoomShellCss = getCssBetween('.settings-zoom-kbd {', '/* ─── Terminal ANSI palette')

    expect(zoomShellCss).not.toContain('color-mix(')
  })

  it('keeps the UI zoom slider thumb visible on every dark ground', () => {
    // The thumb is a light disc on a light track; on a dark ground it needs an
    // accent border to read at all. Both dark palettes get the override.
    expect(css).toContain(DARK_THEME_MODES.map((theme) => `[data-theme="${theme}"] .settings-zoom-control`).join(',\n'))
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

  // Shiki only runs in a real browser (CodeViewer keeps tests on Prism), so its
  // markup is pinned here. Block `.line`s joined by "\n" text nodes rendered an
  // empty line box between every two lines, and its inner <pre> reset
  // `wrapLongLines` back to `white-space: pre`.
  it('keeps Shiki code single-spaced and lets wrapLongLines reach its inner pre', () => {
    expect(getThemeBlock('.code-viewer-area [data-highlight-engine="shiki"] code')).toMatch(/display:\s*flex;[\s\S]*flex-direction:\s*column;/)
    expect(getThemeBlock('.code-viewer-area [data-highlight-engine="shiki"] .line:empty::before')).toContain("content: '\\200b';")
    const pre = getThemeBlock('.code-viewer-area [data-highlight-engine="shiki"] pre')
    expect(pre).toContain('white-space: inherit;')
    expect(pre).toContain('word-break: inherit;')
  })

  it('marks a located tool call on its own row or card, and lets it take over from its item', () => {
    expect(getThemeBlock('.chat-tool-navigation-target[data-tool-call-chrome="row"]')).toContain('animation: chat-tool-row-navigation-target-pulse')
    expect(getThemeBlock('.chat-tool-navigation-target[data-tool-call-chrome="card"]')).toContain('animation: chat-tool-card-navigation-target-pulse')
    expect(getThemeBlock('.chat-render-item--navigation-target:has(.chat-tool-navigation-target)')).toContain('animation: none;')
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
 * Layered frosted glass surfaces pair translucent fills (`0.82–0.86` alpha) with
 * `backdrop-filter` blur/saturation and a 1px top specular rim. Where
 * `backdrop-filter` is unavailable, CSS silently drops the blur without
 * reporting a failure — so every translucent surface MUST drop back to its
 * opaque fill inside `@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)))`.
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

  it('gives the opaque dialog fallback token a fill with no alpha channel in every theme', () => {
    // `--color-surface-dialog` is both the `@supports` fallback when blur is
    // unavailable and the surface measured by contrast tests.
    for (const value of declarationsOf('--color-surface-dialog')) {
      expect(value, `dialog fallback fill should be opaque, got "${value}"`).not.toMatch(/rgba|hsla/)
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

  it('keeps frosted glass fills dense enough (>= 0.80 alpha) for legible blur', () => {
    for (const token of ['--color-surface-glass', '--color-surface-dialog-glass']) {
      for (const value of declarationsOf(token)) {
        expect(alphaOf(value), `${token} fill "${value}" is too sheer`).toBeGreaterThanOrEqual(0.8)
      }
    }
  })

  it('uses frosted dialog glass on .dialog-panel with top specular rim and ambient shadow', () => {
    const rule = normalizedCss.match(/\n\.dialog-panel \{([^}]*)\}/)
    expect(rule, 'expected a .dialog-panel rule').not.toBeNull()
    expect(rule![1]).toMatch(/background:\s*var\(--color-surface-dialog-glass\)/)
    expect(rule![1]).toMatch(/backdrop-filter:\s*blur\(var\(--glass-blur\)\)/)
    expect(rule![1]).toMatch(/box-shadow:\s*var\(--glass-top-rim\),\s*var\(--shadow-dialog-glass\)/)
  })

  it('drops every frosted glass surface to an opaque fill where backdrop-filter is unavailable', () => {
    const fallbackStart = normalizedCss.indexOf('@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {')
    expect(fallbackStart, 'expected an @supports fallback block for frosted glass').toBeGreaterThanOrEqual(0)
    const fallbackBlock = getThemeBlock('@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)))')
    expect(fallbackBlock).toContain('.glass-panel')
    expect(fallbackBlock).toContain('.surface-glass')
    expect(fallbackBlock).toContain('.dropdown-glass')
    expect(fallbackBlock).toMatch(/background:\s*rgb\(var\(--cc-bg-rgb\)\)/)
    expect(fallbackBlock).toContain('.dialog-glass')
    expect(fallbackBlock).toContain('.dialog-panel')
    expect(fallbackBlock).toContain('.composer-glass')
    expect(fallbackBlock).toMatch(/background:\s*var\(--color-surface-dialog\)/)
  })

  it('dims harder behind a modal than behind a non-modal drawer', () => {
    const modal = declarationsOf('--color-modal-scrim').map(alphaOf)
    const overlay = declarationsOf('--color-overlay-scrim').map(alphaOf)
    expect(modal).toHaveLength(overlay.length)
    modal.forEach((alpha, index) => {
      expect(alpha, 'modal scrim should be at least as heavy as the overlay scrim')
        .toBeGreaterThanOrEqual(overlay[index]!)
    })
  })
})

describe('Safari 15-safe texture utilities', () => {
  it('defines surface grain, bevel, scroll fade, glass, seam, and stepped motion utilities without color-mix', () => {
    expect(normalizedCss).not.toContain('color-mix(')
    for (const token of [
      '--surface-grain:',
      '--bevel-surface-rest:',
      '--bevel-surface-pressed:',
      '--bevel-cta-rest:',
      '--bevel-cta-pressed:',
      '--app-scrollbar-width: 6px;',
      '--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);',
    ]) {
      expect(normalizedCss, `missing token ${token}`).toContain(token)
    }
    for (const selector of [
      '.surface-grain {',
      '.control-bevel {',
      '.control-bevel-cta {',
      '.surface-glass {',
      '.dropdown-glass {',
      '.dialog-glass {',
      '.dialog-backdrop {',
      '.composer-glass {',
      '.composer-seam-below {',
      '.composer-seam-above {',
      '.topbar-scroll-fade {',
      '.scroll-edge-fade {',
      '.scrollbar-autohide {',
      '.animate-stepped-pulse {',
      '.animate-stepped-shimmer {',
      '.popover-motion {',
    ]) {
      expect(normalizedCss, `missing utility ${selector}`).toContain(selector)
    }
  })

  it('keeps .control-bevel and .control-bevel-cta inside @layer components so Tailwind absolute/fixed utilities win', () => {
    const componentsLayer = normalizedCss.match(/@layer components \{[\s\S]*?\.control-bevel \{[\s\S]*?\.control-bevel-cta \{/)
    expect(componentsLayer).not.toBeNull()
  })

  it('lets .scrollbar-autohide own the sidebar scrollbar without legacy .sidebar-scroll-area overrides', () => {
    const sidebarScrollAreaBlock = getThemeBlock('.sidebar-scroll-area')
    expect(sidebarScrollAreaBlock).toContain('padding-bottom: 60px;')
    expect(sidebarScrollAreaBlock).not.toContain('scrollbar-color')
    expect(sidebarScrollAreaBlock).not.toContain('scrollbar-width')
    expect(normalizedCss).not.toContain('.sidebar-scroll-area::-webkit-scrollbar')
  })
})

describe('desktop window drag', () => {
  it('does not promote the sidebar shell into a compositing layer', () => {
    // Electron drops -webkit-app-region hits on a macOS compositing layer, so
    // a permanent will-change on this shell makes the traffic-light padding
    // undraggable. The comment is allowed to mention the property; a real
    // declaration is not.
    const shellCss = getCssBetween('.sidebar-shell {', '.sidebar-shell[data-state="closed"] {')
    expect(shellCss).not.toMatch(/will-change\s*:/)
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

  function terminalTokens(theme: string) {
    const blocks = [getThemeBlock(':root')]
    if ((DARK_THEME_MODES as readonly string[]).includes(theme)) {
      blocks.push(getThemeBlock(DARK_THEME_MODES.map((mode) => `[data-theme="${mode}"]`).join(',\n')))
    }
    blocks.push(getThemeBlock(`[data-theme="${theme}"]`))
    const tokens = new Map(Array.from(blocks.join('\n').matchAll(/(--[\w-]+):\s*([^;]+);/g), (match) => [match[1]!, match[2]!.trim()]))
    const resolve = (name: string): string => {
      const value = tokens.get(name)
      if (!value) throw new Error(`Missing ${name}`)
      const alias = /^var\((--[\w-]+)\)$/.exec(value)
      return alias ? resolve(alias[1]!) : value
    }
    return resolve
  }

  function contrast(foreground: string, background: string) {
    const luminance = (hex: string) => {
      const channels = hex.slice(1).match(/../g)!.map((part) => {
        const channel = parseInt(part, 16) / 255
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
      })
      return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
    }
    const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
    return (values[0]! + 0.05) / (values[1]! + 0.05)
  }

  it.each(THEME_MODES)('integrates the terminal with the %s workspace and keeps output readable', (theme) => {
    const token = terminalTokens(theme)
    const background = token('--color-terminal-bg')
    expect(background).toBe(token('--cc-bg'))
    expect(token('--color-terminal-header')).toBe(background)
    expect(token('--color-terminal-fg')).toBe(token('--cc-t1'))
    for (const slot of ['fg', 'muted', 'accent', 'danger', 'warning']) {
      expect(contrast(token(`--color-terminal-${slot}`), background), `${theme} ${slot}`).toBeGreaterThanOrEqual(4.5)
    }
    expect(contrast(token('--color-terminal-fg'), token('--color-terminal-selection'))).toBeGreaterThanOrEqual(4.5)
    for (const slot of ansiSlots.filter((slot) => !['black', 'white', 'bright-white'].includes(slot))) {
      expect(contrast(token(`--color-terminal-ansi-${slot}`), background), `${theme} ANSI ${slot}`).toBeGreaterThanOrEqual(4.5)
    }
    expect(token('--color-terminal-scrollbar')).toBe(token('--cc-bd2'))
    expect(token('--color-terminal-scrollbar-hover')).toBe(token('--cc-t3'))
    // Image viewing must remain independent when a terminal switches to paper.
    expect(token('--color-media-bg')).toBe('#141414')
    expect(contrast(token('--color-media-muted'), token('--color-media-bg'))).toBeGreaterThanOrEqual(4.5)
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

/**
 * V6C Calm Liquid Glass. The approved redesign is a set of decisions that a
 * later palette tweak can silently undo — a terracotta "running" state, a warm
 * wash on the wall, an outer brand glow on the send key, a 20px dialog corner —
 * and none of those breaks contrast or token resolution. These pin them.
 */
describe('V6C Calm Liquid Glass contract', () => {
  const light = getThemeBlock(':root,\n[data-theme="white"]')
  const dark = getThemeBlock('[data-theme="dark"]')
  const root = getThemeBlock(':root')

  function hex(block: string, token: string) {
    const match = new RegExp(`${token}:\\s*(#[0-9A-Fa-f]{6});`).exec(block)
    expect(match, `${token} should be a hex color`).not.toBeNull()
    const n = parseInt(match![1]!.slice(1), 16)
    return { value: match![1]!.toUpperCase(), r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
  }

  it('keeps one concentric low-radius scale in both the static and runtime layers', () => {
    const scale = {
      '--radius-xs': '4px',
      '--radius-sm': '6px',
      '--radius-md': '8px',
      '--radius-control': '9px',
      '--radius-card-inner': '10px',
      '--radius-key': '11px',
      '--radius-lg': '12px',
      '--radius-xl': '14px',
      '--radius-2xl': '16px',
      '--radius-3xl': '16px',
      '--radius-full': '9999px',
    }
    for (const block of [getThemeBlock('@theme'), root]) {
      for (const [token, value] of Object.entries(scale)) {
        expect(block, `${token} should be ${value}`).toContain(`${token}: ${value};`)
      }
    }
  })

  it('unifies interactive accent on Codex blue with a monochrome primary send key', () => {
    expect(hex(light, '--cc-ac').value).toBe('#0169CC')
    expect(hex(dark, '--cc-ac').value).toBe('#339CFF')
    for (const block of [light, dark]) {
      for (const token of ['--cc-ac', '--cc-info', '--cc-info-ink']) {
        const color = hex(block, token)
        expect(color.b, `${token} must read blue`).toBeGreaterThan(color.r)
      }
    }
    expect(root).toContain('--color-text-accent: var(--cc-info);')
    expect(root).toContain('--color-info: var(--cc-info);')
    // Monochrome send key (no colorful gradient CTA).
    expect(root).toContain('--v6c-send-fill: #1A1C1F;')
    expect(root).toContain('--v6c-send-fg: #FFFFFF;')
    expect(dark).toContain('--v6c-send-fill: #FFFFFF;')
    expect(dark).toContain('--v6c-send-fg: #141414;')
  })

  it('paints a pure achromatic neutral wall and chrome without blue or warm cast', () => {
    for (const block of [root, dark]) {
      const wall = /--v6c-wall:\s*([^;]+);/.exec(block)?.[1] ?? ''
      expect(wall, 'wall should be declared').not.toBe('')
      expect(wall, 'wall should be calm flat neutral without radial glare').not.toContain('radial-gradient(')
    }
    // Pure achromatic neutral grounds: R === G === B on every raw neutral surface.
    for (const block of [light, dark]) {
      for (const token of ['--cc-bg', '--cc-paper', '--cc-s0', '--cc-s1', '--cc-s2', '--cc-user-msg', '--cc-bd', '--cc-bd2']) {
        const color = hex(block, token)
        expect(color.r, `${token} should be pure neutral (R === G)`).toBe(color.g)
        expect(color.g, `${token} should be pure neutral (G === B)`).toBe(color.b)
      }
    }
    // Both themes unify pre-paint ground and reading paper.
    expect(hex(light, '--cc-paper').value).toBe(hex(light, '--cc-bg').value)
    expect(hex(dark, '--cc-paper').value).toBe(hex(dark, '--cc-bg').value)
  })

  it('provides Codex chat stream utilities (shimmer, edge-fade, quiet work row) without color-mix', () => {
    expect(normalizedCss).toContain('@keyframes codex-activity-shimmer')
    expect(normalizedCss).toContain('.codex-shimmer-text {')
    // Shimmer must keep an opaque base fill under the moving highlight band so
    // glyphs never vanish outside the 50% sweep window.
    const shimmer = getThemeBlock('.codex-shimmer-text')
    expect(shimmer).toContain('background-color: var(--shimmer-base);')
    expect(shimmer).toContain('background-image: linear-gradient(')
    // Monochrome send key must paint via `background-image` so `@layer utilities`
    // `bg-[var(--color-brand)]` on `Button variant="accent"` cannot turn it blue.
    expect(getThemeBlock('.v6c-send-btn')).toContain('background-image: linear-gradient(var(--v6c-send-fill), var(--v6c-send-fill));')
    expect(getThemeBlock('.v6c-send-btn:disabled')).toContain('background-image: linear-gradient(var(--color-surface-container-high), var(--color-surface-container-high));')
    // Under-composer strip stays flush on dark canvas without an elevated slab.
    expect(getThemeBlock('[data-testid="composer-context-strip"].surface-glass')).toContain('background: transparent;')
    expect(normalizedCss).toContain('.codex-edge-fade {')
    expect(normalizedCss).toContain('.codex-work-row {')
    expect(normalizedCss).toContain('.thinking-cursor {')
    expect(normalizedCss).toContain('.turn-status-shimmer {')
  })

  it('reads on cool paper while <html> keeps the pre-paint ground', () => {
    expect(root).toContain('--color-background: var(--cc-bg);')
    expect(root).toContain('--color-surface: var(--cc-paper);')
    expect(root).toContain('--color-surface-container-lowest: var(--cc-paper);')
    expect(hex(light, '--cc-paper').value).toBe(hex(light, '--cc-bg').value)
    for (const block of [light, dark]) {
      const paper = hex(block, '--cc-paper')
      const rgb = /--cc-paper-rgb:\s*([^;]+);/.exec(block)?.[1]
      expect(rgb).toBe(`${paper.r}, ${paper.g}, ${paper.b}`)
    }
  })

  it('casts only neutral shadows: no elevation token is tinted by the brand', () => {
    const shadowTokens = [
      '--cc-shadow-card', '--cc-shadow-composer', '--cc-shadow-overlay',
      '--shadow-dialog-glass', '--shadow-dropdown-glass', '--shadow-button-primary',
      '--shadow-raised', '--shadow-segment', '--bevel-cta-rest', '--v6c-send-shadow',
    ]
    for (const token of shadowTokens) {
      for (const match of normalizedCss.matchAll(new RegExp(`${token}:\\s*([^;]+);`, 'g'))) {
        expect(match[1], `${token} must not glow in the brand color`).not.toMatch(/--cc-ac|--color-brand|--color-primary/)
      }
    }
  })

  it('keeps every V6C glass fill dense enough that text behind never competes', () => {
    for (const token of ['--color-surface-composer-glass']) {
      for (const match of normalizedCss.matchAll(new RegExp(`${token}:\\s*([^;]+);`, 'g'))) {
        const alpha = Number(/,\s*([0-9.]+)\s*\)\s*$/.exec(match[1]!)?.[1])
        expect(alpha, `${token} "${match[1]}" is too sheer`).toBeGreaterThanOrEqual(0.8)
      }
    }
    for (const token of ['--glass-rim', '--glass-top-rim', '--color-sidebar-glass']) {
      expect(root, `${token} light`).toContain(`${token}:`)
      expect(getThemeBlock('[data-theme="dark"]'), `${token} dark`).toContain(`${token}:`)
    }
  })

  it('shields the floating composer with an opaque, Safari-15-safe fade', () => {
    const shield = getThemeBlock('.composer-fade::before')
    // `transparent` interpolates through black on Safari 15 and greys the fade.
    expect(shield).not.toMatch(/\btransparent\b/)
    expect(shield).toMatch(/linear-gradient\(to bottom, rgba\(var\(--cc-paper-rgb\), 0\)[^;]*var\(--color-surface\) 100%\)/)
    expect(getThemeBlock('.composer-fade')).toContain('background-color: var(--color-surface);')
  })

  it('ships the shared V6C utilities inside @layer components', () => {
    const layered = normalizedCss.slice(normalizedCss.indexOf('/* ─── V6C Calm Liquid Glass utilities'))
    const layerStart = normalizedCss.lastIndexOf('@layer components {', normalizedCss.indexOf('/* ─── V6C Calm Liquid Glass utilities'))
    expect(layerStart).toBeGreaterThanOrEqual(0)
    for (const selector of [
      '.v6c-ambient-shell {', '.v6c-main-canvas {', '.v6c-sidebar-glass {', '.v6c-glass-card {',
      '.v6c-raised {', '.v6c-field {', '.v6c-track {', '.v6c-row-highlight {', '.v6c-active-bar::before {',
      '.v6c-ring-running {', '.v6c-ring-waiting {', '.v6c-ring-success {', '.v6c-ring-error {',
      '.v6c-pressable {', '.v6c-send-btn {', '.v6c-send-btn:disabled {',
    ]) {
      expect(layered, `missing utility ${selector}`).toContain(selector)
    }
    expect(getThemeBlock('.v6c-send-btn')).toContain('box-shadow: var(--v6c-send-shadow);')
  })

  it('drops every glass surface to an opaque fill under reduced transparency', () => {
    const media = getThemeBlock('@media (prefers-reduced-transparency: reduce)')
    for (const selector of ['.glass-panel', '.surface-glass', '.dropdown-glass', '.dialog-panel', '.composer-glass', '.v6c-glass-card', '.v6c-sidebar-glass']) {
      expect(media, `${selector} under prefers-reduced-transparency`).toContain(selector)
    }
    expect(media).toContain('backdrop-filter: none;')
    expect(normalizedCss).toMatch(/html\[data-reduced-transparency="true"\] :is\([^)]*\.composer-glass[^)]*\) \{[^}]*backdrop-filter: none;/)
    expect(normalizedCss).toContain('html[data-reduced-transparency="true"] .v6c-sidebar-glass {')
    expect(getThemeBlock('@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)))')).toContain('.v6c-sidebar-glass')
  })

  it('draws V6C status rings as inset outlines so overflow-hidden cards never clip them', () => {
    for (const ring of ['running', 'waiting', 'success', 'error'] as const) {
      const value = new RegExp(`--v6c-ring-${ring}:\\s*([^;]+);`).exec(root)?.[1] ?? ''
      expect(value, `--v6c-ring-${ring} should be inset`).toMatch(/^inset\s+0\s+0\s+0\s+1\.5px\b/)
      const rule = getThemeBlock(`.v6c-ring-${ring}`)
      expect(rule).toContain(`var(--v6c-ring-${ring})`)
      expect(rule).toContain('var(--shadow-card)')
      expect(rule).toContain('var(--glass-rim)')
    }
  })

  it('keeps .composer-glass free of backdrop-filter so descendant popovers blur cleanly without text bleed-through', () => {
    // A `backdrop-filter` on `.composer-glass` creates a Chromium Backdrop Root
    // that disables blur on descendant `.dropdown-glass` menus.
    const composer = getThemeBlock('.composer-glass')
    expect(composer).not.toMatch(/backdrop-filter\s*:/)
    for (const token of ['--color-surface-glass', '--color-surface-composer-glass']) {
      for (const match of normalizedCss.matchAll(new RegExp(`${token}:\\s*([^;]+);`, 'g'))) {
        const alpha = Number(/,\s*([0-9.]+)\s*\)\s*$/.exec(match[1]!)?.[1])
        expect(alpha, `${token} "${match[1]}" should be >= 0.95 to prevent bleed-through`).toBeGreaterThanOrEqual(0.95)
      }
    }
  })

  it('keeps .dropdown-glass inside @layer components so focus-visible rings and hover utilities win on glass buttons', () => {
    const componentsStart = normalizedCss.lastIndexOf('@layer components {', normalizedCss.indexOf('.dropdown-glass {'))
    expect(componentsStart).toBeGreaterThanOrEqual(0)
    const componentsBlock = getThemeBlock('@layer components')
    expect(componentsBlock).toContain('.dropdown-glass {')
    expect(componentsBlock).toContain('.surface-glass {')
    // Must appear after `.v6c-raised` so floating buttons using both keep the
    // frosted glass rest surface while utility hover/focus-visible still win.
    expect(componentsBlock.indexOf('.dropdown-glass {')).toBeGreaterThan(componentsBlock.indexOf('.v6c-raised {'))
  })

  it('lets .v6c-send-btn:active override .control-bevel-cta:active without a duplicate inset hairline', () => {
    const componentsBlock = getThemeBlock('@layer components')
    expect(componentsBlock).toContain('.control-bevel-cta:not(.v6c-send-btn)::before {')
    const bevelActive = componentsBlock.indexOf('.control-bevel-cta:active:not(:disabled):not([aria-haspopup]) {')
    const sendActive = componentsBlock.indexOf('.v6c-send-btn:active:not(:disabled):not([aria-haspopup]) {')
    expect(bevelActive).toBeGreaterThanOrEqual(0)
    expect(sendActive).toBeGreaterThan(bevelActive)
  })

  it('keeps dark-mode switch thumbs lit and inspector surfaces on cool paper', () => {
    expect(root).toContain('--color-inspector-surface: var(--cc-paper);')
    expect(dark).toContain('--color-switch-thumb: var(--cc-t1);')
  })

  it('keeps light-mode glass shadows airy and restrained rather than heavy halos', () => {
    const lightShadowTokens = [
      '--cc-shadow-card', '--cc-shadow-composer', '--cc-shadow-overlay',
      '--shadow-dialog-glass', '--shadow-dropdown-glass', '--shadow-raised',
      '--shadow-segment', '--v6c-row-highlight-shadow',
    ]
    for (const token of lightShadowTokens) {
      const value = new RegExp(`${token}:\\s*([^;]+);`).exec(`${light}\n${root}`)?.[1] ?? ''
      expect(value, `${token} should be declared`).not.toBe('')
      for (const [, alpha] of value.matchAll(/rgba\([^)]*,\s*([0-9.]+)\)/g)) {
        expect(Number(alpha), `${token} alpha ${alpha} is too heavy for light glass`).toBeLessThanOrEqual(0.14)
      }
    }
  })
})
