import { describe, expect, it } from 'vitest'

import css from './globals.css?raw'

function getThemeBlock(selector: ':root,\n[data-theme="light"]' | '[data-theme="white"]' | '[data-theme="dark"]') {
  const start = css.indexOf(`${selector} {`)
  expect(start).toBeGreaterThanOrEqual(0)

  const bodyStart = css.indexOf('{', start)
  let depth = 0
  for (let index = bodyStart; index < css.length; index += 1) {
    const char = css[index]
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) {
        return css.slice(bodyStart + 1, index)
      }
    }
  }

  throw new Error(`Theme block not closed: ${selector}`)
}

function getCssBetween(startMarker: string, endMarker: string) {
  const start = css.indexOf(startMarker)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = css.indexOf(endMarker, start)
  expect(end).toBeGreaterThan(start)
  return css.slice(start, end)
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
})
