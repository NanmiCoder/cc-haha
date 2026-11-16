import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DARK_SCHEME_QUERY,
  getSystemAppearance,
  readStoredDarkTheme,
  readStoredFollowSystemTheme,
  readStoredLightTheme,
  readStoredTheme,
  resolveAppliedTheme,
  subscribeSystemAppearance,
} from './systemAppearance'

type Listener = (event: { matches: boolean }) => void

/** Install a matchMedia jsdom does not ship, in either of its two API shapes. */
function stubMatchMedia(matches: boolean, api: 'modern' | 'legacy' = 'modern') {
  const listeners = new Set<Listener>()
  const query = api === 'modern'
    ? {
        matches,
        media: DARK_SCHEME_QUERY,
        addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
        removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
      }
    : {
        matches,
        media: DARK_SCHEME_QUERY,
        addListener: (listener: Listener) => listeners.add(listener),
        removeListener: (listener: Listener) => listeners.delete(listener),
      }

  const matchMedia = vi.fn(() => query as unknown as MediaQueryList)
  Object.defineProperty(window, 'matchMedia', { value: matchMedia, configurable: true, writable: true })

  return {
    matchMedia,
    emit: (nextMatches: boolean) => {
      for (const listener of listeners) listener({ matches: nextMatches })
    },
    listenerCount: () => listeners.size,
  }
}

function clearMatchMedia() {
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'matchMedia')
}

afterEach(() => {
  clearMatchMedia()
  window.localStorage.clear()
})

describe('resolveAppliedTheme', () => {
  it('returns the manual pick untouched when not following the system', () => {
    for (const systemAppearance of ['dark', 'light'] as const) {
      expect(resolveAppliedTheme({
        followSystem: false,
        theme: 'warm-classic',
        lightTheme: 'white',
        darkTheme: 'dark',
        systemAppearance,
      })).toBe('warm-classic')
    }
  })

  it('resolves each ground to the palette chosen for it', () => {
    // Two palettes sit on each ground, so a dark OS does not simply mean the
    // one literally named `dark`.
    expect(resolveAppliedTheme({
      followSystem: true,
      theme: 'white',
      lightTheme: 'celadon',
      darkTheme: 'ink-blue',
      systemAppearance: 'dark',
    })).toBe('ink-blue')

    expect(resolveAppliedTheme({
      followSystem: true,
      theme: 'white',
      lightTheme: 'celadon',
      darkTheme: 'ink-blue',
      systemAppearance: 'light',
    })).toBe('celadon')
  })

  it('resolves a ground to its preference, not to the last applied palette', () => {
    // Evening: the app is on ink-blue. Morning: it must return to warm
    // classic rather than to the palette it happens to be sitting on.
    expect(resolveAppliedTheme({
      followSystem: true,
      theme: 'ink-blue',
      lightTheme: 'warm-classic',
      darkTheme: 'ink-blue',
      systemAppearance: 'light',
    })).toBe('warm-classic')
  })
})

describe('getSystemAppearance', () => {
  it('reports dark when the OS prefers dark', () => {
    stubMatchMedia(true)
    expect(getSystemAppearance()).toBe('dark')
  })

  it('reports light when the OS prefers light', () => {
    stubMatchMedia(false)
    expect(getSystemAppearance()).toBe('light')
  })

  it('falls back to light where matchMedia is unavailable', () => {
    clearMatchMedia()
    expect(getSystemAppearance()).toBe('light')
  })

  it('falls back to light when the query itself throws', () => {
    Object.defineProperty(window, 'matchMedia', {
      value: () => { throw new Error('unsupported query') },
      configurable: true,
      writable: true,
    })
    expect(getSystemAppearance()).toBe('light')
  })
})

