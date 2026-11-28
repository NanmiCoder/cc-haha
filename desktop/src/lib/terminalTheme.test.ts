import { afterEach, describe, expect, it } from 'vitest'
import { normalizeTerminalFontSize, readTerminalFontFamily, readTerminalPalette } from './terminalTheme'

afterEach(() => {
  document.documentElement.style.removeProperty('--font-mono')
  document.documentElement.style.removeProperty('--color-terminal-bg')
  document.documentElement.style.removeProperty('--color-terminal-fg')
})

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

describe('terminal palette fallback', () => {
  it('uses the V6C pure-neutral dark palette when CSS terminal tokens are absent', () => {
    expect(readTerminalPalette()).toEqual({
      background: '#181818',
      foreground: '#DFDFDF',
      cursor: '#DFDFDF',
      cursorAccent: '#181818',
      selectionBackground: '#16273A',
      black: '#181818',
      red: '#F67576',
      green: '#85DF7B',
      yellow: '#F2B84B',
      blue: '#6DCBF4',
      magenta: '#C18CFF',
      cyan: '#67D4D4',
      white: '#DFDFDF',
      brightBlack: '#969696',
      brightRed: '#FF8A8B',
      brightGreen: '#9CE893',
      brightYellow: '#FFD06B',
      brightBlue: '#8FD8FA',
      brightMagenta: '#D1A6FF',
      brightCyan: '#8AE3E3',
      brightWhite: '#FFFFFF',
    })
  })

  it('prefers computed CSS terminal tokens over fallback values when present', () => {
    document.documentElement.style.setProperty('--color-terminal-bg', '#FFFFFF')
    document.documentElement.style.setProperty('--color-terminal-fg', '#1A1C1F')
    const palette = readTerminalPalette()
    expect(palette.background).toBe('#FFFFFF')
    expect(palette.cursorAccent).toBe('#FFFFFF')
    expect(palette.foreground).toBe('#1A1C1F')
    expect(palette.selectionBackground).toBe('#16273A')
  })
})
