import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { App, BrowserWindow } from 'electron'
import legacyAppearance from '../../src/test/fixtures/appearance-state-v1.json'

import {
  DEFAULT_DARK_THEME,
  DEFAULT_LIGHT_THEME,
  THEME_BACKGROUNDS,
} from '../../src/theme/systemAppearance'
import {
  APPEARANCE_STATE_FILE,
  applyAppliedAppearance,
  appearanceStatePath,
  DARK_WINDOW_BACKGROUND,
  isAppliedAppearance,
  LIGHT_WINDOW_BACKGROUND,
  readAppearanceState,
  startupWindowBackground,
  writeAppearanceState,
  type AppliedAppearance,
} from './nativeAppearance'

const tempDirs: string[] = []

const WARM_LIGHT = '#F6F0E1'

/** A well-formed report, overridable per case. */
function appearance(overrides: Partial<AppliedAppearance> = {}): AppliedAppearance {
  return {
    isDark: false,
    background: '#FFFFFF',
    lightBackground: '#FFFFFF',
    darkBackground: DARK_WINDOW_BACKGROUND,
    followSystem: false,
    ...overrides,
  }
}

function makeApp(): { app: App; home: string; env: NodeJS.ProcessEnv } {
  const home = mkdtempSync(path.join(tmpdir(), 'electron-appearance-'))
  tempDirs.push(home)
  return {
    home,
    // Every case below has to resolve inside its own `home`. Left to default,
    // these functions read `process.env`, and a CLAUDE_CONFIG_DIR set there
    // outranks `app.getPath('home')` — collapsing every case onto one shared
    // file, where one reads what another wrote. That is not hypothetical: the
    // sandboxed environment `check:coverage` runs under sets it, which is why
    // this file passed under `check:desktop` and failed under coverage.
    env: {},
    app: { getPath: vi.fn(() => home) } as unknown as App,
  }
}

