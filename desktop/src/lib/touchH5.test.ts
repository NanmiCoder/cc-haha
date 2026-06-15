import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  TOUCH_H5_ATTRIBUTE,
  TOUCH_H5_KEYBOARD_ATTRIBUTE,
  TOUCH_H5_VIEWPORT_HEIGHT_VAR,
  detectTouchH5Environment,
  initializeTouchH5,
  isIOSEnvironment,
  isTouchH5Document,
  isTouchH5Environment,
  type TouchH5Environment,
} from './touchH5'

function makeEnv(overrides: Partial<TouchH5Environment> = {}): TouchH5Environment {
  return {
    hasDesktopHost: false,
    coarsePointer: false,
    maxTouchPoints: 0,
    userAgent: 'Mozilla/5.0',
    platform: 'MacIntel',
    ...overrides,
  }
}

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0'
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36'

type MockWindowEnvOptions = {
  desktopHost?: boolean
  coarsePointer?: boolean
  maxTouchPoints?: number
  userAgent?: string
  platform?: string
}

const originalDescriptors: Array<{ target: object; key: string; descriptor: PropertyDescriptor | undefined }> = []

function defineMocked(target: object, key: string, value: unknown) {
  originalDescriptors.push({ target, key, descriptor: Object.getOwnPropertyDescriptor(target, key) })
  Object.defineProperty(target, key, { value, configurable: true, writable: true })
}

