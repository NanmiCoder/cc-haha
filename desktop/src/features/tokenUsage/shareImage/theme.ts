import type { ThemeMode } from '../../../types/settings'
import type { ShareTheme } from './layout'

/** Used when the stylesheet is not loaded (tests, a failed read). Mirrors the default white palette. */
const FALLBACK_THEME: ShareTheme = {
  bg: '#FFFFFF',
  bd: '#E9E8E5',
  bd2: '#D9D7D3',
  t1: '#1F1E1C',
  t2: '#55524D',
  t3: '#6F6B65',
  ac: '#A24A2E',
  series: ['#058D85', '#86412C', '#5066A3', '#99732B', '#A8A49C'],
}

export type ShareThemeChoice = ThemeMode | 'current'

/**
 * Reads a palette from the stylesheet instead of keeping a second copy of it.
 *
 * Every theme's variables are declared on a `[data-theme="…"]` selector, so a
 * detached element carrying that attribute resolves to that theme's values —
 * which is how the image can be drawn in a theme the app is not showing. The
 * source `--cc-*` tokens are read, not the `--color-*` layer: that layer is
 * declared once on `:root` and inherits its already-substituted values, so it
 * would always answer with the active theme.
 */
export function resolveShareTheme(choice: ShareThemeChoice, root: HTMLElement = document.documentElement): ShareTheme {
  let probe: HTMLElement | null = null
  let source: HTMLElement = root
  if (choice !== 'current') {
    probe = document.createElement('div')
    probe.setAttribute('data-theme', choice)
    probe.style.display = 'none'
    document.body.appendChild(probe)
    source = probe
  }

  try {
    const style = getComputedStyle(source)
    const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
    return {
      bg: read('--cc-bg', FALLBACK_THEME.bg),
      bd: read('--cc-bd', FALLBACK_THEME.bd),
      bd2: read('--cc-bd2', FALLBACK_THEME.bd2),
      t1: read('--cc-t1', FALLBACK_THEME.t1),
      t2: read('--cc-t2', FALLBACK_THEME.t2),
      t3: read('--cc-t3', FALLBACK_THEME.t3),
      ac: read('--cc-ac', FALLBACK_THEME.ac),
      series: FALLBACK_THEME.series.map((fallback, index) => read(`--cc-series-${index + 1}`, fallback)),
    }
  } finally {
    probe?.remove()
  }
}
