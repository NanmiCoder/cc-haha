import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  initializeLocale,
  readStoredLocale,
  resolveSupportedLocale,
  subscribeLocaleChanges,
} from './locale'

function mockBrowserLanguages(languages: string[], language = languages[0] ?? '') {
  vi.spyOn(window.navigator, 'languages', 'get').mockReturnValue(languages)
  vi.spyOn(window.navigator, 'language', 'get').mockReturnValue(language)
}

function host(overrides: Partial<Parameters<typeof initializeLocale>[0]> = {}) {
  return {
    getLocalePreference: vi.fn().mockResolvedValue(null),
    getPreferredSystemLanguages: vi.fn().mockResolvedValue(['en-US']),
    setLocalePreference: vi.fn().mockResolvedValue(undefined),
    onLocaleChanged: vi.fn().mockResolvedValue(() => {}),
    ...overrides,
  }
}

describe('locale detection', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    window.localStorage.clear()
    document.documentElement.lang = 'fr'
  })

  it('resolves every language tag to English', () => {
    expect(resolveSupportedLocale(['fr-FR', 'zh_Hant_HK', 'en-US'])).toBe('en')
    expect(resolveSupportedLocale(['ja-JP'])).toBe('en')
    expect(resolveSupportedLocale([])).toBe('en')
  })

  it('uses English whatever the system languages are', async () => {
    mockBrowserLanguages(['ja-JP'])

    await expect(initializeLocale(host({
      getPreferredSystemLanguages: vi.fn().mockResolvedValue(['fr-FR', 'ko-KR']),
    }))).resolves.toBe('en')

    expect(document.documentElement.lang).toBe('en')
  })

  it('falls back to English when the native lookup fails', async () => {
    await expect(initializeLocale(host({
      getLocalePreference: () => Promise.reject(new Error('IPC unavailable')),
      getPreferredSystemLanguages: () => Promise.reject(new Error('IPC unavailable')),
    }))).resolves.toBe('en')
  })

  it('ignores a locale stored by an older build', async () => {
    window.localStorage.setItem('cc-haha-locale', 'zh-TW')
    expect(readStoredLocale()).toBeNull()

    const runtime = host({ getLocalePreference: vi.fn().mockResolvedValue('jp') })
    await expect(initializeLocale(runtime)).resolves.toBe('en')

    expect(runtime.setLocalePreference).not.toHaveBeenCalled()
    expect(document.documentElement.lang).toBe('en')
  })

  it('migrates a stored English choice to the app-level preference', async () => {
    window.localStorage.setItem('cc-haha-locale', 'en')
    const runtime = host()

    await expect(initializeLocale(runtime)).resolves.toBe('en')

    expect(runtime.setLocalePreference).toHaveBeenCalledWith('en')
    expect(runtime.getPreferredSystemLanguages).not.toHaveBeenCalled()
  })

  it('applies app-level locale changes to an already running companion window', async () => {
    let onLocaleChanged: ((locale: 'en') => void) | undefined
    const listener = vi.fn()
    const unsubscribe = subscribeLocaleChanges(listener)

    await initializeLocale(host({
      onLocaleChanged: vi.fn(async (handler) => {
        onLocaleChanged = handler
        return () => {}
      }),
    }))

    onLocaleChanged?.('en')

    expect(listener).toHaveBeenLastCalledWith('en')
    unsubscribe()
  })
})
