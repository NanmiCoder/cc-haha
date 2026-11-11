import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const html = readFileSync(join(__dirname, 'index.html'), 'utf-8')

function runWatchdog(url = 'https://computer.example/remote') {
  const marker = html.indexOf('window.__CC_HAHA_SHOW_STARTUP_ERROR__')
  const start = html.lastIndexOf('<script>', marker) + '<script>'.length
  const source = html.slice(start, html.indexOf('</script>', start))
  const events = new EventTarget()
  const location = Object.assign(new URL(url), { reload: vi.fn() })
  const host: {
    location: typeof location
    setTimeout: typeof window.setTimeout
    clearTimeout: typeof window.clearTimeout
    addEventListener: typeof events.addEventListener
    __CC_HAHA_BOOTSTRAPPED__?: boolean
    __CC_HAHA_SHOW_STARTUP_ERROR__?: (reason: unknown) => void
    __CC_HAHA_SET_STARTUP_PHASE__?: (phase: string) => void
    __CC_HAHA_BOOTSTRAP_COMPLETE__?: () => void
  } = {
    location,
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    addEventListener: events.addEventListener.bind(events),
  }
  document.body.innerHTML = '<div id="root"></div>'
  // eslint-disable-next-line no-new-func -- exercise the actual pre-module script
  new Function('window', 'document', 'navigator', source)(host, document, { userAgent: 'Test WebView', language: 'en' })
  return { host, events }
}

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

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

  it('keeps a slow remote download in a visible loading state after the desktop deadline', () => {
    vi.useFakeTimers()
    runWatchdog()

    expect(document.body.textContent).toContain('Connecting to your computer')
    vi.advanceTimersByTime(8000)
    expect(document.body.textContent).toContain('Still connecting')
    expect(document.body.textContent).not.toContain('startup failed')
    expect(document.querySelector('[role="status"]')).not.toBeNull()
  })

  it('bounds remote waiting and offers one reload per click without changing the pairing URL', () => {
    vi.useFakeTimers()
    const { host } = runWatchdog('https://computer.example/remote#pair=fixture-pair-secret')
    vi.advanceTimersByTime(60000)

    expect(document.body.textContent).toContain('Connection timed out')
    const retry = document.querySelector('button')!
    expect(retry.textContent).toBe('Try again')
    retry.click()
    retry.click()
    expect(host.location.reload).toHaveBeenCalledTimes(1)
    expect(host.location.hash).toBe('#pair=fixture-pair-secret')
    expect(document.body.textContent).not.toContain('fixture-pair-secret')
  })

  it('reports loading phases and lets a slow successful bootstrap finish without later DOM replacement', () => {
    vi.useFakeTimers()
    const { host } = runWatchdog()
    vi.advanceTimersByTime(9000)
    host.__CC_HAHA_SET_STARTUP_PHASE__?.('modules')
    expect(document.body.textContent).toContain('Loading the app')
    host.__CC_HAHA_BOOTSTRAP_COMPLETE__?.()
    document.getElementById('root')!.textContent = 'Paired app'
    vi.advanceTimersByTime(60000)

    expect(host.__CC_HAHA_BOOTSTRAPPED__).toBe(true)
    expect(document.body.textContent).toBe('Paired app')
  })

  it('keeps the desktop eight-second watchdog and diagnostic phase', () => {
    vi.useFakeTimers()
    const { host } = runWatchdog('http://localhost:1420/')
    host.__CC_HAHA_SET_STARTUP_PHASE__?.('modules')
    vi.advanceTimersByTime(8000)

    expect(document.body.textContent).toContain('Desktop startup failed')
    expect(document.body.textContent).toContain('8000ms')
    expect(document.body.textContent).toContain('Phase: modules')
  })

  it('reports resource failures immediately and does not replace them with slow-loading feedback', () => {
    vi.useFakeTimers()
    const { host } = runWatchdog()
    host.__CC_HAHA_SHOW_STARTUP_ERROR__?.('Startup resource failed to load: https://computer.example/assets/app.js?token=resource-secret#pair=fragment-secret')

    expect(document.body.textContent).toContain('Could not load the app')
    expect(document.body.textContent).toContain('/assets/app.js')
    vi.advanceTimersByTime(8000)
    expect(document.body.textContent).not.toContain('Still connecting')
    expect(document.body.textContent).not.toContain('resource-secret')
    expect(document.body.textContent).not.toContain('fragment-secret')
  })

  it('redacts credentials, all query values and fragments from diagnostic URLs and error summaries', () => {
    vi.useFakeTimers()
    const { host } = runWatchdog('https://computer.example/remote?token=query-secret&pair=query-pair#pair=fragment-secret')
    host.__CC_HAHA_SHOW_STARTUP_ERROR__?.('Failed loading https://user:password@computer.example/assets/app.js?token=other-token&key=other-key#pair=other-pair at /remote?pair=relative-pair#token=relative-token')

    expect(document.body.textContent).toContain('URL: https://computer.example/remote')
    for (const secret of ['query-secret', 'query-pair', 'fragment-secret', 'password', 'other-token', 'other-key', 'other-pair', 'relative-pair', 'relative-token']) {
      expect(document.body.textContent).not.toContain(secret)
    }
  })

  it('lets the renderer play blob: audio, for the voice settings recording playback', () => {
    const csp = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1] ?? ''
    const directives = new Map(csp.split(';').map(part => part.trim()).filter(Boolean).map((part) => {
      const [name, ...sources] = part.split(/\s+/)
      return [name, sources] as const
    }))

    // Without media-src, <audio src="blob:..."> falls back to default-src 'self' and is blocked.
    expect(directives.get('media-src')).toEqual(["'self'", 'blob:'])
    // Only media playback was opened up: the restrictive directives stay as they were.
    expect(directives.get('default-src')).toEqual(["'self'"])
    expect(directives.get('object-src')).toEqual(["'none'"])
    expect(directives.get('worker-src')).toEqual(["'self'", 'blob:'])
  })
})
