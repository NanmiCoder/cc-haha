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
      workspaceBrowser: false,
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
    await expect(browserHost.pets.list()).rejects.toThrow('desktop app runtime')
    await expect(browserHost.pets.createFromImage({
      slug: 'moon-cat',
      displayName: 'Moon Cat',
      description: 'A quiet companion.',
    })).rejects.toThrow('desktop app runtime')
    await expect(browserHost.pets.createFromAtlas({
      slug: 'moon-cat',
      displayName: 'Moon Cat',
      description: 'A quiet companion.',
    })).rejects.toThrow('desktop app runtime')
    await expect(browserHost.pets.pickSourceSheet({})).rejects.toThrow('desktop app runtime')
    await expect(browserHost.pets.createFromAtlasBytes({
      slug: 'moon-cat',
      displayName: 'Moon Cat',
      description: 'A quiet moonlight companion.',
      atlasData: new Uint8Array([1, 2, 3]),
      mimeType: 'image/png',
    })).rejects.toThrow('desktop app runtime')
    await expect(browserHost.pets.openFolder()).rejects.toThrow('desktop app runtime')
    await expect(browserHost.pets.show()).rejects.toThrow('desktop app runtime')
    await expect(browserHost.pets.hide()).rejects.toThrow('desktop app runtime')
    await expect(browserHost.pets.showContextMenu('Close pet')).rejects.toThrow('desktop app runtime')
    await expect(browserHost.pets.dragWindow({ phase: 'start', x: 100, y: 100 })).rejects.toThrow('desktop app runtime')
    await expect(browserHost.pets.setIgnoreMouseEvents(true)).rejects.toThrow('desktop app runtime')
    await expect(browserHost.pets.setInteractiveRegions([{ x: 0, y: 0, width: 10, height: 10 }])).rejects.toThrow('desktop app runtime')
    await expect(browserHost.pets.focusMainWindow()).rejects.toThrow('desktop app runtime')
    await expect(browserHost.pets.focusSession('session-1')).rejects.toThrow('desktop app runtime')
    await expect(browserHost.pets.onNavigateSession(vi.fn())).resolves.toEqual(expect.any(Function))
  })

  it('degrades the multi-page browser to resolved no-ops instead of throwing', async () => {
    // `workspaceBrowserHost` gates on the capability and shows an "open
    // externally" fallback, so a rejection here would only ever surface as an
    // unhandled error behind that fallback.
    expect(browserHost.capabilities.workspaceBrowser).toBe(false)
    await expect(browserHost.browser.create('wb-1', { storageId: 'wsb-1' })).resolves.toBeUndefined()
    await expect(browserHost.browser.navigate('wb-1', 'https://example.com')).resolves.toBeUndefined()
    await expect(browserHost.browser.goBack('wb-1')).resolves.toBeUndefined()
    await expect(browserHost.browser.goForward('wb-1')).resolves.toBeUndefined()
    await expect(browserHost.browser.reload('wb-1', { ignoreCache: true })).resolves.toBeUndefined()
    await expect(browserHost.browser.stop('wb-1')).resolves.toBeUndefined()
    await expect(browserHost.browser.setBounds('wb-1', { x: 0, y: 0, width: 10, height: 10 })).resolves.toBeUndefined()
    await expect(browserHost.browser.setVisible('wb-1', false)).resolves.toBeUndefined()
    await expect(browserHost.browser.setZoom('wb-1', 1.25)).resolves.toBeUndefined()
    await expect(browserHost.browser.find('wb-1', 'invoice')).resolves.toBeUndefined()
    await expect(browserHost.browser.stopFind('wb-1')).resolves.toBeUndefined()
    await expect(browserHost.browser.capture('wb-1', 'viewport')).resolves.toBeUndefined()
    await expect(browserHost.browser.snapshot('wb-1')).resolves.toBeNull()
    await expect(browserHost.browser.message('wb-1', { v: 1, type: 'exit-picker' })).resolves.toBeUndefined()
    await expect(browserHost.browser.printToPdf('wb-1')).resolves.toBeUndefined()
    await expect(browserHost.browser.showMenu('wb-1', {
      x: 100,
      y: 50,
      zoomFactor: 1,
      hasPage: false,
      canOpenExternal: false,
      labels: {
        find: 'Find', print: 'Print', zoom: 'Zoom', zoomIn: 'Zoom in',
        zoomOut: 'Zoom out', zoomReset: 'Reset zoom', capture: 'Capture',
        pickElement: 'Pick element', downloads: 'Downloads', history: 'History',
        openExternal: 'Open externally',
      },
    })).resolves.toBeNull()
    await expect(browserHost.browser.close('wb-1')).resolves.toBeUndefined()

    const handler = vi.fn()
    const stop = await browserHost.browser.onEvent(handler)
    expect(stop()).toBeUndefined()
    expect(handler).not.toHaveBeenCalled()
  })

  it('accepts the applied appearance instead of rejecting it in a browser tab', async () => {
    // Reporting the theme is a notification to a native shell, and a browser
    // tab simply has none — throwing here would surface as a console error on
    // every theme change in the H5 entry.
    await expect(browserHost.appearance.setApplied({
      isDark: true,
      background: '#0E0E0E',
      lightBackground: '#FFFFFF',
      followSystem: true,
    })).resolves.toBeUndefined()
  })

  it('uses browser language preferences outside Electron', async () => {
    const languages = vi.spyOn(window.navigator, 'languages', 'get').mockReturnValue(['ja-JP', 'en-US'])

    await expect(browserHost.app.getPreferredSystemLanguages()).resolves.toEqual(['ja-JP', 'en-US'])
    await expect(browserHost.app.getLocalePreference()).resolves.toBeNull()
    await expect(browserHost.app.setLocalePreference('jp')).resolves.toBeUndefined()
    await expect(browserHost.app.onLocaleChanged(vi.fn())).resolves.toEqual(expect.any(Function))

    languages.mockRestore()
  })

  it('uses navigator.language when the browser language list is unavailable', async () => {
    const languages = vi.spyOn(window.navigator, 'languages', 'get').mockImplementation(() => {
      throw new Error('languages unavailable')
    })
    const language = vi.spyOn(window.navigator, 'language', 'get').mockReturnValue('ko-KR')

    await expect(browserHost.app.getPreferredSystemLanguages()).resolves.toEqual(['ko-KR'])

    languages.mockRestore()
    language.mockRestore()
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
