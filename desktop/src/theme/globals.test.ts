import { describe, expect, it } from 'vitest'

import css from './globals.css?raw'

const normalizedCss = css.replace(/\r\n/g, '\n')

function getThemeBlock(selector: ':root,\n[data-theme="light"]' | '[data-theme="white"]' | '[data-theme="dark"]') {
  const start = normalizedCss.indexOf(`${selector} {`)
  expect(start).toBeGreaterThanOrEqual(0)

  const bodyStart = normalizedCss.indexOf('{', start)
  let depth = 0
  for (let index = bodyStart; index < normalizedCss.length; index += 1) {
    const char = normalizedCss[index]
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) {
        return normalizedCss.slice(bodyStart + 1, index)
      }
    }
  }

  throw new Error(`Theme block not closed: ${selector}`)
}

function getCssBetween(startMarker: string, endMarker: string) {
  const start = normalizedCss.indexOf(startMarker)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = normalizedCss.indexOf(endMarker, start)
  expect(end).toBeGreaterThan(start)
  return normalizedCss.slice(start, end)
}

describe('desktop theme tokens', () => {
  const themes = [':root,\n[data-theme="light"]', '[data-theme="white"]', '[data-theme="dark"]'] as const
  const requiredTokens = [
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
    '--color-switch-checked-bg',
    '--color-switch-thumb',
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

  it('defines activity and status tokens for every supported theme', () => {
    for (const theme of themes) {
      const block = getThemeBlock(theme)

      for (const token of requiredTokens) {
        expect(block, `${theme} should define ${token}`).toContain(`${token}:`)
      }
    }
  })

  it('keeps activity heatmap colors on the app theme accent instead of the old blue ramp', () => {
    expect(css).not.toContain('#DCEEFF')
    expect(css).not.toContain('#B6D9FF')
    expect(css).not.toContain('#2387E8')
    expect(css).toContain('--color-activity-heat-4: var(--color-primary);')
    expect(css).toContain('.activity-heat-cell:hover')
    expect(css).toContain('box-shadow: var(--shadow-activity-cell-hover);')
  })

  it('maps switch activation to each theme brand color', () => {
    for (const theme of themes) {
      const block = getThemeBlock(theme)

      expect(block, `${theme} should use its brand color for checked switches`)
        .toContain('--color-switch-checked-bg: var(--color-brand);')
    }
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
    const zoomShellCss = getCssBetween('.settings-zoom-kbd {', '/* ─── Tailwind Theme Override')

    expect(zoomShellCss).not.toContain('color-mix(')
  })

  it('keeps the UI zoom slider thumb visible in dark mode', () => {
    expect(css).toContain('[data-theme="dark"] .settings-zoom-control')
    expect(css).toContain('--settings-zoom-thumb-bg: var(--color-surface-bright);')
    expect(css).toContain('--settings-zoom-thumb-border: rgba(255, 181, 159, 0.78);')
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
})
