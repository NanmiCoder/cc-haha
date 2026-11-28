import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const html = readFileSync(join(__dirname, 'index.html'), 'utf-8')

describe('desktop index startup diagnostics', () => {
  it('installs a non-module startup watchdog before the app module loads', () => {
    const watchdogIndex = html.indexOf('__CC_HAHA_SHOW_STARTUP_ERROR__')
    const moduleIndex = html.indexOf('type="module"')

    expect(watchdogIndex).toBeGreaterThan(0)
    expect(moduleIndex).toBeGreaterThan(watchdogIndex)
    expect(html).toContain('__CC_HAHA_BOOTSTRAPPED__')
    expect(html).toContain('Desktop startup failed')
  })

  it('diagnoses module resource failures and boot timeouts outside React', () => {
    expect(html).toContain('Startup resource failed to load:')
    expect(html).toContain('Desktop app did not finish bootstrapping within')
  })

  it('keeps the script error visible after the startup deadline', () => {
    const document = new DOMParser().parseFromString(html, 'text/html')
    const watchdog = Array.from(document.scripts).find(script =>
      script.textContent?.includes('__CC_HAHA_SHOW_STARTUP_ERROR__'),
    )!
    vi.useFakeTimers()
    try {
      const window = Object.assign(new EventTarget(), {
        location: { href: 'file:///desktop/dist/index.html' },
        setTimeout,
        clearTimeout,
      })
      new Function('window', 'document', watchdog.textContent!)(window, document)
      window.dispatchEvent(new ErrorEvent('error', { message: 'TypeError: store initialization failed' }))
      expect(document.querySelector('pre')?.textContent).toContain('TypeError: store initialization failed')

      vi.advanceTimersByTime(8000)

      expect(document.querySelector('pre')?.textContent).toContain('TypeError: store initialization failed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets the renderer play local and inline audio/video without opening remote media hosts', () => {
    const csp = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1] ?? ''
    const directives = new Map(csp.split(';').map(part => part.trim()).filter(Boolean).map((part) => {
      const [name, ...sources] = part.split(/\s+/)
      return [name, sources] as const
    }))

    // Without media-src, <audio> / <video> fall back to default-src 'self' and are blocked
    // for blob: recordings, inline data: audio, and loopback sidecar media streams.
    expect(directives.get('media-src')).toEqual(["'self'", 'data:', 'blob:', 'http://127.0.0.1:*', 'http://localhost:*'])
    expect(directives.get('media-src')).not.toContain('https:')
    // Only media playback was opened up: the restrictive directives stay as they were.
    expect(directives.get('default-src')).toEqual(["'self'"])
    expect(directives.get('object-src')).toEqual(["'none'"])
    expect(directives.get('worker-src')).toEqual(["'self'", 'blob:'])
  })

  it('marks the floating usage widget window transparent before first paint', () => {
    const document = new DOMParser().parseFromString(html, 'text/html')
    const windowKindScript = Array.from(document.scripts).find(script =>
      script.textContent?.includes('usageWidgetWindow'),
    )
    expect(windowKindScript).toBeDefined()

    const mockWindow = { location: { search: '?usageWidgetWindow=1' } }
    new Function('window', 'document', windowKindScript!.textContent!)(mockWindow, document)
    expect(document.documentElement.dataset.windowKind).toBe('usage-widget')

    expect(html).toContain('html[data-window-kind="usage-widget"]')
    expect(html).toContain('html[data-window-kind="usage-widget"] #root { background: transparent !important; }')
  })

  it.each([
    {
      theme: 'dark',
      bg: 'rgb(24, 24, 24)',
      panelBg: 'rgb(33, 33, 33)',
      border: 'rgb(43, 43, 43)',
      text: 'rgb(223, 223, 223)',
      preBg: 'rgb(34, 34, 34)',
    },
    {
      theme: 'white',
      bg: 'rgb(255, 255, 255)',
      panelBg: 'rgb(255, 255, 255)',
      border: 'rgb(232, 232, 232)',
      text: 'rgb(26, 28, 31)',
      preBg: 'rgb(243, 243, 243)',
    },
  ])('renders pure-neutral $theme startup error colors matching the pre-paint theme', ({ theme, bg, panelBg, border, text, preBg }) => {
    const document = new DOMParser().parseFromString(html, 'text/html')
    document.documentElement.dataset.theme = theme
    const watchdog = Array.from(document.scripts).find(script =>
      script.textContent?.includes('__CC_HAHA_SHOW_STARTUP_ERROR__'),
    )!
    vi.useFakeTimers()
    try {
      const mockWindow = Object.assign(new EventTarget(), {
        location: { href: 'file:///desktop/dist/index.html' },
        setTimeout,
        clearTimeout,
      })
      new Function('window', 'document', watchdog.textContent!)(mockWindow, document)
      mockWindow.dispatchEvent(new ErrorEvent('error', { message: 'Boom' }))

      const shell = document.querySelector('main') as HTMLElement
      const panel = document.querySelector('section') as HTMLElement
      const pre = document.querySelector('pre') as HTMLElement
      expect(shell.style.backgroundColor).toBe(bg)
      expect(shell.style.color).toBe(text)
      expect(panel.style.backgroundColor).toBe(panelBg)
      expect(panel.style.borderColor).toBe(border)
      expect(pre.style.backgroundColor).toBe(preBg)
      expect(pre.style.color).toBe(text)
    } finally {
      vi.useRealTimers()
    }
  })
})
