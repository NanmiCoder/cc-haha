import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { THEME_BACKGROUNDS } from '../theme/systemAppearance'

type Listener = (event: { matches: boolean }) => void

/**
 * The shipped index.html carries this meta; jsdom starts without it. It colors
 * the iOS status bar and the Android address bar, which under viewport-fit=cover
 * sit directly against the app's own background.
 */
function installThemeColorMeta() {
  document.querySelector('meta[name="theme-color"]')?.remove()
  const meta = document.createElement('meta')
  meta.setAttribute('name', 'theme-color')
  meta.setAttribute('content', '#000000')
  document.head.appendChild(meta)
}

function readThemeColor(): string | null {
  return document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? null
}

/** jsdom ships no matchMedia; the theme layer treats its absence as light. */
function stubMatchMedia(prefersDark: boolean) {
  const listeners = new Set<Listener>()
  Object.defineProperty(window, 'matchMedia', {
    value: () => ({
      matches: prefersDark,
      media: '(prefers-color-scheme: dark)',
      addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
      removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
    }),
    configurable: true,
    writable: true,
  })
  return {
    emit: (matches: boolean) => {
      for (const listener of listeners) listener({ matches })
    },
  }
}

afterEach(() => {
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'matchMedia')
  document.querySelector('meta[name="theme-color"]')?.remove()
})

describe('uiStore theme handling', () => {
  beforeEach(() => {
    vi.resetModules()
    window.localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.style.colorScheme = ''
    installThemeColorMeta()
  })

  it('defaults new installs to the pure white theme', async () => {
    const { initializeTheme, useUIStore } = await import('./uiStore')

    expect(useUIStore.getState().theme).toBe('white')
    initializeTheme()
    expect(document.documentElement.getAttribute('data-theme')).toBe('white')
    expect(document.documentElement.style.colorScheme).toBe('light')
  })

  it('hydrates and applies the pure white theme as a light color scheme', async () => {
    window.localStorage.setItem('cc-haha-theme', 'white')

    const { initializeTheme, useUIStore } = await import('./uiStore')

    expect(useUIStore.getState().theme).toBe('white')
    initializeTheme()
    expect(document.documentElement.getAttribute('data-theme')).toBe('white')
    expect(document.documentElement.style.colorScheme).toBe('light')
  })

  it('cycles through all eight palettes and wraps back to pure white', async () => {
    const { useUIStore } = await import('./uiStore')

    const cycle = ['glaze-white', 'paper', 'warm-classic', 'celadon', 'dark', 'deep-night', 'ink-blue', 'white']
    for (const expected of cycle) {
      useUIStore.getState().toggleTheme()
      expect(useUIStore.getState().theme).toBe(expected)
    }
  })

  it('reports a dark color scheme for both ink palettes, not just the one named dark', async () => {
    // `ink-blue` is a dark ground under a name that does not contain "dark".
    // Testing `theme === 'dark'` leaves native scrollbars and form controls in
    // their light variant against a near-black page.
    const { useUIStore } = await import('./uiStore')

    // Pick palettes by hand: while following the system the OS chooses the
    // ground, so a manual pick lands in a preference instead of on screen.
    useUIStore.setState({ followSystemTheme: false })
    useUIStore.getState().setTheme('ink-blue')
    expect(document.documentElement.getAttribute('data-theme')).toBe('ink-blue')
    expect(document.documentElement.style.colorScheme).toBe('dark')

    useUIStore.getState().setTheme('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')

    useUIStore.getState().setTheme('celadon')
    expect(document.documentElement.style.colorScheme).toBe('light')
  })

  // Under viewport-fit=cover the page runs under the status bar, so a stale
  // theme-color reads as a mismatched band above the header on every switch.
  it('repaints the browser chrome for every palette', async () => {
    const { useUIStore } = await import('./uiStore')
    useUIStore.setState({ followSystemTheme: false })

    for (const [theme, background] of Object.entries(THEME_BACKGROUNDS)) {
      useUIStore.getState().setTheme(theme as keyof typeof THEME_BACKGROUNDS)
      expect(readThemeColor(), `${theme} left the browser chrome unpainted`).toBe(background)
    }
  })

  it('applies a theme even when the document carries no theme-color meta', async () => {
    document.querySelector('meta[name="theme-color"]')?.remove()

    const { useUIStore } = await import('./uiStore')
    useUIStore.setState({ followSystemTheme: false })
    useUIStore.getState().setTheme('dark')

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })
})

