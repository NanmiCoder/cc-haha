import { describe, expect, it, vi } from 'vitest'
import {
  installMainWindowNavigationGuards,
  installPreviewNavigationGuards,
  isHttpUrl,
} from './navigationGuards'

function fakeWebContents() {
  let windowOpenHandler: ((details: { url: string }) => { action: 'deny' } | { action: 'allow' }) | null = null
  let willNavigateHandler: ((event: { preventDefault: () => void }, url: string) => void) | null = null
  return {
    contents: {
      setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' } | { action: 'allow' }) {
        windowOpenHandler = handler
      },
      on(event: 'will-navigate', handler: (event: { preventDefault: () => void }, url: string) => void) {
        if (event === 'will-navigate') willNavigateHandler = handler
        return this
      },
    },
    openWindow(url: string) {
      if (!windowOpenHandler) throw new Error('window open handler not installed')
      return windowOpenHandler({ url })
    },
    navigate(url: string) {
      const event = { preventDefault: vi.fn() }
      willNavigateHandler?.(event, url)
      return event.preventDefault
    },
    hasWillNavigate() {
      return willNavigateHandler !== null
    },
  }
}

describe('isHttpUrl', () => {
  it('accepts only http(s) URLs', () => {
    expect(isHttpUrl('https://example.com')).toBe(true)
    expect(isHttpUrl('http://127.0.0.1:8080')).toBe(true)
    expect(isHttpUrl('file:///etc/passwd')).toBe(false)
    expect(isHttpUrl('javascript:alert(1)')).toBe(false)
    expect(isHttpUrl('not a url')).toBe(false)
  })
})

describe('installMainWindowNavigationGuards', () => {
  it('denies popups and routes http(s) ones to the system browser', () => {
    const openExternal = vi.fn()
    const wc = fakeWebContents()
    installMainWindowNavigationGuards(wc.contents, { openExternal })

    expect(wc.openWindow('https://example.com')).toEqual({ action: 'deny' })
    expect(openExternal).toHaveBeenCalledWith('https://example.com')
  })

  it('denies non-http popups without opening anything', () => {
    const openExternal = vi.fn()
    const wc = fakeWebContents()
    installMainWindowNavigationGuards(wc.contents, { openExternal })

    expect(wc.openWindow('file:///etc/passwd')).toEqual({ action: 'deny' })
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('does not install a will-navigate guard so dev reloads keep working', () => {
    const wc = fakeWebContents()
    installMainWindowNavigationGuards(wc.contents, { openExternal: vi.fn() })
    expect(wc.hasWillNavigate()).toBe(false)
  })
})

describe('installPreviewNavigationGuards', () => {
  it('allows in-page http(s) navigation so the preview keeps working as a browser', () => {
    const wc = fakeWebContents()
    installPreviewNavigationGuards(wc.contents, { openExternal: vi.fn() })

    const preventDefault = wc.navigate('https://example.com/page')
    expect(preventDefault).not.toHaveBeenCalled()
  })

  it('blocks navigation to non-http(s) schemes', () => {
    const wc = fakeWebContents()
    installPreviewNavigationGuards(wc.contents, { openExternal: vi.fn() })

    const preventDefault = wc.navigate('file:///etc/passwd')
    expect(preventDefault).toHaveBeenCalledTimes(1)
  })

  it('denies popups and routes http(s) ones to the system browser', () => {
    const openExternal = vi.fn()
    const wc = fakeWebContents()
    installPreviewNavigationGuards(wc.contents, { openExternal })

    expect(wc.openWindow('https://example.com')).toEqual({ action: 'deny' })
    expect(openExternal).toHaveBeenCalledWith('https://example.com')
  })
})
