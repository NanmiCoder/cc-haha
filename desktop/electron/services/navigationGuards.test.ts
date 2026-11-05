import { describe, expect, it, vi } from 'vitest'
import {
  installMainWindowNavigationGuards,
  installPreviewNavigationGuards,
  isHttpUrl,
} from './navigationGuards'

const rendererUrl = 'file:///Applications/cc-haha/index.html'

function fakeWebContents() {
  let windowOpenHandler: ((details: { url: string }) => { action: 'deny' } | { action: 'allow' }) | null = null
  let willNavigateHandler: ((event: { preventDefault: () => void }, url: string) => void) | null = null
  let willRedirectHandler: ((event: { preventDefault: () => void }, url: string) => void) | null = null
  return {
    contents: {
      setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' } | { action: 'allow' }) {
        windowOpenHandler = handler
      },
      on(event: 'will-navigate' | 'will-redirect', handler: (event: { preventDefault: () => void }, url: string) => void) {
        if (event === 'will-navigate') willNavigateHandler = handler
        if (event === 'will-redirect') willRedirectHandler = handler
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
    redirect(url: string) {
      const event = { preventDefault: vi.fn() }
      willRedirectHandler?.(event, url)
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
    installMainWindowNavigationGuards(wc.contents, { openExternal, rendererUrl })

    expect(wc.openWindow('https://example.com')).toEqual({ action: 'deny' })
    expect(openExternal).toHaveBeenCalledWith('https://example.com')
  })

  it('denies non-http popups without opening anything', () => {
    const openExternal = vi.fn()
    const wc = fakeWebContents()
    installMainWindowNavigationGuards(wc.contents, { openExternal, rendererUrl })

    expect(wc.openWindow('file:///etc/passwd')).toEqual({ action: 'deny' })
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('blocks top-level navigation to remote documents', () => {
    const openExternal = vi.fn()
    const wc = fakeWebContents()
    installMainWindowNavigationGuards(wc.contents, { openExternal, rendererUrl })

    const preventDefault = wc.navigate('https://evil.example/page')

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(openExternal).toHaveBeenCalledWith('https://evil.example/page')
  })

  it('keeps local renderer navigations working', () => {
    const wc = fakeWebContents()
    installMainWindowNavigationGuards(wc.contents, { openExternal: vi.fn(), rendererUrl })

    expect(wc.hasWillNavigate()).toBe(true)
    expect(wc.navigate('file:///Applications/cc-haha/index.html')).not.toHaveBeenCalled()
    expect(wc.navigate(`${rendererUrl}?petWindow=1#/settings`)).not.toHaveBeenCalled()
  })

  it.each([
    'file:///C:/Users/example/untrusted.html',
    'file:///Applications/cc-haha/index.html.evil.html',
    'file:///Applications/cc-haha/other.html',
    'file://attacker/Applications/cc-haha/index.html',
    'http://localhost:5173/',
    'http://127.0.0.1:8080/evil.html',
    'data:text/html,<script>alert(1)</script>',
    'javascript:alert(1)',
  ])('blocks untrusted documents from inheriting preload: %s', url => {
    const wc = fakeWebContents()
    const openExternal = vi.fn()
    installMainWindowNavigationGuards(wc.contents, { openExternal, rendererUrl })
    expect(wc.navigate(url)).toHaveBeenCalledOnce()
    expect(wc.redirect(url)).toHaveBeenCalledOnce()
    if (!isHttpUrl(url)) expect(openExternal).not.toHaveBeenCalled()
  })

  it('pins development navigation to the configured entry, including its port and path', () => {
    const wc = fakeWebContents()
    installMainWindowNavigationGuards(wc.contents, {
      openExternal: vi.fn(), rendererUrl: 'http://localhost:5173/',
    })
    expect(wc.navigate('http://localhost:5173/?petWindow=1#/chat')).not.toHaveBeenCalled()
    expect(wc.redirect('http://localhost:5173/')).not.toHaveBeenCalled()
    for (const url of ['http://localhost:5174/', 'http://127.0.0.1:5173/', 'http://localhost:5173/evil.html', rendererUrl]) {
      expect(wc.navigate(url)).toHaveBeenCalledOnce()
      expect(wc.redirect(url)).toHaveBeenCalledOnce()
    }
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
