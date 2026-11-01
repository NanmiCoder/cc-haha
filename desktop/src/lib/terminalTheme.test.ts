import { afterEach, describe, expect, it } from 'vitest'
import { normalizeTerminalFontSize, readTerminalFontFamily } from './terminalTheme'

afterEach(() => document.documentElement.style.removeProperty('--font-mono'))

describe('terminal font fallback', () => {
  it('keeps the built-in stack after the requested family for missing fonts and glyphs', () => {
    document.documentElement.style.setProperty('--font-mono', '"JetBrains Mono", monospace')
    expect(readTerminalFontFamily(' Missing Nerd Font ')).toBe('"Missing Nerd Font", "JetBrains Mono", monospace')
    expect(readTerminalFontFamily('')).toBe('"JetBrains Mono", monospace')
    expect(readTerminalFontFamily('A "quoted", font')).toBe('"A \\"quoted\\", font", "JetBrains Mono", monospace')
  })

  it('uses a concrete monospace fallback without a usable CSS token', () => {
    document.documentElement.style.setProperty('--font-mono', 'var(--missing-font)')
    expect(readTerminalFontFamily('Menlo')).toBe('"Menlo", \'SFMono-Regular\', Consolas, monospace')
  })

  it.each([[undefined, 13], [NaN, 13], [Infinity, 13], ['18', 13], [null, 13], [0, 8], [100, 32], [16.6, 17]])(
    'normalizes font size %s to %s', (value, expected) => expect(normalizeTerminalFontSize(value)).toBe(expected),
  )
})
