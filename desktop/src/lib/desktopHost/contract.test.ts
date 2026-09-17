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
      conceptKnowledge: false,
      conversationContext: false,
      dataConnections: false,
      dialogs: false,
      hostManagement: false,
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

  it('returns UNAVAILABLE for managed resources browser host methods', async () => {
    const unavailable = { ok: false, error: { code: 'UNAVAILABLE', messageKey: 'managedResources.errors.desktopOnly' } }

    await expect(browserHost.hostManagement.getCapabilities()).resolves.toEqual(unavailable)
    await expect(browserHost.hostManagement.listHosts()).resolves.toEqual(unavailable)
    await expect(browserHost.hostManagement.getHost('h1')).resolves.toEqual(unavailable)
    await expect(browserHost.hostManagement.saveHost({} as any)).resolves.toEqual(unavailable)
    await expect(browserHost.hostManagement.deleteHost('h1', 1)).resolves.toEqual(unavailable)
    await expect(browserHost.hostManagement.listTags()).resolves.toEqual(unavailable)
    await expect(browserHost.hostManagement.saveTag({} as any)).resolves.toEqual(unavailable)
    await expect(browserHost.hostManagement.deleteTag('t1', 1)).resolves.toEqual(unavailable)
    await expect(browserHost.hostManagement.saveApplication({} as any)).resolves.toEqual(unavailable)
    await expect(browserHost.hostManagement.deleteApplication({} as any)).resolves.toEqual(unavailable)
    await expect(browserHost.hostManagement.saveCredential({} as any)).resolves.toEqual(unavailable)
    await expect(browserHost.hostManagement.deleteCredential('c1', 1)).resolves.toEqual(unavailable)
    await expect(browserHost.hostManagement.revealCredential('c1')).resolves.toEqual(unavailable)
    await expect(browserHost.hostManagement.provideTemporaryCredential('h1', { kind: 'ssh-password', password: 'p' })).resolves.toEqual(unavailable)
    await expect(browserHost.hostManagement.exportMetadata()).resolves.toEqual(unavailable)
    await expect(browserHost.hostManagement.importMetadata()).resolves.toEqual(unavailable)

    await expect(browserHost.conceptKnowledge.listConcepts()).resolves.toEqual(unavailable)
    await expect(browserHost.conceptKnowledge.getConcept('c1')).resolves.toEqual(unavailable)
    await expect(browserHost.conceptKnowledge.saveConcept({} as any)).resolves.toEqual(unavailable)
    await expect(browserHost.conceptKnowledge.deleteConcept('c1', 1)).resolves.toEqual(unavailable)

    await expect(browserHost.conversationContext.getSelection('s1')).resolves.toEqual(unavailable)
    await expect(browserHost.conversationContext.saveSelection('s1', {} as any)).resolves.toEqual(unavailable)
    await expect(browserHost.conversationContext.deleteSelection('s1')).resolves.toEqual(unavailable)
  })

  it('returns the same UNAVAILABLE result for every M4 browser host method, with no side effects', async () => {
    const unavailable = { ok: false, error: { code: 'UNAVAILABLE', messageKey: 'managedResources.errors.desktopOnly' } }
    const connectionId = '11111111-1111-4111-8111-111111111111'
    const jobId = '22222222-2222-4222-8222-222222222222'
    const editId = '33333333-3333-4333-8333-333333333333'
    const token = '44444444-4444-4444-8444-444444444444'

    const originalFetch = globalThis.fetch
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch

    try {
      const results = await Promise.all([
        browserHost.hostManagement.mintUploadToken('report.txt'),
        browserHost.hostManagement.mintDownloadToken('report.txt'),
        browserHost.hostManagement.resolveLocalToken(token),
        browserHost.hostManagement.revokeLocalToken(token),
        browserHost.hostManagement.sftpList(connectionId, 1, '/home/tester'),
        browserHost.hostManagement.sftpStat(connectionId, 1, '/home/tester/notes.txt'),
        browserHost.hostManagement.transferStartDownload(jobId, connectionId, 1, '/home/tester/a.bin', token),
        browserHost.hostManagement.transferStartUpload(jobId, connectionId, 1, '/home/tester/a.bin', token),
        browserHost.hostManagement.transferCancel(jobId),
        browserHost.hostManagement.transferGet(jobId),
        browserHost.hostManagement.remoteEditOpen(connectionId, 1, '/home/tester/notes.txt'),
        browserHost.hostManagement.remoteEditSave(editId, 'rev-1', 'hello'),
        browserHost.hostManagement.remoteEditClose(editId),
      ])

      expect(results).toHaveLength(13)
      // One consistent, recognizable desktop-only result — no method invents a
      // success, and no two of them disagree about the reason.
      const distinct = new Set(results.map(result => JSON.stringify(result)))
      expect([...distinct]).toEqual([JSON.stringify(unavailable)])
      expect(results.every(result => result.ok === false)).toBe(true)

      // No side effects: the browser fallback never reaches the network.
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
