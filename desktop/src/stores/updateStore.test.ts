import { beforeEach, describe, expect, it, vi } from 'vitest'
import { browserHost } from '../lib/desktopHost/browserHost'
import { createElectronHost } from '../lib/desktopHost/electronHost'
import type { DesktopUpdateDownloadEvent } from '../lib/desktopHost/types'
import { ELECTRON_IPC_CHANNELS, type ElectronIpcChannel } from '../../electron/ipc/channels'
import { ElectronUpdaterService, type ElectronUpdaterLike } from '../../electron/services/updater'

const check = vi.fn()
const relaunch = vi.fn()
const invoke = vi.fn()

vi.mock('@tauri-apps/plugin-updater', () => ({
  check,
}))

vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch,
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke,
}))

function installElectronUpdateHost() {
  window.desktopHost = {
    ...browserHost,
    kind: 'electron',
    isDesktop: true,
    capabilities: {
      ...browserHost.capabilities,
      updates: true,
    },
    updates: {
      ...browserHost.updates,
      check,
      prepareInstall: () => invoke('prepare_for_update_install'),
      cancelInstall: () => invoke('cancel_update_install'),
      relaunch,
    },
  }
}

describe('updateStore', () => {
  beforeEach(() => {
    check.mockReset()
    relaunch.mockReset()
    invoke.mockReset()
    window.localStorage.clear()
    installElectronUpdateHost()
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
    Reflect.deleteProperty(window, '__TAURI__')
  })

  it('stores available update metadata after a successful check', async () => {
    const download = vi.fn(async (onEvent?: (event: unknown) => void) => {
      onEvent?.({ event: 'Started', data: { contentLength: 200 } })
      onEvent?.({ event: 'Progress', data: { chunkLength: 200 } })
      onEvent?.({ event: 'Finished' })
    })
    const update = {
      version: '0.2.0',
      body: 'Bug fixes and performance improvements',
      download,
      close: vi.fn().mockResolvedValue(undefined),
    }
    check.mockResolvedValue(update)

    vi.resetModules()
    const { useUpdateStore } = await import('./updateStore')

    const result = await useUpdateStore.getState().checkForUpdates()

    expect(result).toBe(update)
    expect(useUpdateStore.getState().availableVersion).toBe('0.2.0')
    expect(useUpdateStore.getState().releaseNotes).toBe('Bug fixes and performance improvements')
    expect(download).toHaveBeenCalledTimes(1)
    expect(useUpdateStore.getState().status).toBe('downloaded')
    expect(useUpdateStore.getState().shouldPrompt).toBe(true)
  })

  it('treats same-version update metadata as already up to date', async () => {
    const download = vi.fn().mockResolvedValue(undefined)
    const close = vi.fn().mockResolvedValue(undefined)
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      capabilities: {
        ...browserHost.capabilities,
        updates: true,
      },
      app: {
        ...browserHost.app,
        getVersion: vi.fn().mockResolvedValue('0.4.1'),
      },
      updates: {
        ...browserHost.updates,
        check: vi.fn().mockResolvedValue({
          version: '0.4.1',
          body: 'Already installed',
          download,
          close,
        }),
      },
    }

    vi.resetModules()
    const { useUpdateStore } = await import('./updateStore')

    await expect(useUpdateStore.getState().checkForUpdates()).resolves.toBeNull()

    expect(download).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1)
    expect(useUpdateStore.getState().status).toBe('up-to-date')
    expect(useUpdateStore.getState().availableVersion).toBeNull()
    expect(useUpdateStore.getState().shouldPrompt).toBe(false)
  })

  it('checks, installs, and relaunches through an injected desktop host', async () => {
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
    const download = vi.fn(async (onEvent?: (event: unknown) => void) => {
      onEvent?.({ event: 'Started', data: { contentLength: 100 } })
      onEvent?.({ event: 'Progress', data: { chunkLength: 100 } })
      onEvent?.({ event: 'Finished' })
    })
    const install = vi.fn().mockResolvedValue(undefined)
    const checkUpdate = vi.fn().mockResolvedValue({
      version: '0.4.0',
      body: 'Electron host update',
      download,
      install,
      close: vi.fn().mockResolvedValue(undefined),
    })
    const prepareInstall = vi.fn().mockResolvedValue(undefined)
    const relaunchHost = vi.fn().mockResolvedValue(undefined)

    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      capabilities: {
        ...browserHost.capabilities,
        updates: true,
      },
      updates: {
        ...browserHost.updates,
        check: checkUpdate,
        prepareInstall,
        relaunch: relaunchHost,
      },
    }

    vi.resetModules()
    const { useUpdateStore } = await import('./updateStore')

    const result = await useUpdateStore.getState().checkForUpdates()
    await useUpdateStore.getState().installUpdate()

    expect(result?.version).toBe('0.4.0')
    expect(checkUpdate).toHaveBeenCalledWith(undefined)
    expect(download).toHaveBeenCalledTimes(1)
    expect(prepareInstall).toHaveBeenCalledTimes(1)
    expect(install).toHaveBeenCalledTimes(1)
    expect(relaunchHost).toHaveBeenCalledTimes(1)
    expect(invoke).not.toHaveBeenCalled()
    expect(relaunch).not.toHaveBeenCalled()
  })

  it('does not show the global prompt while a background download is still running', async () => {
    let finishDownload!: () => void
    const download = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishDownload = resolve
        }),
    )
    check.mockResolvedValue({
      version: '0.2.0',
      body: 'Notes',
      download,
      close: vi.fn().mockResolvedValue(undefined),
    })

    vi.resetModules()
    const { useUpdateStore } = await import('./updateStore')

    await useUpdateStore.getState().checkForUpdates()

    expect(download).toHaveBeenCalledTimes(1)
    expect(useUpdateStore.getState().status).toBe('downloading')
    expect(useUpdateStore.getState().shouldPrompt).toBe(false)

    finishDownload()
    await Promise.resolve()

    expect(useUpdateStore.getState().status).toBe('downloaded')
    expect(useUpdateStore.getState().shouldPrompt).toBe(true)
  })

  it('reuses the in-flight background download when checking again', async () => {
    let finishDownload!: () => void
    const download = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishDownload = resolve
        }),
    )
    const update = {
      version: '0.2.0',
      body: 'Notes',
      download,
      close: vi.fn().mockResolvedValue(undefined),
    }
    check.mockResolvedValue(update)

    vi.resetModules()
    const { useUpdateStore } = await import('./updateStore')

    await useUpdateStore.getState().checkForUpdates()
    await useUpdateStore.getState().checkForUpdates()

    expect(check).toHaveBeenCalledTimes(1)
    expect(download).toHaveBeenCalledTimes(1)

    finishDownload()
    await Promise.resolve()

    expect(useUpdateStore.getState().status).toBe('downloaded')
  })

  it('does not cancel the freshly checked update when replacing an older wrapper', async () => {
    const oldClose = vi.fn().mockResolvedValue(undefined)
    const download = vi.fn(async (onEvent?: (event: unknown) => void) => {
      onEvent?.({ event: 'Started', data: { contentLength: 100 } })
      onEvent?.({ event: 'Finished' })
    })

    check
      .mockResolvedValueOnce({
        version: '0.2.0',
        body: 'Notes',
        download: vi.fn().mockResolvedValue(undefined),
        close: oldClose,
      })
      .mockResolvedValueOnce({
        version: '0.2.0',
        body: 'Notes',
        download,
        close: vi.fn().mockResolvedValue(undefined),
      })

    vi.resetModules()
    const { useUpdateStore } = await import('./updateStore')

    await useUpdateStore.getState().checkForUpdates({ autoDownload: false })
    await useUpdateStore.getState().checkForUpdates({ autoDownload: false })
    await useUpdateStore.getState().downloadUpdate()

    expect(oldClose).not.toHaveBeenCalled()
    expect(download).toHaveBeenCalledTimes(1)
    expect(useUpdateStore.getState().status).toBe('downloaded')
  })

  it('passes the configured manual update proxy to update checks', async () => {
    const update = {
      version: '0.2.0',
      body: 'Bug fixes and performance improvements',
      download: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    }
    check.mockResolvedValue(update)

    vi.resetModules()
    const { useSettingsStore } = await import('./settingsStore')
    useSettingsStore.setState({
      updateProxy: {
        mode: 'manual',
        url: 'http://127.0.0.1:7890',
      },
    })
    const { useUpdateStore } = await import('./updateStore')

    await useUpdateStore.getState().checkForUpdates()

    expect(check).toHaveBeenCalledWith({ proxy: 'http://127.0.0.1:7890' })
  })

  it('does not re-prompt for the same version after dismissing once', async () => {
    const download = vi.fn(async (onEvent?: (event: unknown) => void) => {
      onEvent?.({ event: 'Started', data: { contentLength: 100 } })
      onEvent?.({ event: 'Finished' })
    })
    check.mockResolvedValue({
      version: '0.2.0',
      body: 'Bug fixes and performance improvements',
      download,
      close: vi.fn().mockResolvedValue(undefined),
    })

    vi.resetModules()
    const { useUpdateStore } = await import('./updateStore')

    await useUpdateStore.getState().checkForUpdates()
    useUpdateStore.getState().dismissPrompt()

    expect(useUpdateStore.getState().shouldPrompt).toBe(false)
    expect(window.localStorage.getItem('cc-haha-dismissed-update-version')).toBe('0.2.0')

    await useUpdateStore.getState().checkForUpdates({ silent: true })

    expect(useUpdateStore.getState().status).toBe('available')
    expect(useUpdateStore.getState().availableVersion).toBe('0.2.0')
    expect(useUpdateStore.getState().shouldPrompt).toBe(false)
    expect(download).toHaveBeenCalledTimes(1)
  })

  it('honors the existing Later fixture across repeated startups until explicit installation', async () => {
    vi.useFakeTimers()
    try {
      // Existing releases already persist this string; no new schema is needed.
      window.localStorage.setItem('cc-haha-dismissed-update-version', '0.2.0')
      const download = vi.fn().mockResolvedValue(undefined)
      const install = vi.fn().mockResolvedValue(undefined)
      check.mockResolvedValue({ version: '0.2.0', download, install, close: vi.fn() })

      for (let restart = 0; restart < 3; restart += 1) {
        vi.resetModules()
        const { useUpdateStore } = await import('./updateStore')
        const startup = useUpdateStore.getState().initialize()
        await vi.advanceTimersByTimeAsync(5000)
        await startup

        expect(useUpdateStore.getState().availableVersion).toBe('0.2.0')
        expect(useUpdateStore.getState().shouldPrompt).toBe(false)
        expect(download).not.toHaveBeenCalled()
        expect(install).not.toHaveBeenCalled()
        expect(relaunch).not.toHaveBeenCalled()
      }

      const { useUpdateStore } = await import('./updateStore')
      await useUpdateStore.getState().installUpdate()

      expect(download).toHaveBeenCalledTimes(1)
      expect(install).toHaveBeenCalledTimes(1)
      expect(relaunch).toHaveBeenCalledTimes(1)
      expect(window.localStorage.getItem('cc-haha-dismissed-update-version')).toBeNull()
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('does not start automatic checks after automatic updates have been disabled', async () => {
    vi.resetModules()
    const { useSettingsStore } = await import('./settingsStore')
    useSettingsStore.setState({ autoUpdateEnabled: false })
    const { useUpdateStore } = await import('./updateStore')

    await useUpdateStore.getState().initialize()
    await useUpdateStore.getState().checkForUpdates({ silent: true })

    expect(check).not.toHaveBeenCalled()
    expect(useUpdateStore.getState().status).toBe('idle')
  })

  it('honors disabling automatic updates during the startup delay', async () => {
    vi.useFakeTimers()
    try {
      vi.resetModules()
      const { useSettingsStore } = await import('./settingsStore')
      useSettingsStore.setState({ autoUpdateEnabled: true })
      const { useUpdateStore } = await import('./updateStore')
      const startup = useUpdateStore.getState().initialize()

      useSettingsStore.setState({ autoUpdateEnabled: false })
      await vi.advanceTimersByTimeAsync(5000)
      await startup

      expect(check).not.toHaveBeenCalled()
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('starts a fresh automatic check when re-enabled after a skipped startup check', async () => {
    vi.useFakeTimers()
    try {
      check.mockResolvedValue(null)
      vi.resetModules()
      const { useSettingsStore } = await import('./settingsStore')
      const { useUpdateStore } = await import('./updateStore')
      const firstStartup = useUpdateStore.getState().initialize()
      useSettingsStore.setState({ autoUpdateEnabled: false })
      await vi.advanceTimersByTimeAsync(5000)
      await firstStartup
      expect(check).not.toHaveBeenCalled()

      useSettingsStore.setState({ autoUpdateEnabled: true })
      const nextStartup = useUpdateStore.getState().initialize()
      const duplicateStartup = useUpdateStore.getState().initialize()
      await vi.advanceTimersByTimeAsync(5000)
      await Promise.all([nextStartup, duplicateStartup])

      expect(check).toHaveBeenCalledTimes(1)
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('keeps manual checking and explicit installation available with automatic updates disabled', async () => {
    vi.useFakeTimers()
    try {
      const download = vi.fn().mockResolvedValue(undefined)
      const install = vi.fn().mockResolvedValue(undefined)
      check.mockResolvedValue({ version: '0.2.0', download, install, close: vi.fn() })
      vi.resetModules()
      const { useSettingsStore } = await import('./settingsStore')
      useSettingsStore.setState({ autoUpdateEnabled: false })
      const { useUpdateStore } = await import('./updateStore')

      await useUpdateStore.getState().checkForUpdates()

      expect(check).toHaveBeenCalledTimes(1)
      expect(download).not.toHaveBeenCalled()
      expect(useUpdateStore.getState().status).toBe('available')
      expect(useUpdateStore.getState().shouldPrompt).toBe(false)

      await useUpdateStore.getState().installUpdate()

      expect(download).toHaveBeenCalledTimes(1)
      expect(install).toHaveBeenCalledTimes(1)
      expect(relaunch).toHaveBeenCalledTimes(1)
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('does not start a background download if automatic updates are disabled while checking', async () => {
    const download = vi.fn().mockResolvedValue(undefined)
    let resolveCheck!: (update: unknown) => void
    check.mockImplementation(() => new Promise(resolve => { resolveCheck = resolve }))
    vi.resetModules()
    const { useSettingsStore } = await import('./settingsStore')
    useSettingsStore.setState({ autoUpdateEnabled: true })
    const { useUpdateStore } = await import('./updateStore')
    const checking = useUpdateStore.getState().checkForUpdates({ silent: true })

    useSettingsStore.setState({ autoUpdateEnabled: false })
    resolveCheck({ version: '0.2.0', download, close: vi.fn() })
    await checking

    expect(download).not.toHaveBeenCalled()
    expect(useUpdateStore.getState().shouldPrompt).toBe(false)
  })

  it('keeps a finishing download quiet when automatic updates have been disabled', async () => {
    let finishDownload!: () => void
    const download = vi.fn(() => new Promise<void>(resolve => { finishDownload = resolve }))
    check.mockResolvedValue({ version: '0.2.0', download, close: vi.fn() })
    vi.resetModules()
    const { useSettingsStore } = await import('./settingsStore')
    useSettingsStore.setState({ autoUpdateEnabled: true })
    const { useUpdateStore } = await import('./updateStore')
    await useUpdateStore.getState().checkForUpdates({ silent: true })
    const downloading = useUpdateStore.getState().downloadUpdate()

    useSettingsStore.setState({ autoUpdateEnabled: false })
    finishDownload()
    await downloading

    expect(useUpdateStore.getState().status).toBe('downloaded')
    expect(useUpdateStore.getState().shouldPrompt).toBe(false)
  })

  it.each(['rejected', 'watchdog'] as const)('retries a %s restart through the real Electron host and updater without losing its download', async (failure) => {
    vi.useFakeTimers()
    try {
      const updater: ElectronUpdaterLike = {
        autoDownload: true,
        autoInstallOnAppQuit: true,
        checkForUpdates: vi.fn(async () => ({ updateInfo: { version: '0.2.0' } })),
        downloadUpdate: vi.fn(async () => {}),
        quitAndInstall: vi.fn(),
        on: () => updater,
        off: () => updater,
      }
      const service = new ElectronUpdaterService(updater)
      let downloadHandler: ((event: DesktopUpdateDownloadEvent) => void) | null = null
      let firstRelaunch = true
      window.desktopHost = createElectronHost({
        async invoke<T>(channel: ElectronIpcChannel) {
          let result: unknown
          switch (channel) {
            case ELECTRON_IPC_CHANNELS.appGetVersion: result = '0.1.0'; break
            case ELECTRON_IPC_CHANNELS.updateCheck: result = await service.checkForUpdates(); break
            case ELECTRON_IPC_CHANNELS.updateDownload:
              await service.downloadUpdate(event => downloadHandler?.(event))
              break
            case ELECTRON_IPC_CHANNELS.updateInstall: service.stageDownloadedUpdate(); break
            case ELECTRON_IPC_CHANNELS.updateCancelInstall: service.cancelInstall(); break
            case ELECTRON_IPC_CHANNELS.updatePrepareInstall: break
            case ELECTRON_IPC_CHANNELS.runtimeGetServerUrl: result = 'http://127.0.0.1:3456'; break
            case ELECTRON_IPC_CHANNELS.updateRelaunch:
              if (firstRelaunch) {
                firstRelaunch = false
                if (failure === 'rejected') throw new Error('fixture restart failed')
                break
              }
              service.quitAndInstallDownloadedUpdate({})
              break
            default: throw new Error(`Unexpected fixture IPC: ${channel}`)
          }
          return result as T
        },
        async subscribe(_channel, handler) {
          downloadHandler = handler as (event: DesktopUpdateDownloadEvent) => void
          return () => { downloadHandler = null }
        },
      })
      vi.resetModules()
      const { useUpdateStore } = await import('./updateStore')
      await useUpdateStore.getState().checkForUpdates()
      await useUpdateStore.getState().downloadUpdate()
      await useUpdateStore.getState().installUpdate()
      if (failure === 'watchdog') await vi.advanceTimersByTimeAsync(15_000)

      expect(useUpdateStore.getState().status).toBe('downloaded')
      expect(useUpdateStore.getState().error).toContain(failure === 'rejected'
        ? 'fixture restart failed'
        : 'Try installing the update again')
      expect(service.hasStagedUpdate()).toBe(false)
      expect(service.hasDownloadedUpdate()).toBe(true)

      await useUpdateStore.getState().installUpdate()

      expect(useUpdateStore.getState().status).toBe('restarting')
      expect(updater.downloadUpdate).toHaveBeenCalledTimes(1)
      expect(updater.quitAndInstall).toHaveBeenCalledTimes(1)
      expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true)
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('prompts again when a newer version is available after dismissing an older one', async () => {
    const oldDownload = vi.fn(async (onEvent?: (event: unknown) => void) => {
      onEvent?.({ event: 'Started', data: { contentLength: 100 } })
      onEvent?.({ event: 'Finished' })
    })
    const newDownload = vi.fn(async (onEvent?: (event: unknown) => void) => {
      onEvent?.({ event: 'Started', data: { contentLength: 100 } })
      onEvent?.({ event: 'Finished' })
    })
    check
      .mockResolvedValueOnce({
        version: '0.2.0',
        body: 'Bug fixes and performance improvements',
        download: oldDownload,
        close: vi.fn().mockResolvedValue(undefined),
      })
      .mockResolvedValueOnce({
        version: '0.3.0',
        body: 'New release',
        download: newDownload,
        close: vi.fn().mockResolvedValue(undefined),
      })

    vi.resetModules()
    const { useUpdateStore } = await import('./updateStore')

    await useUpdateStore.getState().checkForUpdates()
    useUpdateStore.getState().dismissPrompt()
    await useUpdateStore.getState().checkForUpdates({ silent: true })

    expect(useUpdateStore.getState().availableVersion).toBe('0.3.0')
    await Promise.resolve()
    expect(useUpdateStore.getState().status).toBe('downloaded')
    expect(useUpdateStore.getState().shouldPrompt).toBe(true)
  })

  it('checks and downloads when manual download starts without a pending update', async () => {
    const download = vi.fn(async (onEvent?: (event: unknown) => void) => {
      onEvent?.({ event: 'Started', data: { contentLength: 100 } })
      onEvent?.({ event: 'Finished' })
    })
    check.mockResolvedValue({
      version: '0.2.0',
      body: 'Notes',
      download,
      close: vi.fn().mockResolvedValue(undefined),
    })

    vi.resetModules()
    const { useUpdateStore } = await import('./updateStore')

    await useUpdateStore.getState().downloadUpdate()

    expect(check).toHaveBeenCalledTimes(1)
    expect(download).toHaveBeenCalledTimes(1)
    expect(useUpdateStore.getState().status).toBe('downloaded')
    expect(useUpdateStore.getState().shouldPrompt).toBe(true)
  })

  it('does not download again when the pending update is already downloaded', async () => {
    const download = vi.fn(async (onEvent?: (event: unknown) => void) => {
      onEvent?.({ event: 'Started', data: { contentLength: 100 } })
      onEvent?.({ event: 'Finished' })
    })
    check.mockResolvedValue({
      version: '0.2.0',
      body: 'Notes',
      download,
      close: vi.fn().mockResolvedValue(undefined),
    })

    vi.resetModules()
    const { useUpdateStore } = await import('./updateStore')

    await useUpdateStore.getState().checkForUpdates()
    await useUpdateStore.getState().downloadUpdate()

    expect(download).toHaveBeenCalledTimes(1)
    expect(useUpdateStore.getState().status).toBe('downloaded')
    expect(useUpdateStore.getState().progressPercent).toBe(100)
  })

  it('reuses an in-flight manual download', async () => {
    let finishDownload!: () => void
    const download = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishDownload = resolve
        }),
    )
    check.mockResolvedValue({
      version: '0.2.0',
      body: 'Notes',
      download,
      close: vi.fn().mockResolvedValue(undefined),
    })

    vi.resetModules()
    const { useUpdateStore } = await import('./updateStore')

    await useUpdateStore.getState().checkForUpdates({ autoDownload: false })
    const firstDownload = useUpdateStore.getState().downloadUpdate()
    await Promise.resolve()
    const secondDownload = useUpdateStore.getState().downloadUpdate()

    expect(download).toHaveBeenCalledTimes(1)

    finishDownload()
    await Promise.all([firstDownload, secondDownload])

    expect(useUpdateStore.getState().status).toBe('downloaded')
  })

  it('downloads in the background, then installs and relaunches without downloading again', async () => {
    const download = vi.fn(async (onEvent?: (event: unknown) => void) => {
      onEvent?.({ event: 'Started', data: { contentLength: 200 } })
      onEvent?.({ event: 'Progress', data: { chunkLength: 50 } })
      onEvent?.({ event: 'Progress', data: { chunkLength: 150 } })
      onEvent?.({ event: 'Finished' })
    })
    const install = vi.fn().mockResolvedValue(undefined)

    check.mockResolvedValue({
      version: '0.2.0',
      body: 'Notes',
      download,
      install,
      close: vi.fn().mockResolvedValue(undefined),
    })
    invoke.mockResolvedValue(undefined)
    relaunch.mockResolvedValue(undefined)

    vi.resetModules()
    const { useUpdateStore } = await import('./updateStore')

    await useUpdateStore.getState().checkForUpdates()
    expect(useUpdateStore.getState().status).toBe('downloaded')
    expect(useUpdateStore.getState().shouldPrompt).toBe(true)
    await useUpdateStore.getState().installUpdate()

    expect(download).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('prepare_for_update_install')
    expect(install).toHaveBeenCalledTimes(1)
    const prepareCallOrder = invoke.mock.invocationCallOrder[0]
    const installCallOrder = install.mock.invocationCallOrder[0]
    expect(prepareCallOrder).toBeDefined()
    expect(installCallOrder).toBeDefined()
    expect(prepareCallOrder!).toBeLessThan(installCallOrder!)
    expect(useUpdateStore.getState().progressPercent).toBe(100)
    expect(useUpdateStore.getState().status).toBe('restarting')
    expect(relaunch).toHaveBeenCalledTimes(1)
  })

  it('recovers if the relaunch request returns but the app stays alive', async () => {
    vi.useFakeTimers()
    try {
      const download = vi.fn(async (onEvent?: (event: unknown) => void) => {
        onEvent?.({ event: 'Started', data: { contentLength: 100 } })
        onEvent?.({ event: 'Finished' })
      })
      const install = vi.fn().mockResolvedValue(undefined)
      const prepareInstall = vi.fn().mockResolvedValue(undefined)
      const cancelInstall = vi.fn().mockResolvedValue(undefined)
      const relaunchHost = vi.fn().mockResolvedValue(undefined)
      const getServerUrl = vi.fn().mockResolvedValue('http://127.0.0.1:3456')

      window.desktopHost = {
        ...browserHost,
        kind: 'electron',
        isDesktop: true,
        capabilities: {
          ...browserHost.capabilities,
          updates: true,
        },
        runtime: {
          ...browserHost.runtime,
          getServerUrl,
        },
        updates: {
          ...browserHost.updates,
          check: vi.fn().mockResolvedValue({
            version: '0.4.0',
            body: 'Electron host update',
            download,
            install,
            close: vi.fn().mockResolvedValue(undefined),
          }),
          prepareInstall,
          cancelInstall,
          relaunch: relaunchHost,
        },
      }

      vi.resetModules()
      const { useUpdateStore } = await import('./updateStore')

      await useUpdateStore.getState().checkForUpdates()
      await useUpdateStore.getState().installUpdate()

      expect(useUpdateStore.getState().status).toBe('restarting')
      await vi.advanceTimersByTimeAsync(15_000)

      expect(relaunchHost).toHaveBeenCalledTimes(1)
      expect(cancelInstall).toHaveBeenCalledTimes(1)
      expect(getServerUrl).toHaveBeenCalledTimes(1)
      expect(useUpdateStore.getState().status).toBe('downloaded')
      expect(useUpdateStore.getState().error).toContain('Restart did not start automatically')
      expect(useUpdateStore.getState().shouldPrompt).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('refreshes the pending update when the proxy changes before install', async () => {
    const staleClose = vi.fn().mockResolvedValue(undefined)
    const freshDownload = vi.fn(async (onEvent?: (event: unknown) => void) => {
      onEvent?.({ event: 'Started', data: { contentLength: 100 } })
      onEvent?.({ event: 'Progress', data: { chunkLength: 100 } })
      onEvent?.({ event: 'Finished' })
    })
    const freshInstall = vi.fn().mockResolvedValue(undefined)

    check
      .mockResolvedValueOnce({
        version: '0.2.0',
        body: 'Notes',
        close: staleClose,
      })
      .mockResolvedValueOnce({
        version: '0.2.0',
        body: 'Notes',
        download: freshDownload,
        install: freshInstall,
        close: vi.fn().mockResolvedValue(undefined),
      })
    invoke.mockResolvedValue(undefined)
    relaunch.mockResolvedValue(undefined)

    vi.resetModules()
    const { useSettingsStore } = await import('./settingsStore')
    const { useUpdateStore } = await import('./updateStore')

    await useUpdateStore.getState().checkForUpdates()
    useSettingsStore.setState({
      updateProxy: {
        mode: 'manual',
        url: 'http://127.0.0.1:7890',
      },
    })
    await useUpdateStore.getState().installUpdate()

    expect(staleClose).toHaveBeenCalledTimes(1)
    expect(check).toHaveBeenNthCalledWith(2, { proxy: 'http://127.0.0.1:7890' })
    expect(freshDownload).toHaveBeenCalledTimes(1)
    expect(freshInstall).toHaveBeenCalledTimes(1)
  })

  it('does not publish update-ready when the proxy changes during download', async () => {
    let finishDownload!: () => void
    const download = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishDownload = resolve
        }),
    )
    check.mockResolvedValue({
      version: '0.2.0',
      body: 'Notes',
      download,
      close: vi.fn().mockResolvedValue(undefined),
    })

    vi.resetModules()
    const { useSettingsStore } = await import('./settingsStore')
    const { useUpdateStore } = await import('./updateStore')

    await useUpdateStore.getState().checkForUpdates()
    useSettingsStore.setState({
      updateProxy: {
        mode: 'manual',
        url: 'http://127.0.0.1:7890',
      },
    })
    finishDownload()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useUpdateStore.getState().status).toBe('available')
    expect(useUpdateStore.getState().shouldPrompt).toBe(false)
  })

  it('keeps the update available and retryable when background download fails', async () => {
    const download = vi
      .fn()
      .mockRejectedValueOnce(new Error('network dropped'))
      .mockResolvedValueOnce(undefined)

    check.mockResolvedValue({
      version: '0.2.0',
      body: 'Notes',
      download,
      install: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    })

    vi.resetModules()
    const { useUpdateStore } = await import('./updateStore')

    await useUpdateStore.getState().checkForUpdates()
    await Promise.resolve()
    await Promise.resolve()

    expect(download).toHaveBeenCalledTimes(1)
    expect(useUpdateStore.getState().status).toBe('available')
    expect(useUpdateStore.getState().error).toContain('network dropped')
    expect(useUpdateStore.getState().shouldPrompt).toBe(false)

    await useUpdateStore.getState().downloadUpdate()

    expect(download).toHaveBeenCalledTimes(2)
    expect(useUpdateStore.getState().status).toBe('downloaded')
    expect(useUpdateStore.getState().shouldPrompt).toBe(true)
  })

  it('clears the native exit guard when install fails after sidecars stop', async () => {
    const download = vi.fn(async (onEvent?: (event: unknown) => void) => {
      onEvent?.({ event: 'Started', data: { contentLength: 100 } })
      onEvent?.({ event: 'Finished' })
    })
    const install = vi.fn().mockRejectedValue(new Error('installer failed'))

    check.mockResolvedValue({
      version: '0.2.0',
      body: 'Notes',
      download,
      install,
      close: vi.fn().mockResolvedValue(undefined),
    })
    invoke.mockResolvedValue(undefined)

    vi.resetModules()
    const { useUpdateStore } = await import('./updateStore')

    await useUpdateStore.getState().checkForUpdates()
    await useUpdateStore.getState().installUpdate()

    expect(invoke).toHaveBeenNthCalledWith(1, 'prepare_for_update_install')
    expect(invoke).toHaveBeenNthCalledWith(2, 'cancel_update_install')
    expect(useUpdateStore.getState().status).toBe('downloaded')
    expect(useUpdateStore.getState().error).toContain('installer failed')
    expect(useUpdateStore.getState().shouldPrompt).toBe(true)
  })
})
