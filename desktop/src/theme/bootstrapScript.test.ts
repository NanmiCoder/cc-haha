/**
 * The theme is resolved twice: once by an inline script in index.html that
 * runs before any stylesheet is parsed, and once by the app bundle after its
 * dynamic imports settle. If the two ever disagree the user sees exactly the
 * flash the inline script exists to prevent, so this pins them together over
 * every combination of stored state.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

import {
  DARK_THEME_MODES,
  LIGHT_THEME_MODES,
  THEME_MODES,
  isDarkTheme,
  type DarkThemeMode,
  type LightThemeMode,
  type ThemeMode,
} from '../types/settings'
import {
  readStoredDarkTheme,
  readStoredFollowSystemTheme,
  readStoredLightTheme,
  readStoredTheme,
  resolveAppliedTheme,
  THEME_BACKGROUNDS,
  type SystemAppearance,
} from './systemAppearance'

const html = readFileSync(join(__dirname, '..', '..', 'index.html'), 'utf-8')

/** Pull the pre-hydration IIFE out of index.html so it can be run as-is. */
function extractBootstrapScript(): string {
  const marker = 'Resolve the theme synchronously'
  const markerIndex = html.indexOf(marker)
  expect(markerIndex, 'index.html lost its pre-hydration theme script').toBeGreaterThan(0)

  const scriptStart = html.lastIndexOf('<script>', markerIndex)
  const bodyStart = scriptStart + '<script>'.length
  const bodyEnd = html.indexOf('</script>', bodyStart)
  expect(bodyEnd).toBeGreaterThan(bodyStart)

  return html.slice(bodyStart, bodyEnd)
}

const bootstrapScript = extractBootstrapScript()

function runBootstrapScript(): { theme: string | null; colorScheme: string; themeColor: string | null } {
  // eslint-disable-next-line no-new-func -- running the shipped script verbatim is the point
  new Function(bootstrapScript)()
  return {
    theme: document.documentElement.getAttribute('data-theme'),
    colorScheme: document.documentElement.style.colorScheme,
    themeColor: document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? null,
  }
}

function stubMatchMedia(prefersDark: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    value: () => ({ matches: prefersDark, media: '(prefers-color-scheme: dark)' }),
    configurable: true,
    writable: true,
  })
}

function seedStorage(stored: {
  theme?: string
  follow?: string
  lightTheme?: string
  darkTheme?: string
}) {
  window.localStorage.clear()
  if (stored.theme !== undefined) window.localStorage.setItem('cc-haha-theme', stored.theme)
  if (stored.follow !== undefined) window.localStorage.setItem('cc-haha-follow-system-theme', stored.follow)
  if (stored.lightTheme !== undefined) window.localStorage.setItem('cc-haha-light-theme', stored.lightTheme)
  if (stored.darkTheme !== undefined) window.localStorage.setItem('cc-haha-dark-theme', stored.darkTheme)
}

/** What the app bundle would land on for the same stored state. */
function resolveViaAppBundle(systemAppearance: SystemAppearance): ThemeMode {
  return resolveAppliedTheme({
    followSystem: readStoredFollowSystemTheme(window.localStorage),
    theme: readStoredTheme(window.localStorage),
    lightTheme: readStoredLightTheme(window.localStorage),
    darkTheme: readStoredDarkTheme(window.localStorage),
    systemAppearance,
  })
}

/** The shipped markup carries this meta; jsdom starts without it. */
beforeEach(() => {
  const meta = document.createElement('meta')
  meta.setAttribute('name', 'theme-color')
  meta.setAttribute('content', '#000000')
  document.head.appendChild(meta)
})

afterEach(() => {
  window.localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.style.colorScheme = ''
  document.querySelector('meta[name="theme-color"]')?.remove()
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'matchMedia')
})

