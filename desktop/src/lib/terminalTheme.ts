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

export const DEFAULT_TERMINAL_FONT_SIZE = 13
export const MIN_TERMINAL_FONT_SIZE = 8
export const MAX_TERMINAL_FONT_SIZE = 32

export function normalizeTerminalFontSize(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, value)))
    : DEFAULT_TERMINAL_FONT_SIZE
}

/** Resolve CSS tokens and retain fallbacks for unavailable fonts or missing glyphs. */
export function readTerminalFontFamily(fontFamily = '', root?: HTMLElement): string {
  const element = root ?? (typeof document === 'undefined' ? null : document.documentElement)
  const fallback = "'SFMono-Regular', Consolas, monospace"
  const font = element && typeof getComputedStyle === 'function'
    ? getComputedStyle(element).getPropertyValue('--font-mono').trim()
    : ''
  const defaults = font && !font.includes('var(') ? font : fallback
  const custom = fontFamily.trim()
  // Treat the input as one family name, including spaces, quotes or commas.
  return custom ? `${JSON.stringify(custom)}, ${defaults}` : defaults
}
