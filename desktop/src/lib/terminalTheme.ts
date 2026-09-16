/**
 * Bridges the CSS terminal tokens into an xterm.js `ITheme` object.
 *
 * xterm renders to canvas/WebGL and cannot read CSS variables itself, so the
 * values have to be resolved in JS. Keeping that resolution here — rather than
 * inline in the terminal component — means the palette stays defined once, in
 * `theme/globals.css`, and every embedded terminal follows the active
 * `<html data-theme>` instead of hardcoding a single dark scheme.
 */

/** Matches xterm's `ITheme` without importing the module (it is lazy-loaded). */
export type TerminalPalette = {
  background: string
  foreground: string
  cursor: string
  cursorAccent: string
  selectionBackground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

/**
 * Used when a token is missing or the document is unavailable (SSR, tests).
 * Mirrors the dark theme so a terminal never renders as transparent-on-black.
 */
const FALLBACK: TerminalPalette = {
  background: '#121212',
  foreground: '#D7D2D0',
  cursor: '#FFB59F',
  cursorAccent: '#121212',
  selectionBackground: '#5F4A40',
  black: '#1F1F1F',
  red: '#FF6D67',
  green: '#7EF18A',
  yellow: '#F8C55F',
  blue: '#77A8FF',
  magenta: '#D699FF',
  cyan: '#61D6D6',
  white: '#D7D2D0',
  brightBlack: '#8F8683',
  brightRed: '#FF8A85',
  brightGreen: '#9FF7A7',
  brightYellow: '#FFDD7A',
  brightBlue: '#A6C5FF',
  brightMagenta: '#E3B8FF',
  brightCyan: '#8CEEEE',
  brightWhite: '#FFFFFF',
}

const TOKEN_BY_SLOT: Record<keyof TerminalPalette, string> = {
  background: '--color-terminal-bg',
  foreground: '--color-terminal-fg',
  cursor: '--color-terminal-cursor',
  cursorAccent: '--color-terminal-bg',
  selectionBackground: '--color-terminal-selection',
  black: '--color-terminal-ansi-black',
  red: '--color-terminal-ansi-red',
  green: '--color-terminal-ansi-green',
  yellow: '--color-terminal-ansi-yellow',
  blue: '--color-terminal-ansi-blue',
  magenta: '--color-terminal-ansi-magenta',
  cyan: '--color-terminal-ansi-cyan',
  white: '--color-terminal-ansi-white',
  brightBlack: '--color-terminal-ansi-bright-black',
  brightRed: '--color-terminal-ansi-bright-red',
  brightGreen: '--color-terminal-ansi-bright-green',
  brightYellow: '--color-terminal-ansi-bright-yellow',
  brightBlue: '--color-terminal-ansi-bright-blue',
  brightMagenta: '--color-terminal-ansi-bright-magenta',
  brightCyan: '--color-terminal-ansi-bright-cyan',
  brightWhite: '--color-terminal-ansi-bright-white',
}

/**
 * Reads the terminal palette for the theme currently on `<html>`.
 *
 * Call this again whenever the theme changes and assign the result to
 * `terminal.options.theme` — xterm repaints on assignment.
 */
export function readTerminalPalette(root?: HTMLElement): TerminalPalette {
  const element = root ?? (typeof document === 'undefined' ? null : document.documentElement)
  if (!element || typeof getComputedStyle !== 'function') return { ...FALLBACK }

  const computed = getComputedStyle(element)
  const palette = { ...FALLBACK }
  for (const [slot, token] of Object.entries(TOKEN_BY_SLOT) as Array<[keyof TerminalPalette, string]>) {
    const value = computed.getPropertyValue(token).trim()
    if (value) palette[slot] = value
  }
  return palette
}

/** Resolve custom properties before passing fonts to xterm's canvas renderer. */
export function readTerminalFontFamily(root?: HTMLElement): string {
  const element = root ?? (typeof document === 'undefined' ? null : document.documentElement)
  const fallback = "'SFMono-Regular', Consolas, monospace"
  if (!element || typeof getComputedStyle !== 'function') return fallback
  const font = getComputedStyle(element).getPropertyValue('--font-mono').trim()
  return font && !font.includes('var(') ? font : fallback
}
