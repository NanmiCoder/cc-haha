import { describe, expect, it, vi } from 'vitest'

import { browserHost } from './browserHost'
import { createDesktopHost, detectDesktopHostEnvironment } from './index'

describe('desktop host contract', () => {
  it('keeps browser fallback explicit for non-desktop runtimes', () => {
    expect(browserHost.kind).toBe('browser')
    expect(browserHost.isDesktop).toBe(false)
    expect(browserHost.capabilities).toEqual({
      appMode: false,
      clipboard: false,
      dialogs: false,
      notifications: false,
      previewWebview: false,
      shell: false,
      terminal: false,
      updates: false,
      windowControls: false,
      zoom: false,
    })
  })

  it('rejects desktop-only browser calls with actionable errors', async () => {
    await expect(browserHost.runtime.getServerUrl()).rejects.toThrow('desktop app runtime')
    await expect(browserHost.runtime.getLocalAccessToken()).rejects.toThrow('desktop app runtime')
    await expect(browserHost.dialogs.open({ directory: true })).rejects.toThrow('desktop app runtime')
    await expect(browserHost.shell.openPath('/tmp/report.md')).rejects.toThrow('desktop app runtime')
    await expect(browserHost.terminal.spawn({ cwd: '/tmp', cols: 80, rows: 24 })).rejects.toThrow(
      'desktop app runtime',
    )
    await expect(browserHost.updates.check()).resolves.toBeNull()
  })

  it('detects the browser fallback when native host globals are absent', () => {
    expect(createDesktopHost({ electronHost: null })).toBe(browserHost)
  })

  it('prefers an injected Electron preload host over browser fallback', () => {
    const electronHost = {
      ...browserHost,
      kind: 'electron' as const,
      isDesktop: true,
    }

    expect(createDesktopHost({ electronHost })).toBe(electronHost)
  })

  it('detects Electron runtime globals without importing native modules', () => {
    const originalDesktopHost = window.desktopHost

    try {
      Reflect.deleteProperty(window, 'desktopHost')
      expect(detectDesktopHostEnvironment()).toEqual({ electronHost: null })

      const electronHost = {
        ...browserHost,
        kind: 'electron' as const,
        isDesktop: true,
      }
      window.desktopHost = electronHost
      expect(detectDesktopHostEnvironment()).toEqual({ electronHost })
    } finally {
      if (typeof originalDesktopHost === 'undefined') {
        Reflect.deleteProperty(window, 'desktopHost')
      } else {
        window.desktopHost = originalDesktopHost
      }
    }
  })

  it('allows event unlisteners to stay synchronous across host implementations', async () => {
    const outputHandler = vi.fn()
    const exitHandler = vi.fn()

    const stopOutput = await browserHost.terminal.onOutput(outputHandler)
    const stopExit = await browserHost.terminal.onExit(exitHandler)

    expect(stopOutput()).toBeUndefined()
    expect(stopExit()).toBeUndefined()
    expect(outputHandler).not.toHaveBeenCalled()
    expect(exitHandler).not.toHaveBeenCalled()
  })
})
