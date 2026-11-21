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
})