function mockWindowEnv({
  desktopHost = false,
  coarsePointer = false,
  maxTouchPoints = 0,
  userAgent = 'Mozilla/5.0',
  platform = 'MacIntel',
}: MockWindowEnvOptions) {
  if (desktopHost) {
    defineMocked(window, 'desktopHost', { isDesktop: true })
  }
  defineMocked(window, 'matchMedia', (query: string) => ({
    matches: query === '(pointer: coarse)' ? coarsePointer : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
  defineMocked(navigator, 'maxTouchPoints', maxTouchPoints)
  defineMocked(navigator, 'userAgent', userAgent)
  defineMocked(navigator, 'platform', platform)
}

function getViewportMeta() {
  return document.querySelector('meta[name="viewport"]')
}

beforeEach(() => {
  defineMocked(window, 'requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 0
  })
  defineMocked(window, 'scrollTo', vi.fn())
})

afterEach(() => {
  while (originalDescriptors.length > 0) {
    const { target, key, descriptor } = originalDescriptors.pop()!
    if (descriptor) {
      Object.defineProperty(target, key, descriptor)
    } else {
      delete (target as Record<string, unknown>)[key]
    }
  }
  document.documentElement.removeAttribute(TOUCH_H5_ATTRIBUTE)
  getViewportMeta()?.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('isTouchH5Environment', () => {
  it('rejects the Electron desktop shell even on touch hardware', () => {
    expect(isTouchH5Environment(makeEnv({ hasDesktopHost: true, coarsePointer: true, maxTouchPoints: 5 }))).toBe(false)
  })

  it('rejects desktop browsers with a fine pointer and no touch points', () => {
    expect(isTouchH5Environment(makeEnv())).toBe(false)
  })

  it('accepts coarse-pointer browsers', () => {
    expect(isTouchH5Environment(makeEnv({ coarsePointer: true }))).toBe(true)
  })

  it('accepts touch devices even when matchMedia is unavailable', () => {
    expect(isTouchH5Environment(makeEnv({ coarsePointer: false, maxTouchPoints: 5 }))).toBe(true)
  })
})

describe('isIOSEnvironment', () => {
  it('matches iPhone user agents', () => {
    expect(isIOSEnvironment(makeEnv({ userAgent: IPHONE_UA }))).toBe(true)
  })

  it('matches iPadOS 13+ masquerading as macOS', () => {
    expect(isIOSEnvironment(makeEnv({ platform: 'MacIntel', maxTouchPoints: 5 }))).toBe(true)
  })

  it('rejects real macOS and Android', () => {
    expect(isIOSEnvironment(makeEnv({ platform: 'MacIntel', maxTouchPoints: 0 }))).toBe(false)
    expect(isIOSEnvironment(makeEnv({ userAgent: ANDROID_UA, platform: 'Linux armv81' }))).toBe(false)
  })
})

describe('detectTouchH5Environment', () => {
  it('reads desktop host, pointer, and navigator facts from the window', () => {
    mockWindowEnv({ desktopHost: true, coarsePointer: true, maxTouchPoints: 5, userAgent: IPHONE_UA, platform: 'iPhone' })

    expect(detectTouchH5Environment(window)).toEqual({
      hasDesktopHost: true,
      coarsePointer: true,
      maxTouchPoints: 5,
      userAgent: IPHONE_UA,
      platform: 'iPhone',
    })
  })

  it('treats a throwing matchMedia as a fine pointer', () => {
    defineMocked(window, 'matchMedia', () => {
      throw new Error('not implemented')
    })

    expect(detectTouchH5Environment(window).coarsePointer).toBe(false)
  })
})

describe('initializeTouchH5', () => {
  it('does nothing in the Electron desktop shell', () => {
    mockWindowEnv({ desktopHost: true, coarsePointer: true, maxTouchPoints: 5 })

    expect(initializeTouchH5(window)).toBe(false)
    expect(document.documentElement.hasAttribute(TOUCH_H5_ATTRIBUTE)).toBe(false)
  })

  it('does nothing in desktop browsers', () => {
    mockWindowEnv({})

    expect(initializeTouchH5(window)).toBe(false)
    expect(document.documentElement.hasAttribute(TOUCH_H5_ATTRIBUTE)).toBe(false)
    expect(getViewportMeta()).toBeNull()
  })

  it('marks the document on Android touch browsers without touching the viewport', () => {
    // Stub window: keeps the shared jsdom window out of the module-level
    // listener guard, so the iOS cases below install against a fresh slate.
    const { win, doc } = createStubWindow({ userAgent: ANDROID_UA, platform: 'Linux armv81' })

    expect(initializeTouchH5(win)).toBe(true)
    expect(doc.documentElement.getAttribute(TOUCH_H5_ATTRIBUTE)).toBe('true')
    expect(doc.querySelector('meta[name="viewport"]')).toBeNull()
  })

  it('marks the document and rewrites an existing viewport meta on iOS', () => {
    const meta = document.createElement('meta')
    meta.setAttribute('name', 'viewport')
    meta.setAttribute('content', 'width=device-width, initial-scale=1.0')
    document.head.appendChild(meta)
    mockWindowEnv({ coarsePointer: true, maxTouchPoints: 5, userAgent: IPHONE_UA, platform: 'iPhone' })

    expect(initializeTouchH5(window)).toBe(true)
    expect(document.documentElement.getAttribute(TOUCH_H5_ATTRIBUTE)).toBe('true')
    const content = getViewportMeta()?.getAttribute('content') ?? ''
    expect(content).toContain('maximum-scale=1.0')
    expect(content).toContain('user-scalable=no')
    expect(content).toContain('width=device-width')
  })

  it('creates the viewport meta on iOS when none exists and stays single across re-runs', () => {
    mockWindowEnv({ coarsePointer: true, maxTouchPoints: 5, userAgent: IPHONE_UA, platform: 'iPhone' })

    expect(initializeTouchH5(window)).toBe(true)
    expect(initializeTouchH5(window)).toBe(true)

    const metas = document.querySelectorAll('meta[name="viewport"]')
    expect(metas.length).toBe(1)
    expect(metas[0]?.getAttribute('content')).toContain('maximum-scale=1.0')
  })

  it('snaps the page back to the top when the iOS keyboard collapses', () => {
    mockWindowEnv({ coarsePointer: true, maxTouchPoints: 5, userAgent: IPHONE_UA, platform: 'iPhone' })
    initializeTouchH5(window)
    initializeTouchH5(window)

    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)
    defineMocked(window, 'scrollY', 40)

    const scrollTo = vi.mocked(window.scrollTo)
    scrollTo.mockClear()
    textarea.dispatchEvent(new Event('focusout', { bubbles: true }))

    // Installed once despite repeated initialization.
    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect(scrollTo).toHaveBeenCalledWith(0, 0)
  })

  it('leaves the scroll position alone when focus moves to another input', () => {
    mockWindowEnv({ coarsePointer: true, maxTouchPoints: 5, userAgent: IPHONE_UA, platform: 'iPhone' })
    initializeTouchH5(window)

    const first = document.createElement('textarea')
    const second = document.createElement('input')
    document.body.append(first, second)
    defineMocked(window, 'scrollY', 40)
    second.focus()

    const scrollTo = vi.mocked(window.scrollTo)
    scrollTo.mockClear()
    first.dispatchEvent(new Event('focusout', { bubbles: true }))

    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('does not scroll when the page is already at the top', () => {
    mockWindowEnv({ coarsePointer: true, maxTouchPoints: 5, userAgent: IPHONE_UA, platform: 'iPhone' })
    initializeTouchH5(window)

    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)

    const scrollTo = vi.mocked(window.scrollTo)
    scrollTo.mockClear()
    textarea.dispatchEvent(new Event('focusout', { bubbles: true }))

    expect(scrollTo).not.toHaveBeenCalled()
  })
})

class FakeVisualViewport extends EventTarget {
  height: number

  constructor(height: number) {
    super()
    this.height = height
  }
}

type StubWindowOptions = {
  desktopHost?: boolean
  userAgent?: string
  platform?: string
  innerHeight?: number
  visualViewportHeight?: number | null
}

/**
 * A fresh window-like object per test: keeps the module-level WeakSet
 * (listener install guard) from leaking state between cases, unlike the
 * shared jsdom window.
 */
function createStubWindow({
  desktopHost = false,
  userAgent = IPHONE_UA,
  platform = 'iPhone',
  innerHeight = 900,
  visualViewportHeight = 900,
}: StubWindowOptions = {}) {
  const doc = document.implementation.createHTMLDocument()
  const visualViewport =
    visualViewportHeight === null ? null : new FakeVisualViewport(visualViewportHeight)
  const win = {
    document: doc,
    navigator: { maxTouchPoints: 5, userAgent, platform },
    matchMedia: (query: string) => ({ matches: query === '(pointer: coarse)' }),
    visualViewport,
    innerHeight,
    scrollX: 0,
    scrollY: 0,
    scrollTo: vi.fn(),
    addEventListener: vi.fn(),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0)
      return 0
    },
    HTMLElement: window.HTMLElement,
    desktopHost: desktopHost ? { isDesktop: true } : undefined,
  }
  return { win: win as unknown as Window & typeof globalThis, doc, visualViewport }
}

describe('isTouchH5Document', () => {
  it('reflects the marker set by initializeTouchH5', () => {
    const { win, doc } = createStubWindow()

    expect(isTouchH5Document(doc)).toBe(false)
    initializeTouchH5(win)
    expect(isTouchH5Document(doc)).toBe(true)
  })

  it('is false for unmarked documents and missing documents', () => {
    expect(isTouchH5Document(document)).toBe(false)
    expect(isTouchH5Document(undefined)).toBe(false)
  })
})

describe('visual viewport fit', () => {
  it('locks the iOS viewport with viewport-fit=cover for safe-area insets', () => {
    const { win, doc } = createStubWindow()

    initializeTouchH5(win)

    expect(doc.querySelector('meta[name="viewport"]')?.getAttribute('content')).toContain(
      'viewport-fit=cover',
    )
  })

  it('publishes the visual viewport height as a CSS variable on init', () => {
    const { win, doc } = createStubWindow({ innerHeight: 812, visualViewportHeight: 812 })

    initializeTouchH5(win)

    expect(doc.documentElement.style.getPropertyValue(TOUCH_H5_VIEWPORT_HEIGHT_VAR)).toBe('812px')
    expect(doc.documentElement.hasAttribute(TOUCH_H5_KEYBOARD_ATTRIBUTE)).toBe(false)
  })

  it('marks the keyboard open and tracks the shrunken height on resize', () => {
    const { win, doc, visualViewport } = createStubWindow({ innerHeight: 900, visualViewportHeight: 900 })
    initializeTouchH5(win)

    visualViewport!.height = 520
    visualViewport!.dispatchEvent(new Event('resize'))

    expect(doc.documentElement.style.getPropertyValue(TOUCH_H5_VIEWPORT_HEIGHT_VAR)).toBe('520px')
    expect(doc.documentElement.hasAttribute(TOUCH_H5_KEYBOARD_ATTRIBUTE)).toBe(true)
  })

  it('snaps the WebKit keyboard pan back to the origin while the keyboard is open', () => {
    const { win, visualViewport } = createStubWindow({ innerHeight: 900, visualViewportHeight: 900 })
    initializeTouchH5(win)

    ;(win as { scrollY: number }).scrollY = 140
    visualViewport!.height = 520
    visualViewport!.dispatchEvent(new Event('resize'))

    expect(win.scrollTo).toHaveBeenCalledWith(0, 0)
  })

  it('clears the keyboard marker when the keyboard collapses', () => {
    const { win, doc, visualViewport } = createStubWindow({ innerHeight: 900, visualViewportHeight: 900 })
    initializeTouchH5(win)

    visualViewport!.height = 520
    visualViewport!.dispatchEvent(new Event('resize'))
    visualViewport!.height = 900
    visualViewport!.dispatchEvent(new Event('resize'))

    expect(doc.documentElement.hasAttribute(TOUCH_H5_KEYBOARD_ATTRIBUTE)).toBe(false)
    expect(doc.documentElement.style.getPropertyValue(TOUCH_H5_VIEWPORT_HEIGHT_VAR)).toBe('900px')
  })

  it('installs the viewport listeners only once across re-initialization', () => {
    const { win, visualViewport } = createStubWindow()
    const addListener = vi.spyOn(visualViewport!, 'addEventListener')

    initializeTouchH5(win)
    const installedCount = addListener.mock.calls.length
    initializeTouchH5(win)

    expect(installedCount).toBeGreaterThan(0)
    expect(addListener.mock.calls.length).toBe(installedCount)
  })

  it('tolerates browsers without visualViewport', () => {
    const { win, doc } = createStubWindow({ visualViewportHeight: null })

    expect(initializeTouchH5(win)).toBe(true)
    expect(doc.documentElement.style.getPropertyValue(TOUCH_H5_VIEWPORT_HEIGHT_VAR)).toBe('')
  })
})

describe('touch-H5 stylesheet contract', () => {
  const css = readFileSync(join(__dirname, '../theme/globals.css'), 'utf-8')

  it('scopes phone-only rules under the touch-h5 attribute', () => {
    expect(css).toContain('html[data-touch-h5]')
  })

  it('raises form-control font size to the iOS no-zoom threshold', () => {
    expect(css).toMatch(/html\[data-touch-h5\] input,\s*\nhtml\[data-touch-h5\] textarea,\s*\nhtml\[data-touch-h5\] select \{\s*\n\s*font-size: 16px;/)
  })

  it('disables content-visibility paint skipping for selectable transcript rows', () => {
    expect(css).toMatch(/html\[data-touch-h5\] \.chat-render-item--cv,\s*\nhtml\[data-touch-h5\] \.trace-row-cv,/)
  })

  it('keeps the fixed shell from rubber-banding', () => {
    expect(css).toMatch(/html\[data-touch-h5\] body \{\s*\n\s*overscroll-behavior-y: none;/)
  })

  it('sizes the app shell to the visual viewport with a dvh fallback', () => {
    expect(css).toMatch(/html\[data-touch-h5\] \.app-shell-viewport \{[^}]*height: var\(--touch-h5-viewport-height, 100dvh\);/)
  })

  it('pads the shell for safe areas and drops the bottom inset under the keyboard', () => {
    expect(css).toMatch(/html\[data-touch-h5\] \.app-shell-viewport \{[^}]*padding-bottom: env\(safe-area-inset-bottom, 0px\);/)
    expect(css).toMatch(/html\[data-touch-h5\]\[data-touch-h5-keyboard\] \.app-shell-viewport \{\s*\n\s*padding-bottom: 0px;/)
  })

  it('keeps message action bars always visible on touch', () => {
    expect(css).toMatch(/html\[data-touch-h5\] \[data-message-actions\] \{\s*\n\s*opacity: 1;\s*\n\s*pointer-events: auto;/)
  })

  it('disables paint skipping for the trace-window rows too', () => {
    expect(css).toMatch(/\.trace-message-cv \{\s*\n\s*content-visibility: auto;\s*\n\s*contain-intrinsic-size: auto 120px;/)
    expect(css).toMatch(/\.trace-list-row-cv \{\s*\n\s*content-visibility: auto;\s*\n\s*contain-intrinsic-size: auto 56px;/)
    expect(css).toMatch(/html\[data-touch-h5\] \.trace-message-cv,\s*\nhtml\[data-touch-h5\] \.trace-list-row-cv \{\s*\n\s*content-visibility: visible;/)
  })
})
