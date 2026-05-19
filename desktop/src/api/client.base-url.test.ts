import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

describe('api client default base URL', () => {
  const originalWindow = globalThis.window

  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllEnvs()
  })

  afterEach(() => {
    if (originalWindow) (globalThis as { window?: unknown }).window = originalWindow
    else delete (globalThis as { window?: unknown }).window
    vi.unstubAllEnvs()
  })

  it('uses location.origin when VITE_BUILD_TARGET=web', async () => {
    ;(globalThis as { window?: unknown }).window = {
      location: { origin: 'http://example.test:8080' },
    } as unknown as Window
    vi.stubEnv('VITE_BUILD_TARGET', 'web')
    vi.stubEnv('VITE_DESKTOP_SERVER_URL', '')
    const mod = await import('./client')
    expect(mod.getDefaultBaseUrl()).toBe('http://example.test:8080')
  })

  it('uses 127.0.0.1:3456 in desktop target', async () => {
    ;(globalThis as { window?: unknown }).window = {
      location: { origin: 'http://example.test:8080' },
    } as unknown as Window
    vi.stubEnv('VITE_BUILD_TARGET', 'desktop')
    vi.stubEnv('VITE_DESKTOP_SERVER_URL', '')
    const mod = await import('./client')
    expect(mod.getDefaultBaseUrl()).toBe('http://127.0.0.1:3456')
  })

  it('VITE_DESKTOP_SERVER_URL wins over both', async () => {
    ;(globalThis as { window?: unknown }).window = {
      location: { origin: 'http://example.test:8080' },
    } as unknown as Window
    vi.stubEnv('VITE_BUILD_TARGET', 'web')
    vi.stubEnv('VITE_DESKTOP_SERVER_URL', 'http://override.test:9000')
    const mod = await import('./client')
    expect(mod.getDefaultBaseUrl()).toBe('http://override.test:9000')
  })
})