describe('subscribeSystemAppearance', () => {
  it('reports OS flips and detaches on unsubscribe', () => {
    const media = stubMatchMedia(false)
    const onChange = vi.fn()

    const unsubscribe = subscribeSystemAppearance(onChange)
    media.emit(true)
    expect(onChange).toHaveBeenCalledWith('dark')

    media.emit(false)
    expect(onChange).toHaveBeenLastCalledWith('light')

    unsubscribe()
    expect(media.listenerCount()).toBe(0)
  })

  it('supports the deprecated addListener pair used by older WebKit', () => {
    const media = stubMatchMedia(false, 'legacy')
    const onChange = vi.fn()

    const unsubscribe = subscribeSystemAppearance(onChange)
    media.emit(true)
    expect(onChange).toHaveBeenCalledWith('dark')

    unsubscribe()
    expect(media.listenerCount()).toBe(0)
  })

  it('returns a usable unsubscribe where matchMedia is unavailable', () => {
    clearMatchMedia()
    expect(() => subscribeSystemAppearance(vi.fn())()).not.toThrow()
  })
})

describe('stored appearance preferences', () => {
  it('follows the system on a fresh install', () => {
    expect(readStoredFollowSystemTheme(window.localStorage)).toBe(true)
  })

  it('leaves an existing install on its fixed theme until it opts in', () => {
    // Upgrading must never silently repaint someone's app.
    window.localStorage.setItem('cc-haha-theme', 'warm-classic')
    expect(readStoredFollowSystemTheme(window.localStorage)).toBe(false)
  })

  it('honours an explicit opt-in and opt-out', () => {
    window.localStorage.setItem('cc-haha-theme', 'warm-classic')
    window.localStorage.setItem('cc-haha-follow-system-theme', '1')
    expect(readStoredFollowSystemTheme(window.localStorage)).toBe(true)

    window.localStorage.setItem('cc-haha-follow-system-theme', '0')
    expect(readStoredFollowSystemTheme(window.localStorage)).toBe(false)
  })

  it('seeds each ground from a manual theme sitting on it', () => {
    window.localStorage.setItem('cc-haha-theme', 'celadon')
    expect(readStoredLightTheme(window.localStorage)).toBe('celadon')

    window.localStorage.setItem('cc-haha-theme', 'ink-blue')
    expect(readStoredDarkTheme(window.localStorage)).toBe('ink-blue')
  })

  it('falls back to the defaults when the manual theme is on the other ground', () => {
    window.localStorage.setItem('cc-haha-theme', 'ink-blue')
    expect(readStoredLightTheme(window.localStorage)).toBe('white')

    window.localStorage.setItem('cc-haha-theme', 'celadon')
    expect(readStoredDarkTheme(window.localStorage)).toBe('dark')
  })

  it('rejects stored values outside their own ground', () => {
    window.localStorage.setItem('cc-haha-theme', 'solarized')
    window.localStorage.setItem('cc-haha-light-theme', 'ink-blue')
    window.localStorage.setItem('cc-haha-dark-theme', 'celadon')

    expect(readStoredTheme(window.localStorage)).toBe('white')
    expect(readStoredLightTheme(window.localStorage)).toBe('white')
    expect(readStoredDarkTheme(window.localStorage)).toBe('dark')
  })

  it('survives storage that throws instead of returning a value', () => {
    const storage = {
      getItem: () => { throw new Error('storage disabled') },
      setItem: () => {},
    }

    expect(readStoredTheme(storage)).toBe('white')
    expect(readStoredLightTheme(storage)).toBe('white')
    expect(readStoredDarkTheme(storage)).toBe('dark')
    expect(readStoredFollowSystemTheme(storage)).toBe(true)
  })

  it('accepts neutral dark as a manual choice and a dark preference only', () => {
    window.localStorage.setItem('cc-haha-theme', 'neutral-dark')
    window.localStorage.setItem('cc-haha-light-theme', 'neutral-dark')
    window.localStorage.setItem('cc-haha-dark-theme', 'neutral-dark')
    expect(readStoredTheme(window.localStorage)).toBe('neutral-dark')
    expect(readStoredLightTheme(window.localStorage)).toBe('white')
    expect(readStoredDarkTheme(window.localStorage)).toBe('neutral-dark')
    expect(readStoredFollowSystemTheme(window.localStorage)).toBe(false)
  })
})
