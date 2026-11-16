import { describe, expect, it } from 'vitest'
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

  it('lets the renderer play blob: audio, for the voice settings recording playback', () => {
    const csp = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1] ?? ''
    const directives = new Map(csp.split(';').map(part => part.trim()).filter(Boolean).map((part) => {
      const [name, ...sources] = part.split(/\s+/)
      return [name, sources] as const
    }))

    // Without media-src, <audio src="blob:..."> falls back to default-src 'self' and is blocked.
    // Video wallpapers stream through the local cc-wallpaper: protocol.
    expect(directives.get('media-src')).toEqual(["'self'", 'blob:', 'cc-wallpaper:'])
    // Web-pack wallpapers render in a sandboxed cc-wallpaper: frame.
    expect(directives.get('frame-src')).toEqual(['cc-wallpaper:'])
    // Only media playback was opened up: the restrictive directives stay as they were.
    expect(directives.get('default-src')).toEqual(["'self'"])
    expect(directives.get('object-src')).toEqual(["'none'"])
    expect(directives.get('worker-src')).toEqual(["'self'", 'blob:'])
  })
})