describe('uiStore following the system appearance', () => {
  beforeEach(() => {
    vi.resetModules()
    window.localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.style.colorScheme = ''
    installThemeColorMeta()
  })

  it('starts a fresh install on the dark theme when the OS is dark', async () => {
    // The reported bug: at night the app opened white and had to be switched
    // by hand every time.
    stubMatchMedia(true)

    const { initializeTheme, useUIStore, teardownTheme } = await import('./uiStore')

    expect(useUIStore.getState().followSystemTheme).toBe(true)
    expect(useUIStore.getState().theme).toBe('dark')

    initializeTheme()
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')
    teardownTheme()
  })

  it('leaves an existing install on its fixed theme', async () => {
    window.localStorage.setItem('cc-haha-theme', 'white')
    stubMatchMedia(true)

    const { useUIStore } = await import('./uiStore')

    expect(useUIStore.getState().followSystemTheme).toBe(false)
    expect(useUIStore.getState().theme).toBe('white')
  })

  it('repaints when the OS flips while the app is open', async () => {
    const media = stubMatchMedia(false)

    const { initializeTheme, useUIStore, teardownTheme } = await import('./uiStore')
    initializeTheme()
    expect(useUIStore.getState().theme).toBe('white')

    media.emit(true)
    expect(useUIStore.getState().theme).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')

    media.emit(false)
    expect(useUIStore.getState().theme).toBe('white')
    expect(document.documentElement.getAttribute('data-theme')).toBe('white')
    teardownTheme()
  })

  it('ignores OS flips once the user opts out', async () => {
    const media = stubMatchMedia(false)

    const { initializeTheme, useUIStore, teardownTheme } = await import('./uiStore')
    initializeTheme()
    useUIStore.getState().setFollowSystemTheme(false)

    media.emit(true)
    expect(useUIStore.getState().theme).toBe('white')
    teardownTheme()
  })

  it('freezes the theme on screen when the switch is turned off', async () => {
    // Turning it off at night should keep the dark theme, not snap back to
    // the light half.
    stubMatchMedia(true)

    const { initializeTheme, useUIStore, teardownTheme } = await import('./uiStore')
    initializeTheme()
    expect(useUIStore.getState().theme).toBe('dark')

    useUIStore.getState().setFollowSystemTheme(false)
    expect(useUIStore.getState().theme).toBe('dark')
    expect(window.localStorage.getItem('cc-haha-theme')).toBe('dark')
    expect(window.localStorage.getItem('cc-haha-follow-system-theme')).toBe('0')
    teardownTheme()
  })

  it('stores a light pick as the light half without overriding a dark OS', async () => {
    stubMatchMedia(true)

    const { initializeTheme, useUIStore, teardownTheme } = await import('./uiStore')
    initializeTheme()

    useUIStore.getState().setTheme('warm-classic')

    // Still dark on screen — the OS says so — but tomorrow morning it is warm
    // classic rather than pure white.
    expect(useUIStore.getState().theme).toBe('dark')
    expect(useUIStore.getState().lightTheme).toBe('warm-classic')
    expect(window.localStorage.getItem('cc-haha-light-theme')).toBe('warm-classic')
    teardownTheme()
  })

  it('stores a dark pick as the dark half without overriding a light OS', async () => {
    // The symmetric case: ink-blue chosen at noon is remembered for tonight.
    stubMatchMedia(false)

    const { initializeTheme, useUIStore, teardownTheme } = await import('./uiStore')
    initializeTheme()

    useUIStore.getState().setTheme('ink-blue')

    expect(useUIStore.getState().theme).toBe('white')
    expect(useUIStore.getState().darkTheme).toBe('ink-blue')
    expect(window.localStorage.getItem('cc-haha-dark-theme')).toBe('ink-blue')
    teardownTheme()
  })

  it('applies a light pick immediately when the OS is already light', async () => {
    stubMatchMedia(false)

    const { initializeTheme, useUIStore, teardownTheme } = await import('./uiStore')
    initializeTheme()

    useUIStore.getState().setTheme('warm-classic')

    expect(useUIStore.getState().theme).toBe('warm-classic')
    expect(document.documentElement.getAttribute('data-theme')).toBe('warm-classic')
    teardownTheme()
  })

  it('rehydrates the switch and the light half after a restart', async () => {
    stubMatchMedia(false)

    const first = await import('./uiStore')
    first.initializeTheme()
    first.useUIStore.getState().setTheme('warm-classic')
    first.teardownTheme()

    vi.resetModules()
    stubMatchMedia(true)
    const recreated = await import('./uiStore')

    expect(recreated.useUIStore.getState().followSystemTheme).toBe(true)
    expect(recreated.useUIStore.getState().lightTheme).toBe('warm-classic')
    expect(recreated.useUIStore.getState().theme).toBe('dark')
  })

  it('releases the switch when the theme is cycled by hand', async () => {
    const media = stubMatchMedia(false)

    const { initializeTheme, useUIStore, teardownTheme } = await import('./uiStore')
    initializeTheme()
    expect(useUIStore.getState().followSystemTheme).toBe(true)

    // white -> glaze-white, the next palette in the rotation.
    useUIStore.getState().toggleTheme()

    expect(useUIStore.getState().followSystemTheme).toBe(false)
    media.emit(true)
    expect(useUIStore.getState().theme).toBe('glaze-white')
    teardownTheme()
  })

  it('drops the OS listener from a previous initialize', async () => {
    const media = stubMatchMedia(false)

    const { initializeTheme, useUIStore, teardownTheme } = await import('./uiStore')
    initializeTheme()
    teardownTheme()

    media.emit(true)
    expect(useUIStore.getState().theme).toBe('white')
  })

  it('does not revive the switch from a window whose store went stale', async () => {
    // The pet window is long-lived and runs the same bootstrap with its own
    // store over the shared localStorage. When the main window turns the
    // switch off, this window's in-memory copy still says "on" — acting on it
    // would write the user's choice straight back out.
    const media = stubMatchMedia(false)

    const { initializeTheme, useUIStore, teardownTheme } = await import('./uiStore')
    initializeTheme()
    expect(useUIStore.getState().followSystemTheme).toBe(true)

    // Another window opted out; only storage reflects it.
    window.localStorage.setItem('cc-haha-follow-system-theme', '0')

    media.emit(true)

    expect(window.localStorage.getItem('cc-haha-follow-system-theme')).toBe('0')
    expect(useUIStore.getState().theme).toBe('white')
    teardownTheme()
  })

  it('picks up the ground preferences another window chose', async () => {
    const media = stubMatchMedia(true)

    const { initializeTheme, useUIStore, teardownTheme } = await import('./uiStore')
    initializeTheme()
    expect(useUIStore.getState().theme).toBe('dark')

    window.localStorage.setItem('cc-haha-light-theme', 'celadon')
    window.localStorage.setItem('cc-haha-dark-theme', 'ink-blue')

    media.emit(false)
    expect(useUIStore.getState().theme).toBe('celadon')
    expect(useUIStore.getState().lightTheme).toBe('celadon')

    media.emit(true)
    expect(useUIStore.getState().theme).toBe('ink-blue')
    expect(useUIStore.getState().darkTheme).toBe('ink-blue')
    teardownTheme()
  })

  it('catches up when another window changes the appearance', async () => {
    stubMatchMedia(false)

    const { initializeTheme, useUIStore, teardownTheme } = await import('./uiStore')
    initializeTheme()
    expect(useUIStore.getState().theme).toBe('white')

    // A storage event is what the browser delivers to the windows that did
    // not perform the write.
    window.localStorage.setItem('cc-haha-theme', 'celadon')
    window.localStorage.setItem('cc-haha-light-theme', 'celadon')
    window.dispatchEvent(new StorageEvent('storage', { key: 'cc-haha-light-theme' }))

    expect(useUIStore.getState().theme).toBe('celadon')
    expect(useUIStore.getState().lightTheme).toBe('celadon')
    expect(document.documentElement.getAttribute('data-theme')).toBe('celadon')
    // The window that performed the write repaints through applyTheme; this one
    // only ever sees the storage event, so it needs the same repaint.
    expect(readThemeColor()).toBe(THEME_BACKGROUNDS.celadon)
    teardownTheme()
  })

  it('ignores storage events for unrelated keys', async () => {
    stubMatchMedia(false)

    const { initializeTheme, useUIStore, teardownTheme } = await import('./uiStore')
    initializeTheme()

    window.localStorage.setItem('cc-haha-theme', 'celadon')
    window.dispatchEvent(new StorageEvent('storage', { key: 'cc-haha-open-tabs' }))

    expect(useUIStore.getState().theme).toBe('white')
    teardownTheme()
  })
})

describe('uiStore settings tab persistence', () => {
  beforeEach(() => {
    vi.resetModules()
    window.localStorage.clear()
  })

  it('hydrates the last selected Settings tab after the renderer store is recreated', async () => {
    const first = await import('./uiStore')

    first.useUIStore.getState().setActiveSettingsTab('general')

    expect(window.localStorage.getItem('cc-haha-active-settings-tab')).toBe('general')

    vi.resetModules()
    const recreated = await import('./uiStore')

    expect(recreated.useUIStore.getState().activeSettingsTab).toBe('general')
  })

  it('persists the pets Settings tab', async () => {
    const first = await import('./uiStore')

    first.useUIStore.getState().setActiveSettingsTab('pets')

    expect(window.localStorage.getItem('cc-haha-active-settings-tab')).toBe('pets')

    vi.resetModules()
    const recreated = await import('./uiStore')

    expect(recreated.useUIStore.getState().activeSettingsTab).toBe('pets')
  })

  it('ignores an invalid persisted Settings tab', async () => {
    window.localStorage.setItem('cc-haha-active-settings-tab', 'not-a-settings-tab')

    const { useUIStore } = await import('./uiStore')

    expect(useUIStore.getState().activeSettingsTab).toBe('providers')
  })
})
