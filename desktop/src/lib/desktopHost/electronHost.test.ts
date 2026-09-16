import { describe, expect, it, vi } from 'vitest'
import { ELECTRON_EVENT_CHANNELS, ELECTRON_IPC_CHANNELS, type ElectronIpcChannel } from '../../../electron/ipc/channels'
import { validateElectronIpcPayload } from '../../../electron/ipc/capabilities'
import { createElectronHost } from './electronHost'
import { PUBLIC_ACCESS_CONSENT_VERSION, type WorkspaceBrowserMenuOptions } from './types'

describe('electron desktop host', () => {
  it('routes public access through validated local IPC without exposing management in browsers', async () => {
    const invoke = vi.fn().mockResolvedValue({ hasCredential: true })
    const host = createElectronHost({ invoke, subscribe: vi.fn() })
    await host.publicAccess.saveCredential('fixture-ngrok-token')
    await host.publicAccess.start(PUBLIC_ACCESS_CONSENT_VERSION)
    await host.publicAccess.setAutoStart(false)
    await host.publicAccess.stop()
    expect(invoke).toHaveBeenNthCalledWith(1, ELECTRON_IPC_CHANNELS.publicAccessSaveCredential, 'fixture-ngrok-token')
    expect(invoke).toHaveBeenNthCalledWith(2, ELECTRON_IPC_CHANNELS.publicAccessStart, PUBLIC_ACCESS_CONSENT_VERSION)
    expect(invoke).toHaveBeenNthCalledWith(3, ELECTRON_IPC_CHANNELS.publicAccessSetAutoStart, false)
    expect(invoke).toHaveBeenNthCalledWith(4, ELECTRON_IPC_CHANNELS.publicAccessStop, undefined)
    const { browserHost } = await import('./browserHost')
    await expect(browserHost.publicAccess.getStatus()).rejects.toThrow('desktop app runtime')
  })

  it('carries a terminal startup identity through the production IPC validator and early events', async () => {
    const handlers = new Map<string, (event: unknown) => void>()
    const host = createElectronHost({
      async invoke<T>(channel: ElectronIpcChannel, payload?: unknown) {
        expect(validateElectronIpcPayload(channel, payload)).toBe(true)
        const request = payload as { requestId: string }
        handlers.get(ELECTRON_EVENT_CHANNELS.terminalOutput)?.({ session_id: 9, requestId: request.requestId, data: 'prompt' })
        handlers.get(ELECTRON_EVENT_CHANNELS.terminalExit)?.({ session_id: 9, requestId: request.requestId, code: 0 })
        return { session_id: 9, shell: '/fixture/sh', cwd: '/fixture' } as T
      },
      async subscribe(channel, handler) {
        handlers.set(channel, handler as (event: unknown) => void)
        return () => { handlers.delete(channel) }
      },
    })
    const output = vi.fn()
    const exit = vi.fn()
    await host.terminal.onOutput(output)
    await host.terminal.onExit(exit)
    await host.terminal.spawn({ cols: 80, rows: 24, requestId: 'fixture-start' })
    expect(output).toHaveBeenCalledWith({ session_id: 9, requestId: 'fixture-start', data: 'prompt' })
    expect(exit).toHaveBeenCalledWith({ session_id: 9, requestId: 'fixture-start', code: 0 })
  })

  it('preserves native browser menu selection, cancellation and errors through the narrow IPC contract', async () => {
    const options: WorkspaceBrowserMenuOptions = {
      x: 20, y: 44, zoomFactor: 1.2, hasPage: true, canOpenExternal: true,
      labels: { find: 'Find', print: 'Print', zoom: 'Zoom', zoomIn: 'Larger', zoomOut: 'Smaller', zoomReset: 'Reset', capture: 'Capture', pickElement: 'Pick', downloads: 'Downloads', history: 'History', openExternal: 'External' },
    }
    const invoke = vi.fn().mockResolvedValueOnce('find').mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('popup failed'))
    const host = createElectronHost({ invoke, subscribe: vi.fn() })
    await expect(host.browser.showMenu('wb-1', options)).resolves.toBe('find')
    expect(invoke).toHaveBeenLastCalledWith(ELECTRON_IPC_CHANNELS.workspaceBrowserShowMenu, { tabId: 'wb-1', ...options })
    await expect(host.browser.showMenu('wb-1', options)).resolves.toBeNull()
    await expect(host.browser.showMenu('wb-1', options)).rejects.toThrow('popup failed')
    await expect(host.browser.showMenu('wb-1', { ...options, x: NaN })).rejects.toThrow('Invalid Electron IPC payload')
    expect(invoke).toHaveBeenCalledTimes(3)
  })

  it('synchronizes locale preferences through narrow app IPC boundaries', async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce('jp')
      .mockResolvedValueOnce(['zh-Hant-TW', 'en-US'])
      .mockResolvedValueOnce(undefined)
    const subscribe = vi.fn().mockResolvedValue(() => {})
    const host = createElectronHost({
      invoke,
      subscribe,
    })

    await expect(host.app.getLocalePreference()).resolves.toBe('jp')
    await expect(host.app.getPreferredSystemLanguages()).resolves.toEqual(['zh-Hant-TW', 'en-US'])
    await host.app.setLocalePreference('kr')
    const handler = vi.fn()
    await host.app.onLocaleChanged(handler)

    expect(invoke).toHaveBeenNthCalledWith(
      1,
      ELECTRON_IPC_CHANNELS.appGetLocalePreference,
      undefined,
    )
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      ELECTRON_IPC_CHANNELS.appGetPreferredSystemLanguages,
      undefined,
    )
    expect(invoke).toHaveBeenNthCalledWith(
      3,
      ELECTRON_IPC_CHANNELS.appSetLocalePreference,
      'kr',
    )
    expect(subscribe).toHaveBeenCalledWith(ELECTRON_EVENT_CHANNELS.appLocaleChanged, handler)
  })

  it('wraps dialog, shell URL, and shell path calls in explicit IPC channels', async () => {
    const invoke = vi.fn().mockResolvedValue('/tmp/report.md')
    const host = createElectronHost({
      invoke,
      subscribe: vi.fn(),
    })

    await host.shell.open('https://example.com')
    await host.shell.openPath('/tmp/report.md')
    await host.dialogs.open({ directory: true, multiple: false, title: 'Choose folder' })

    expect(invoke).toHaveBeenNthCalledWith(1, ELECTRON_IPC_CHANNELS.shellOpen, 'https://example.com')
    expect(invoke).toHaveBeenNthCalledWith(2, ELECTRON_IPC_CHANNELS.shellOpenPath, '/tmp/report.md')
    expect(invoke).toHaveBeenNthCalledWith(3, ELECTRON_IPC_CHANNELS.dialogOpen, {
      directory: true,
      multiple: false,
      title: 'Choose folder',
    })
  })

  it('routes clipboard reads and writes through narrow IPC channels', async () => {
    const invoke = vi.fn().mockResolvedValueOnce('from clipboard').mockResolvedValueOnce(undefined)
    const host = createElectronHost({
      invoke,
      subscribe: vi.fn(),
    })

    await expect(host.clipboard.readText()).resolves.toBe('from clipboard')
    await host.clipboard.writeText('to clipboard')

    expect(invoke).toHaveBeenNthCalledWith(1, ELECTRON_IPC_CHANNELS.clipboardReadText, undefined)
    expect(invoke).toHaveBeenNthCalledWith(2, ELECTRON_IPC_CHANNELS.clipboardWriteText, 'to clipboard')
  })

  it('resolves native paths for renderer File objects through the preload bridge', () => {
    const file = new File(['# Notes'], 'notes.md', { type: 'text/markdown' })
    const getPathForFile = vi.fn().mockReturnValue('C:\\Users\\Nanmi\\Desktop\\notes.md')
    const host = createElectronHost({
      getPathForFile,
      invoke: vi.fn(),
      subscribe: vi.fn(),
    })

    expect(host.files.getPathForFile(file)).toBe('C:\\Users\\Nanmi\\Desktop\\notes.md')
    expect(getPathForFile).toHaveBeenCalledWith(file)
  })

  it('rejects invalid preload payloads before invoking Electron IPC', async () => {
    const invoke = vi.fn()
    const host = createElectronHost({
      invoke,
      subscribe: vi.fn(),
    })

    await expect(host.shell.openPath({ path: '/tmp/report.md' } as unknown as string)).rejects.toThrow(
      'Invalid Electron IPC payload',
    )
    expect(invoke).not.toHaveBeenCalled()
  })

  it('advertises custom window chrome for the Electron frameless shell', () => {
    const host = createElectronHost({
      invoke: vi.fn(),
      subscribe: vi.fn(),
    })

    expect(host.capabilities.windowControls).toBe(true)
  })

  it('keeps the legacy window dragging IPC channel payload-free', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined)
    const host = createElectronHost({
      invoke,
      subscribe: vi.fn(),
    })

    await host.window.startDragging()

    expect(invoke).toHaveBeenCalledWith(ELECTRON_IPC_CHANNELS.windowStartDragging, undefined)
  })

  it('opens dedicated trace windows through a narrow IPC channel', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined)
    const host = createElectronHost({
      invoke,
      subscribe: vi.fn(),
    })

    await host.trace?.openWindow('session-123')

    expect(invoke).toHaveBeenCalledWith(ELECTRON_IPC_CHANNELS.traceOpenWindow, 'session-123')
  })

  it('routes preview zoom through the preview IPC channel', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined)
    const host = createElectronHost({
      invoke,
      subscribe: vi.fn(),
    })

    await host.preview.setZoom(0.8)

    expect(invoke).toHaveBeenCalledWith(ELECTRON_IPC_CHANNELS.previewSetZoom, 0.8)
  })

  it('addresses every multi-page browser call by tab id', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn().mockResolvedValue(vi.fn())
    const host = createElectronHost({ invoke, subscribe })
    const handler = vi.fn()

    await host.browser.create('wb-1', {
      storageId: 'wsb-1',
      url: 'https://example.com',
      bounds: { x: 0, y: 40, width: 800, height: 600 },
      visible: false,
    })
    await host.browser.navigate('wb-1', 'https://example.com/next')
    await host.browser.goBack('wb-1')
    await host.browser.goForward('wb-1')
    await host.browser.reload('wb-1', { ignoreCache: true })
    await host.browser.stop('wb-1')
    await host.browser.setBounds('wb-1', { x: 1, y: 2, width: 3, height: 4 })
    await host.browser.setVisible('wb-1', false)
    await host.browser.setZoom('wb-1', 1.25)
    await host.browser.find('wb-1', 'invoice', { matchCase: true })
    await host.browser.stopFind('wb-1')
    await host.browser.capture('wb-1', 'full')
    await host.browser.message('wb-1', { v: 1, type: 'exit-picker' })
    await host.browser.printToPdf('wb-1')
    await host.browser.close('wb-1')
    await host.browser.onEvent(handler)

    expect(invoke.mock.calls).toEqual([
      [ELECTRON_IPC_CHANNELS.workspaceBrowserCreate, {
        tabId: 'wb-1',
        storageId: 'wsb-1',
        url: 'https://example.com',
        bounds: { x: 0, y: 40, width: 800, height: 600 },
        visible: false,
      }],
      [ELECTRON_IPC_CHANNELS.workspaceBrowserNavigate, { tabId: 'wb-1', url: 'https://example.com/next' }],
      [ELECTRON_IPC_CHANNELS.workspaceBrowserGoBack, { tabId: 'wb-1' }],
      [ELECTRON_IPC_CHANNELS.workspaceBrowserGoForward, { tabId: 'wb-1' }],
      [ELECTRON_IPC_CHANNELS.workspaceBrowserReload, { tabId: 'wb-1', ignoreCache: true }],
      [ELECTRON_IPC_CHANNELS.workspaceBrowserStop, { tabId: 'wb-1' }],
      [ELECTRON_IPC_CHANNELS.workspaceBrowserSetBounds, { tabId: 'wb-1', bounds: { x: 1, y: 2, width: 3, height: 4 } }],
      [ELECTRON_IPC_CHANNELS.workspaceBrowserSetVisible, { tabId: 'wb-1', visible: false }],
      [ELECTRON_IPC_CHANNELS.workspaceBrowserSetZoom, { tabId: 'wb-1', factor: 1.25 }],
      [ELECTRON_IPC_CHANNELS.workspaceBrowserFind, { tabId: 'wb-1', text: 'invoice', options: { matchCase: true } }],
      [ELECTRON_IPC_CHANNELS.workspaceBrowserStopFind, { tabId: 'wb-1' }],
      [ELECTRON_IPC_CHANNELS.workspaceBrowserCapture, { tabId: 'wb-1', kind: 'full' }],
      [ELECTRON_IPC_CHANNELS.workspaceBrowserMessage, { tabId: 'wb-1', payload: { v: 1, type: 'exit-picker' } }],
      [ELECTRON_IPC_CHANNELS.workspaceBrowserPrintToPdf, { tabId: 'wb-1' }],
      [ELECTRON_IPC_CHANNELS.workspaceBrowserClose, { tabId: 'wb-1' }],
    ])
    expect(subscribe).toHaveBeenCalledWith(ELECTRON_EVENT_CHANNELS.workspaceBrowserEvent, handler)
  })

  it('advertises the multi-page browser only where a native host implements it', () => {
    const host = createElectronHost({ invoke: vi.fn(), subscribe: vi.fn() })

    expect(host.capabilities.workspaceBrowser).toBe(true)
  })

  it('returns a presentation snapshot through its own addressed IPC without requesting a chat capture', async () => {
    const invoke = vi.fn().mockResolvedValue('data:image/png;base64,BACKDROP')
    const host = createElectronHost({ invoke, subscribe: vi.fn() })
    await expect(host.browser.snapshot('wb-1')).resolves.toBe('data:image/png;base64,BACKDROP')
    expect(invoke.mock.calls).toEqual([[ELECTRON_IPC_CHANNELS.workspaceBrowserSnapshot, { tabId: 'wb-1' }]])
    await expect(host.browser.snapshot('')).rejects.toThrow('Invalid Electron IPC payload')
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('rejects an unaddressed browser call before it reaches Electron IPC', async () => {
    const invoke = vi.fn()
    const host = createElectronHost({ invoke, subscribe: vi.fn() })

    await expect(host.browser.navigate('', 'https://example.com')).rejects.toThrow(
      'Invalid Electron IPC payload',
    )
    await expect(host.browser.capture('wb-1', 'element' as 'full')).rejects.toThrow(
      'Invalid Electron IPC payload',
    )
    expect(invoke).not.toHaveBeenCalled()
  })

  it('keeps event subscriptions behind named event channels', async () => {
    const unlisten = vi.fn()
    const subscribe = vi.fn().mockResolvedValue(unlisten)
    const handler = vi.fn()
    const host = createElectronHost({
      invoke: vi.fn(),
      subscribe,
    })

    const stop = await host.window.onNativeMenuNavigate(handler)
    stop()

    expect(subscribe).toHaveBeenCalledWith(ELECTRON_EVENT_CHANNELS.nativeMenuNavigate, handler)
    expect(unlisten).toHaveBeenCalledTimes(1)
  })

  it('routes custom pet discovery and window controls through narrow IPC channels', async () => {
    const petList = {
      pets: [{
        id: 'custom-bot',
        displayName: 'Custom Bot',
        description: 'A local companion.',
        spriteVersionNumber: 2 as const,
        spritesheetPath: 'spritesheet.webp',
        mimeType: 'image/webp' as const,
        dataUrl: 'data:image/webp;base64,AAAA',
      }],
      errors: [],
    }
    const invoke = vi.fn().mockResolvedValueOnce(petList).mockResolvedValue(undefined)
    const subscribe = vi.fn().mockResolvedValue(vi.fn())
    const host = createElectronHost({ invoke, subscribe })
    const handler = vi.fn()

    await expect(host.pets.list()).resolves.toEqual(petList)
    await host.pets.createFromImage({
      slug: 'soft-moon-cat',
      displayName: 'Soft Moon Cat',
      description: 'A softly animated companion.',
    })
    await host.pets.createFromAtlas({
      slug: 'moon-cat',
      displayName: 'Moon Cat',
      description: 'A quiet companion.',
    })
    await host.pets.openFolder()
    await host.pets.show()
    await host.pets.hide()
    await host.pets.showContextMenu('Close pet')
    await host.pets.dragWindow({ phase: 'move', x: 640, y: 480 })
    await host.pets.setIgnoreMouseEvents(true)
    await host.pets.setInteractiveRegions([{ x: 100, y: 200, width: 120, height: 140 }])
    await host.pets.focusMainWindow()
    await host.pets.focusSession('session-123')
    await host.pets.onNavigateSession(handler)
    await host.pets.onVisibilityChanged(handler)

    expect(invoke).toHaveBeenNthCalledWith(1, ELECTRON_IPC_CHANNELS.petsList, undefined)
    expect(invoke).toHaveBeenNthCalledWith(2, ELECTRON_IPC_CHANNELS.petsCreateFromImage, {
      slug: 'soft-moon-cat',
      displayName: 'Soft Moon Cat',
      description: 'A softly animated companion.',
    })
    expect(invoke).toHaveBeenNthCalledWith(3, ELECTRON_IPC_CHANNELS.petsCreateFromAtlas, {
      slug: 'moon-cat',
      displayName: 'Moon Cat',
      description: 'A quiet companion.',
    })
    expect(invoke).toHaveBeenNthCalledWith(4, ELECTRON_IPC_CHANNELS.petsOpenFolder, undefined)
    expect(invoke).toHaveBeenNthCalledWith(5, ELECTRON_IPC_CHANNELS.petsShow, undefined)
    expect(invoke).toHaveBeenNthCalledWith(6, ELECTRON_IPC_CHANNELS.petsHide, undefined)
    expect(invoke).toHaveBeenNthCalledWith(7, ELECTRON_IPC_CHANNELS.petsShowContextMenu, {
      closeLabel: 'Close pet',
    })
    expect(invoke).toHaveBeenNthCalledWith(8, ELECTRON_IPC_CHANNELS.petsDragWindow, {
      phase: 'move',
      x: 640,
      y: 480,
    })
    expect(invoke).toHaveBeenNthCalledWith(9, ELECTRON_IPC_CHANNELS.petsSetIgnoreMouseEvents, true)
    expect(invoke).toHaveBeenNthCalledWith(10, ELECTRON_IPC_CHANNELS.petsSetInteractiveRegions, [
      { x: 100, y: 200, width: 120, height: 140 },
    ])
    expect(invoke).toHaveBeenNthCalledWith(11, ELECTRON_IPC_CHANNELS.petsFocusMainWindow, undefined)
    expect(invoke).toHaveBeenNthCalledWith(12, ELECTRON_IPC_CHANNELS.petsFocusSession, 'session-123')
    expect(subscribe).toHaveBeenCalledWith(ELECTRON_EVENT_CHANNELS.petNavigateSession, handler)
    expect(subscribe).toHaveBeenCalledWith(ELECTRON_EVENT_CHANNELS.petVisibilityChanged, handler)
  })

  it('acknowledges handled notification actions through a diagnostics IPC channel', async () => {
    const invoke = vi.fn().mockResolvedValue(true)
    const payload = { target: { type: 'session', sessionId: 'session-1' } }
    const host = createElectronHost({
      invoke,
      subscribe: vi.fn(),
    })

    await expect(host.notifications.ackAction(payload)).resolves.toBe(true)

    expect(invoke).toHaveBeenCalledWith(ELECTRON_IPC_CHANNELS.notificationActionAck, payload)
  })

  it('wraps Electron update metadata with download/install methods', async () => {
    const unlisten = vi.fn()
    const invoke = vi.fn()
      .mockResolvedValueOnce({ version: '1.2.3', body: 'Fixes' })
      .mockResolvedValue(undefined)
    const subscribe = vi.fn().mockResolvedValue(unlisten)
    const onProgress = vi.fn()
    const host = createElectronHost({ invoke, subscribe })

    const update = await host.updates.check()
    await update?.download(onProgress)
    await update?.install()
    await update?.close()

    expect(update?.version).toBe('1.2.3')
    expect(subscribe).toHaveBeenCalledWith(ELECTRON_EVENT_CHANNELS.updateDownloadEvent, onProgress)
    expect(invoke).toHaveBeenNthCalledWith(1, ELECTRON_IPC_CHANNELS.updateCheck, undefined)
    expect(invoke).toHaveBeenNthCalledWith(2, ELECTRON_IPC_CHANNELS.updateDownload, undefined)
    expect(invoke).toHaveBeenNthCalledWith(3, ELECTRON_IPC_CHANNELS.updateInstall, undefined)
    expect(invoke).toHaveBeenNthCalledWith(4, ELECTRON_IPC_CHANNELS.updateCancelInstall, undefined)
    expect(unlisten).toHaveBeenCalledTimes(1)
  })
})