describe('index.html pre-hydration theme script', () => {
  it('runs before the app module so the first paint is already themed', () => {
    const scriptIndex = html.indexOf('Resolve the theme synchronously')
    const moduleIndex = html.indexOf('type="module"')

    expect(scriptIndex).toBeGreaterThan(0)
    expect(moduleIndex).toBeGreaterThan(scriptIndex)
  })

  it('no longer hardcodes a light theme on the html element', () => {
    // The hardcoded data-theme="white" was the flash: a dark-theme user saw a
    // white window until the bundle finished loading.
    expect(html).not.toMatch(/<html[^>]*data-theme=/)
  })

  it('paints each theme background before globals.css is parsed', () => {
    for (const [theme, background] of Object.entries(THEME_BACKGROUNDS)) {
      const rule = new RegExp(
        `html\\[data-theme="${theme}"\\]\\s*\\{\\s*background:\\s*${background}\\s*;`,
        'i',
      )
      expect(rule.test(html), `index.html lost the ${theme} pre-paint background`).toBe(true)
    }
  })

  // The status bar sits on top of the page under viewport-fit=cover, so a
  // theme-color left on the previous palette shows up as a mismatched band
  // above the header — the exact artifact cover was added to remove.
  it('colors the browser chrome with the resolved palette', () => {
    for (const theme of THEME_MODES) {
      stubMatchMedia(false)
      seedStorage({ theme, follow: '0' })

      expect(runBootstrapScript().themeColor, `${theme} left the browser chrome unpainted`)
        .toBe(THEME_BACKGROUNDS[theme])
    }
  })

  it('leaves the document alone when the markup carries no theme-color meta', () => {
    document.querySelector('meta[name="theme-color"]')?.remove()
    stubMatchMedia(false)
    seedStorage({ theme: 'dark', follow: '0' })

    expect(runBootstrapScript().theme).toBe('dark')
  })

  it('falls back to the default palette when no theme was resolved', () => {
    // A CSP that strips the inline script removes the element outright, so its
    // try/catch cannot help. The bare rule is the only thing left, and it has
    // to agree with the default palette globals.css will apply moments later.
    const bare = /(?:^|\n)\s*html\s*\{\s*background:\s*(#[0-9A-Fa-f]{6})\s*;/.exec(html)
    expect(bare, 'index.html lost its themeless background fallback').not.toBeNull()
    expect(bare![1]!.toUpperCase()).toBe(THEME_BACKGROUNDS.white.toUpperCase())
  })

  it('keeps neutral dark when browser chrome painting throws after resolution', () => {
    seedStorage({ theme: 'neutral-dark', follow: '0' })
    const query = vi.spyOn(document, 'querySelector').mockImplementation(() => { throw new Error('browser chrome unavailable') })
    try {
      // eslint-disable-next-line no-new-func -- exercise the shipped catch path
      new Function(bootstrapScript)()
      expect(document.documentElement.getAttribute('data-theme')).toBe('neutral-dark')
      expect(document.documentElement.style.colorScheme).toBe('dark')
    } finally {
      query.mockRestore()
    }
  })

  // Dirty values are reachable, not hypothetical: the inline script runs
  // before runDesktopPersistenceMigrations() has had a chance to drop them,
  // so both implementations must agree on garbage too.
  const storedThemes: Array<string | undefined> = [undefined, ...THEME_MODES, 'light', 'solarized', '']
  const storedFollows: Array<string | undefined> = [undefined, '0', '1', 'yes', 'true', '']
  // A palette from the other ground is the interesting dirty value here: it is
  // a real theme name, just not a valid preference for this half.
  const storedLightThemes: Array<string | undefined> = [undefined, ...LIGHT_THEME_MODES, 'ink-blue', 'neon']
  const storedDarkThemes: Array<string | undefined> = [undefined, ...DARK_THEME_MODES, 'celadon', 'neon']
  const appearances: SystemAppearance[] = ['dark', 'light']

  it('agrees with resolveAppliedTheme across every stored combination', () => {
    for (const theme of storedThemes) {
      for (const follow of storedFollows) {
        for (const lightTheme of storedLightThemes) {
          for (const darkTheme of storedDarkThemes) {
            for (const appearance of appearances) {
              seedStorage({ theme, follow, lightTheme, darkTheme })
              stubMatchMedia(appearance === 'dark')

              const expected = resolveViaAppBundle(appearance)
              const actual = runBootstrapScript()

              expect(
                actual.theme,
                `stored theme=${theme} follow=${follow} light=${lightTheme} dark=${darkTheme} system=${appearance}`,
              ).toBe(expected)
              expect(actual.colorScheme).toBe(isDarkTheme(expected) ? 'dark' : 'light')
            }
          }
        }
      }
    }
  })

  it('falls back to a readable theme when storage is unreadable', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage')
    Object.defineProperty(window, 'localStorage', {
      get() { throw new Error('storage disabled') },
      configurable: true,
    })
    stubMatchMedia(false)

    try {
      expect(runBootstrapScript().theme).toBe('white')
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original)
    }
  })

  it('does not follow the system for an install that opted out', () => {
    seedStorage({ theme: 'white', follow: '0' })
    stubMatchMedia(true)

    expect(runBootstrapScript().theme).toBe('white')
  })

  it('starts a fresh install dark when the OS is dark', () => {
    // The reported bug: opening the app at night flashed white.
    seedStorage({})
    stubMatchMedia(true)

    const result = runBootstrapScript()
    expect(result.theme).toBe('dark')
    expect(result.colorScheme).toBe('dark')
  })

  it('keeps the chosen palette for each ground', () => {
    seedStorage({
      theme: 'ink-blue',
      follow: '1',
      lightTheme: 'celadon' satisfies LightThemeMode,
      darkTheme: 'ink-blue' satisfies DarkThemeMode,
    })

    stubMatchMedia(false)
    expect(runBootstrapScript().theme).toBe('celadon')

    stubMatchMedia(true)
    expect(runBootstrapScript().theme).toBe('ink-blue')
  })
})