function fakeWindow(destroyed = false) {
  return {
    isDestroyed: vi.fn(() => destroyed),
    setBackgroundColor: vi.fn(),
  } as unknown as BrowserWindow & {
    isDestroyed: ReturnType<typeof vi.fn>
    setBackgroundColor: ReturnType<typeof vi.fn>
  }
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

describe('appearance state persistence', () => {
  it('stores the cache next to the other desktop state under ~/.claude', () => {
    const { app, home } = makeApp()
    expect(appearanceStatePath(app, {})).toBe(path.join(home, '.claude', APPEARANCE_STATE_FILE))
  })

  it('honours CLAUDE_CONFIG_DIR for portable installs', () => {
    const { app } = makeApp()
    expect(appearanceStatePath(app, { CLAUDE_CONFIG_DIR: '/portable/config' }))
      .toBe(path.join('/portable/config', APPEARANCE_STATE_FILE))
  })

  it('round-trips what the renderer reported', () => {
    const { app, env } = makeApp()
    const state = appearance({ isDark: true, background: '#201D17', lightBackground: WARM_LIGHT, followSystem: true })

    writeAppearanceState(app, state, env)

    expect(readAppearanceState(app, env)).toEqual(state)
  })

  it('returns null rather than throwing on a missing or corrupt cache', () => {
    const { app, env } = makeApp()
    expect(readAppearanceState(app, env)).toBeNull()

    const statePath = appearanceStatePath(app, env)
    writeAppearanceState(app, appearance(), env)
    writeFileSync(statePath, '{ not json')

    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(readAppearanceState(app, env)).toBeNull()
    error.mockRestore()
  })

  it('rejects a cache whose background is not a plain hex color', () => {
    const { app, env } = makeApp()
    writeAppearanceState(app, appearance(), env)
    writeFileSync(
      appearanceStatePath(app, env),
      JSON.stringify({ ...appearance(), background: 'url(evil)' }),
    )

    expect(readAppearanceState(app, env)).toBeNull()
  })

  it('refuses to persist a malformed payload', () => {
    const { app, env } = makeApp()
    writeAppearanceState(app, appearance({ background: 'red' }), env)

    expect(readAppearanceState(app, env)).toBeNull()
  })

  it.each([true, false])('migrates the old appearance JSON forward without dropping fields (isDark=%s)', (isDark) => {
    const { app, env } = makeApp()
    const statePath = appearanceStatePath(app, env)
    writeAppearanceState(app, appearance(), env)
    const oldState = { ...legacyAppearance, isDark, background: isDark ? legacyAppearance.background : WARM_LIGHT }
    writeFileSync(statePath, JSON.stringify(oldState))

    const migrated = readAppearanceState(app, env)
    const darkBackground = isDark ? legacyAppearance.background : DARK_WINDOW_BACKGROUND
    expect(migrated).toEqual({ ...oldState, darkBackground })
    expect(startupWindowBackground(migrated, true)).toBe(darkBackground)
    expect(startupWindowBackground(migrated, false)).toBe(WARM_LIGHT)
    writeAppearanceState(app, migrated!, env)
    const once = readFileSync(statePath, 'utf8')
    writeAppearanceState(app, readAppearanceState(app, env)!, env)
    expect(readFileSync(statePath, 'utf8')).toBe(once)
    expect(JSON.parse(once)).toEqual({ ...oldState, darkBackground })
  })

  it('round-trips the dark preference while the applied theme is light', () => {
    const { app, env } = makeApp()
    writeAppearanceState(app, appearance({ background: WARM_LIGHT, lightBackground: WARM_LIGHT, darkBackground: '#202020', followSystem: true }), env)
    const restarted = readAppearanceState(app, env)
    expect(startupWindowBackground(restarted, true)).toBe('#202020')
    expect(startupWindowBackground(restarted, false)).toBe(WARM_LIGHT)
  })
})

describe('isAppliedAppearance', () => {
  it('accepts a well formed payload', () => {
    expect(isAppliedAppearance(appearance({ isDark: true, background: '#201d17' }))).toBe(true)
    expect(isAppliedAppearance(legacyAppearance)).toBe(true)
    expect(isAppliedAppearance(appearance({ darkBackground: '#202020' }))).toBe(true)
  })

  it.each([
    ['null', null],
    ['a non-object', 'dark'],
    ['a missing flag', { background: '#FFFFFF', lightBackground: '#FFFFFF', followSystem: true }],
    ['a missing light background', { isDark: false, background: '#FFFFFF', followSystem: true }],
    ['a shorthand hex', appearance({ background: '#FFF' })],
    ['a named color', appearance({ background: 'white' })],
    ['a translucent dark background', appearance({ darkBackground: '#80202020' })],
    ['a named dark background', appearance({ darkBackground: 'black' })],
    ['a null dark background', { ...appearance(), darkBackground: null }],
    ['a CSS function', appearance({ background: 'rgb(0,0,0)' })],
    ['a bad light background', appearance({ lightBackground: 'white' })],
  ])('rejects %s', (_label, payload) => {
    expect(isAppliedAppearance(payload)).toBe(false)
  })
})

describe('startupWindowBackground', () => {
  it('uses the OS setting on a first launch with no cache', () => {
    expect(startupWindowBackground(null, true)).toBe(DARK_WINDOW_BACKGROUND)
    expect(startupWindowBackground(null, false)).toBe(LIGHT_WINDOW_BACKGROUND)
  })

  it('replays a fixed theme regardless of the OS setting', () => {
    const cached = appearance({ background: WARM_LIGHT, lightBackground: WARM_LIGHT })

    expect(startupWindowBackground(cached, true)).toBe(WARM_LIGHT)
    expect(startupWindowBackground(cached, false)).toBe(WARM_LIGHT)
  })

  it('re-resolves a following install against the OS as it is now', () => {
    // Cached light, but the user turned the OS dark while the app was closed.
    const cached = appearance({ background: WARM_LIGHT, lightBackground: WARM_LIGHT, followSystem: true })

    expect(startupWindowBackground(cached, true)).toBe(DARK_WINDOW_BACKGROUND)
    expect(startupWindowBackground(cached, false)).toBe(WARM_LIGHT)
  })

  it('repaints the light half with the theme the user actually picked', () => {
    // Cached at night on the dark theme. Opening in the morning must land on
    // the user's warm light theme, not on plain white — the white step is the
    // exact flash this feature exists to remove.
    const cached = appearance({
      isDark: true,
      background: '#201D17',
      lightBackground: WARM_LIGHT,
      followSystem: true,
    })

    expect(startupWindowBackground(cached, false)).toBe(WARM_LIGHT)
  })

  it.each(['neutral-dark', 'ink-blue'] as const)('keeps the selected %s ground on startup and native appearance updates', (theme) => {
    const background = THEME_BACKGROUNDS[theme]
    const cached = appearance({ background: WARM_LIGHT, lightBackground: WARM_LIGHT, darkBackground: background, followSystem: true })

    // The app last reported a light theme; its independent dark preference
    // must survive a restart or any native "updated" event while dark.
    expect(startupWindowBackground(cached, true)).toBe(background)
    expect(startupWindowBackground(cached, true)).toBe(background)
    expect(startupWindowBackground(cached, false)).toBe(WARM_LIGHT)
  })
})

describe('applyAppliedAppearance', () => {
  it('repaints every live window and caches the result', () => {
    const { app, env } = makeApp()
    const first = fakeWindow()
    const second = fakeWindow()
    const state = appearance({ isDark: true, background: '#201D17', lightBackground: WARM_LIGHT })

    applyAppliedAppearance(state, { app, windows: () => [first, second], env })

    expect(first.setBackgroundColor).toHaveBeenCalledWith('#201D17')
    expect(second.setBackgroundColor).toHaveBeenCalledWith('#201D17')
    expect(JSON.parse(readFileSync(appearanceStatePath(app, env), 'utf-8'))).toEqual(state)
  })

  it('skips windows that were already torn down', () => {
    // quit/quitAndInstall can leave destroyed windows in the list; touching
    // one throws "Object has been destroyed".
    const { app, env } = makeApp()
    const destroyed = fakeWindow(true)

    applyAppliedAppearance(appearance({ followSystem: true }), { app, windows: () => [destroyed], env })

    expect(destroyed.setBackgroundColor).not.toHaveBeenCalled()
  })

  it('never pins nativeTheme.themeSource anywhere in the main process', () => {
    // Pinning it would override prefers-color-scheme in every renderer — the
    // very signal "follow the system" reads, so re-enabling the switch would
    // resolve against the pinned value — and it leaks into the preview
    // WebContentsView, forcing third-party pages to the app's theme. Reading
    // shouldUseDarkColors stays fine; only assignment is banned. See the note
    // at the top of nativeAppearance.ts before reintroducing it.
    for (const file of ['./nativeAppearance.ts', '../main.ts']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf-8')
      // Drop comments so the explanatory notes do not trip the check.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      expect(code, `${file} assigns themeSource`).not.toMatch(/themeSource\s*=[^=]/)
    }
  })
})

describe('window background constants', () => {
  it('match the renderer theme backgrounds', () => {
    // Third leg of the guard: globals.test.ts binds THEME_BACKGROUNDS to the
    // CSS and bootstrapScript.test.ts binds it to index.html, but the main
    // process had its own copies. Without this, changing the palette would
    // leave the pre-paint window color silently behind.
    expect(LIGHT_WINDOW_BACKGROUND).toBe(THEME_BACKGROUNDS.white)
    expect(DARK_WINDOW_BACKGROUND).toBe(THEME_BACKGROUNDS.dark)
    // The defaults of each half — what a first launch paints before the
    // renderer has reported a preference.
    expect(THEME_BACKGROUNDS[DEFAULT_LIGHT_THEME]).toBe(LIGHT_WINDOW_BACKGROUND)
    expect(THEME_BACKGROUNDS[DEFAULT_DARK_THEME]).toBe(DARK_WINDOW_BACKGROUND)
  })
})
