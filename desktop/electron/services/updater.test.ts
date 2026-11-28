import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { ElectronUpdaterService, normalizeUpdateInfo, updaterSessionProxyConfig, type ElectronUpdaterLike } from './updater'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function fakeUpdater(): ElectronUpdaterLike & {
  emitProgress(progress: { transferred?: number, total?: number }): void
  emitError(error: unknown): void
  progressListenerCount(): number
  checkForUpdates: ReturnType<typeof vi.fn>
  downloadUpdate: ReturnType<typeof vi.fn>
  quitAndInstall: ReturnType<typeof vi.fn>
} {
  const progressHandlers = new Set<(progress: { transferred?: number, total?: number }) => void>()
  const errorHandlers = new Set<(error: unknown) => void>()
  const updater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
    on: vi.fn((event: string, handler: (...args: never[]) => void) => {
      if (event === 'download-progress') {
        progressHandlers.add(handler as (progress: { transferred?: number, total?: number }) => void)
      } else if (event === 'error') {
        errorHandlers.add(handler as (error: unknown) => void)
      }
      return updater
    }),
    off: vi.fn((event: string, handler: (...args: never[]) => void) => {
      if (event === 'download-progress') {
        progressHandlers.delete(handler as (progress: { transferred?: number, total?: number }) => void)
      } else if (event === 'error') {
        errorHandlers.delete(handler as (error: unknown) => void)
      }
      return updater
    }),
    emitProgress(progress: { transferred?: number, total?: number }) {
      for (const handler of progressHandlers) handler(progress)
    },
    emitError(error: unknown) {
      for (const handler of errorHandlers) handler(error)
    },
    progressListenerCount() {
      return progressHandlers.size
    },
  } as unknown as ElectronUpdaterLike & {
    emitProgress(progress: { transferred?: number, total?: number }): void
    emitError(error: unknown): void
    progressListenerCount(): number
    checkForUpdates: ReturnType<typeof vi.fn>
    downloadUpdate: ReturnType<typeof vi.fn>
    quitAndInstall: ReturnType<typeof vi.fn>
  }
  return updater
}

const updater = fakeUpdater()

describe('Electron updater service', () => {
  it('normalizes update metadata from electron-updater', () => {
    expect(normalizeUpdateInfo({ version: '1.2.3', releaseNotes: 'Notes' })).toEqual({
      version: '1.2.3',
      body: 'Notes',
    })
    expect(normalizeUpdateInfo({ version: '1.2.4', releaseNotes: [{ note: 'One' }, { note: 'Two' }] })).toEqual({
      version: '1.2.4',
      body: 'One\n\nTwo',
    })
    expect(normalizeUpdateInfo(undefined)).toBeNull()
  })

  it('keeps electron-updater autoDownload disabled and emits store-compatible progress', async () => {
    updater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '1.2.3', body: 'Fixes' } })
    updater.downloadUpdate.mockImplementation(async () => {
      updater.emitProgress({ transferred: 40, total: 100 })
      updater.emitProgress({ transferred: 100, total: 100 })
    })
    const service = new ElectronUpdaterService(updater)
    const events: unknown[] = []

    await expect(service.checkForUpdates()).resolves.toEqual({ version: '1.2.3', body: 'Fixes' })
    await service.downloadUpdate(event => events.push(event))

    expect(updater.autoDownload).toBe(false)
    expect(updater.logger).toBeNull()
    expect(events).toEqual([
      { event: 'Started', data: { contentLength: 100 } },
      { event: 'Progress', data: { chunkLength: 40 } },
      { event: 'Progress', data: { chunkLength: 60 } },
      { event: 'Finished' },
    ])
  })

  it('treats missing unpacked app update metadata as no update', async () => {
    const service = new ElectronUpdaterService(updater)
    updater.checkForUpdates.mockRejectedValueOnce(Object.assign(new Error("ENOENT: no such file or directory, open '/App/Contents/Resources/app-update.yml'"), {
      code: 'ENOENT',
      path: '/App/Contents/Resources/app-update.yml',
    }))

    await expect(service.checkForUpdates()).resolves.toBeNull()
  })

  it('skips electron-updater when packaged update config is absent', async () => {
    const localUpdater = fakeUpdater()
    const tempDir = mkdtempSync(join(tmpdir(), 'cc-haha-updater-'))
    try {
      const service = new ElectronUpdaterService(localUpdater, undefined, {
        updateConfigPath: join(tempDir, 'app-update.yml'),
      })

      await expect(service.checkForUpdates()).resolves.toBeNull()

      expect(localUpdater.checkForUpdates).not.toHaveBeenCalled()
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('treats missing GitHub channel metadata as no update', async () => {
    const service = new ElectronUpdaterService(updater)
    updater.checkForUpdates.mockRejectedValueOnce(Object.assign(
      new Error('Cannot find latest-mac.yml in the latest release artifacts (https://github.com/NanmiCoder/cc-haha/releases/download/v0.3.2/latest-mac.yml): HttpError: 404'),
      { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' },
    ))

    await expect(service.checkForUpdates()).resolves.toBeNull()
  })

  it('treats missing GitHub channel metadata as no update even without an error code', async () => {
    const service = new ElectronUpdaterService(updater)
    updater.checkForUpdates.mockRejectedValueOnce(
      new Error('Cannot find latest-mac.yml in the latest release artifacts (https://github.com/NanmiCoder/cc-haha/releases/download/v0.3.2/latest-mac.yml): HttpError: 404'),
    )

    await expect(service.checkForUpdates()).resolves.toBeNull()
  })

  it('treats stringified missing GitHub channel metadata as no update', async () => {
    const service = new ElectronUpdaterService(updater)
    updater.checkForUpdates.mockRejectedValueOnce(
      'Error: Cannot find latest-mac.yml in the latest release artifacts (https://github.com/NanmiCoder/cc-haha/releases/download/v0.3.2/latest-mac.yml): HttpError: 404',
    )

    await expect(service.checkForUpdates()).resolves.toBeNull()
  })

  it('applies manual updater proxy before checking and clears it when returning to system proxy', async () => {
    const localUpdater = fakeUpdater()
    const proxyController = {
      apply: vi.fn().mockResolvedValue(undefined),
    }
    localUpdater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '1.2.5' } })
    const service = new ElectronUpdaterService(localUpdater, proxyController)

    await service.checkForUpdates({ proxy: 'http://127.0.0.1:7890' })
    await service.checkForUpdates({ proxy: 'http://127.0.0.1:7890' })
    await service.checkForUpdates()

    expect(proxyController.apply).toHaveBeenNthCalledWith(1, 'http://127.0.0.1:7890')
    expect(proxyController.apply).toHaveBeenNthCalledWith(2, null)
    expect(proxyController.apply).toHaveBeenCalledTimes(2)
    expect(localUpdater.checkForUpdates).toHaveBeenCalledTimes(3)
  })

  it('disables differential download so update downloads run at full bandwidth', () => {
    const localUpdater = fakeUpdater()

    void new ElectronUpdaterService(localUpdater)

    expect(localUpdater.disableDifferentialDownload).toBe(true)
  })

  it('maps proxy settings to the updater net session proxy config', () => {
    expect(updaterSessionProxyConfig(null)).toEqual({ mode: 'system' })
    expect(updaterSessionProxyConfig('http://127.0.0.1:7890')).toEqual({
      proxyRules: 'http://127.0.0.1:7890',
      proxyBypassRules: '<local>',
    })
  })

  it('does not hide non-metadata updater failures', async () => {
    const service = new ElectronUpdaterService(updater)
    updater.checkForUpdates.mockRejectedValueOnce(new Error('feed unavailable'))

    await expect(service.checkForUpdates()).rejects.toThrow('feed unavailable')
  })

  it('does not offer metadata that electron-updater marks unavailable', async () => {
    const localUpdater = fakeUpdater()
    // A release can be newer but unavailable due to its minimum OS version
    // or staged rollout. electron-updater still returns its metadata.
    localUpdater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: false,
      updateInfo: { version: '9.9.9', body: 'Not eligible for this installation' },
    })
    const service = new ElectronUpdaterService(localUpdater)

    await expect(service.checkForUpdates()).resolves.toBeNull()
    await expect(service.downloadUpdate(() => {})).rejects.toThrow('No Electron update')
    expect(localUpdater.downloadUpdate).not.toHaveBeenCalled()
  })

  it('offers metadata that electron-updater explicitly marks available', async () => {
    const localUpdater = fakeUpdater()
    localUpdater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { version: '1.2.4', body: 'Eligible update' },
    })
    const service = new ElectronUpdaterService(localUpdater)

    await expect(service.checkForUpdates()).resolves.toEqual({ version: '1.2.4', body: 'Eligible update' })
    await service.downloadUpdate(() => {})
    expect(localUpdater.downloadUpdate).toHaveBeenCalledTimes(1)
  })

  it('stages then installs through quitAndInstall only after an update has downloaded', async () => {
    const service = new ElectronUpdaterService(updater)
    updater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '1.2.4' } })
    updater.downloadUpdate.mockResolvedValue(undefined)

    expect(() => service.stageDownloadedUpdate()).toThrow('No Electron update is ready')
    await service.checkForUpdates()
    expect(() => service.stageDownloadedUpdate()).toThrow('has not finished downloading')
    await service.downloadUpdate(() => {})
    service.stageDownloadedUpdate()
    service.quitAndInstallDownloadedUpdate()

    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  it('keeps ordinary quits and cached-download restarts from installing an update', async () => {
    const install = vi.fn()
    const cache = { downloaded: false }
    for (let restart = 0; restart < 3; restart += 1) {
      const app = new EventEmitter()
      const localUpdater = fakeUpdater()
      localUpdater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '1.2.4' } })
      localUpdater.downloadUpdate.mockImplementation(async () => {
        cache.downloaded = true
        // BaseUpdater registers this after either a fresh or cached download.
        app.once('quit', () => {
          if (localUpdater.autoInstallOnAppQuit && cache.downloaded) install()
        })
      })
      const service = new ElectronUpdaterService(localUpdater)
      await service.checkForUpdates()
      await service.downloadUpdate(() => {})
      app.emit('quit')
    }

    expect(cache.downloaded).toBe(true)
    expect(install).not.toHaveBeenCalled()
  })

  it('requires an explicit install request before the downloaded update may restart into installation', async () => {
    const localUpdater = fakeUpdater()
    localUpdater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '1.2.4' } })
    localUpdater.downloadUpdate.mockResolvedValue(undefined)
    const service = new ElectronUpdaterService(localUpdater)
    await service.checkForUpdates()
    await service.downloadUpdate(() => {})

    expect(service.hasStagedUpdate()).toBe(false)
    expect(() => service.quitAndInstallDownloadedUpdate({})).toThrow('has not been requested')
    expect(localUpdater.quitAndInstall).not.toHaveBeenCalled()

    service.stageDownloadedUpdate()
    expect(service.hasStagedUpdate()).toBe(true)
    service.quitAndInstallDownloadedUpdate({})

    expect(localUpdater.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(localUpdater.quitAndInstall).toHaveBeenCalledWith(false, true)
    expect(localUpdater.autoInstallOnAppQuit).toBe(false)
  })

  it('disarms canceled installs while keeping the download available for an explicit retry', async () => {
    const localUpdater = fakeUpdater()
    localUpdater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '1.2.4' } })
    localUpdater.downloadUpdate.mockResolvedValue(undefined)
    const service = new ElectronUpdaterService(localUpdater)
    await service.checkForUpdates()
    await service.downloadUpdate(() => {})
    service.stageDownloadedUpdate()
    service.cancelInstall()

    expect(service.hasDownloadedUpdate()).toBe(true)
    expect(service.hasStagedUpdate()).toBe(false)
    expect(() => service.quitAndInstallDownloadedUpdate({})).toThrow('has not been requested')

    await service.downloadUpdate(() => {})
    service.stageDownloadedUpdate()
    service.quitAndInstallDownloadedUpdate({})

    expect(localUpdater.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(localUpdater.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('does not carry install consent over to a newly checked version', async () => {
    const localUpdater = fakeUpdater()
    localUpdater.checkForUpdates
      .mockResolvedValueOnce({ updateInfo: { version: '1.2.4' } })
      .mockResolvedValueOnce({ updateInfo: { version: '1.2.5' } })
    localUpdater.downloadUpdate.mockResolvedValue(undefined)
    const service = new ElectronUpdaterService(localUpdater)
    await service.checkForUpdates()
    await service.downloadUpdate(() => {})
    service.stageDownloadedUpdate()
    await service.checkForUpdates()
    await service.downloadUpdate(() => {})

    expect(service.hasStagedUpdate()).toBe(false)
    expect(() => service.quitAndInstallDownloadedUpdate({})).toThrow('has not been requested')
    expect(localUpdater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('hands the spawned installer an environment without the app-managed portable selection', async () => {
    const service = new ElectronUpdaterService(updater)
    updater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '1.2.4' } })
    updater.downloadUpdate.mockResolvedValue(undefined)
    await service.checkForUpdates()
    await service.downloadUpdate(() => {})
    service.stageDownloadedUpdate()

    const env: NodeJS.ProcessEnv = {
      CLAUDE_CONFIG_DIR: 'E:\\cc-haha-data',
      CC_HAHA_APP_PORTABLE_DIR: '1',
      WEBVIEW2_USER_DATA_FOLDER: 'E:\\cc-haha-data\\EBWebView',
      APPDATA: 'C:\\Users\\someone\\AppData\\Roaming',
    }
    service.quitAndInstallDownloadedUpdate(env)

    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true)
    expect(env).toEqual({ APPDATA: 'C:\\Users\\someone\\AppData\\Roaming' })
  })

  it('leaves an externally supplied CLAUDE_CONFIG_DIR untouched when installing', async () => {
    const service = new ElectronUpdaterService(updater)
    updater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '1.2.4' } })
    updater.downloadUpdate.mockResolvedValue(undefined)
    await service.checkForUpdates()
    await service.downloadUpdate(() => {})
    service.stageDownloadedUpdate()

    const env: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: 'E:\\external-data' }
    service.quitAndInstallDownloadedUpdate(env)

    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true)
    expect(env).toEqual({ CLAUDE_CONFIG_DIR: 'E:\\external-data' })
  })

  it('coalesces concurrent downloadUpdate callers and replays progress snapshot to late subscribers', async () => {
    const localUpdater = fakeUpdater()
    let finishDownload!: () => void
    localUpdater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '1.2.4', body: 'Fixes' } })
    localUpdater.downloadUpdate.mockImplementation(
      () => new Promise<void>(resolve => { finishDownload = resolve }),
    )
    const service = new ElectronUpdaterService(localUpdater)
    await service.checkForUpdates()

    const firstEvents: unknown[] = []
    const secondEvents: unknown[] = []
    const firstDownload = service.downloadUpdate(event => firstEvents.push(event))

    localUpdater.emitProgress({ transferred: 40, total: 100 })

    // A second caller joins mid-download (e.g. after renderer reload or concurrent trigger).
    const secondDownload = service.downloadUpdate(event => secondEvents.push(event))
    expect(secondEvents).toEqual([
      { event: 'Started', data: { contentLength: 100 } },
      { event: 'Progress', data: { chunkLength: 40 } },
    ])

    localUpdater.emitProgress({ transferred: 100, total: 100 })
    finishDownload()
    await Promise.all([firstDownload, secondDownload])

    expect(localUpdater.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(firstEvents).toEqual([
      { event: 'Started', data: { contentLength: 100 } },
      { event: 'Progress', data: { chunkLength: 40 } },
      { event: 'Progress', data: { chunkLength: 60 } },
      { event: 'Finished' },
    ])
    expect(secondEvents).toEqual([
      { event: 'Started', data: { contentLength: 100 } },
      { event: 'Progress', data: { chunkLength: 40 } },
      { event: 'Progress', data: { chunkLength: 60 } },
      { event: 'Finished' },
    ])
  })

  it('preserves an in-flight download when checkForUpdates is called again with the same proxy', async () => {
    const localUpdater = fakeUpdater()
    let finishDownload!: () => void
    localUpdater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '1.2.4', body: 'Fixes' } })
    localUpdater.downloadUpdate.mockImplementation(
      () => new Promise<void>(resolve => { finishDownload = resolve }),
    )
    const service = new ElectronUpdaterService(localUpdater)
    await service.checkForUpdates()
    const downloading = service.downloadUpdate(() => {})

    const rechecked = await service.checkForUpdates()
    expect(rechecked).toEqual({ version: '1.2.4', body: 'Fixes' })
    expect(localUpdater.checkForUpdates).toHaveBeenCalledTimes(1)

    finishDownload()
    await downloading
    expect(service.hasDownloadedUpdate()).toBe(true)
  })

  it('records sanitized lifecycle diagnostics without exposing manual proxy credentials', async () => {
    const localUpdater = fakeUpdater()
    const logs: string[] = []
    localUpdater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '1.2.5', body: 'Fixes' } })
    localUpdater.downloadUpdate.mockImplementation(async () => {
      localUpdater.emitProgress({ transferred: 50, total: 100 })
      localUpdater.emitProgress({ transferred: 100, total: 100 })
    })
    const proxyController = { apply: vi.fn().mockResolvedValue(undefined) }
    const service = new ElectronUpdaterService(localUpdater, proxyController, {
      log: message => logs.push(message),
    })

    await service.checkForUpdates({ proxy: 'http://user:super-secret@127.0.0.1:7890' })
    await service.downloadUpdate(() => {})
    service.stageDownloadedUpdate()
    service.quitAndInstallDownloadedUpdate({})

    const combined = logs.join('\n')
    expect(combined).toContain('check_start')
    expect(combined).toContain('check_available version=1.2.5')
    expect(combined).toContain('download_start version=1.2.5')
    expect(combined).toContain('download_complete version=1.2.5')
    expect(combined).toContain('stage_install version=1.2.5')
    expect(combined).toContain('quit_and_install version=1.2.5')
    expect(combined).not.toContain('super-secret')
    expect(combined).not.toContain('127.0.0.1:7890')
  })

  it('replaces an existing subscriber with the same subscriberKey so renderer reload does not double progress', async () => {
    const localUpdater = fakeUpdater()
    let finishDownload!: () => void
    localUpdater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '1.2.4', body: 'Fixes' } })
    localUpdater.downloadUpdate.mockImplementation(
      () => new Promise<void>(resolve => { finishDownload = resolve }),
    )
    const service = new ElectronUpdaterService(localUpdater)
    await service.checkForUpdates()

    // Simulate a single webContents event channel receiving events across a reload.
    const webContentsChannel: unknown[] = []
    const firstDownload = service.downloadUpdate(
      event => webContentsChannel.push(event),
      { subscriberKey: 'webContents:1' },
    )
    localUpdater.emitProgress({ transferred: 40, total: 100 })

    // Renderer reloads and re-subscribes on the same webContents id.
    webContentsChannel.length = 0
    const reloadedDownload = service.downloadUpdate(
      event => webContentsChannel.push(event),
      { subscriberKey: 'webContents:1' },
    )
    localUpdater.emitProgress({ transferred: 100, total: 100 })
    finishDownload()
    await Promise.all([firstDownload, reloadedDownload])

    // Exactly one replay + one remaining chunk + one Finished (no 2x duplication).
    expect(webContentsChannel).toEqual([
      { event: 'Started', data: { contentLength: 100 } },
      { event: 'Progress', data: { chunkLength: 40 } },
      { event: 'Progress', data: { chunkLength: 60 } },
      { event: 'Finished' },
    ])
  })

  it('waits for a superseded download instead of double-listening or marking a newer proxy check as downloaded', async () => {
    const localUpdater = fakeUpdater()
    let finishFirstDownload!: () => void
    let finishSecondDownload!: () => void
    localUpdater.checkForUpdates
      .mockResolvedValueOnce({ updateInfo: { version: '1.2.4', body: 'Old' } })
      .mockResolvedValueOnce({ updateInfo: { version: '1.2.5', body: 'New' } })
    localUpdater.downloadUpdate
      .mockImplementationOnce(() => new Promise<void>(resolve => { finishFirstDownload = resolve }))
      .mockImplementationOnce(() => new Promise<void>(resolve => { finishSecondDownload = resolve }))

    const proxyController = { apply: vi.fn().mockResolvedValue(undefined) }
    const service = new ElectronUpdaterService(localUpdater, proxyController)
    await service.checkForUpdates()

    const firstDownload = service.downloadUpdate(() => {})
    expect(localUpdater.progressListenerCount()).toBe(1)

    // Switch proxy mid-download and discover a newer release.
    await service.checkForUpdates({ proxy: 'http://127.0.0.1:7890' })
    const secondEvents: unknown[] = []
    const secondDownload = service.downloadUpdate(event => secondEvents.push(event))

    // Must not register a second progress listener while the old download is still active.
    expect(localUpdater.progressListenerCount()).toBe(1)
    expect(localUpdater.downloadUpdate).toHaveBeenCalledTimes(1)

    // When the old download completes, it must NOT mark 1.2.5 as downloaded.
    finishFirstDownload()
    await firstDownload
    expect(service.hasDownloadedUpdate()).toBe(false)

    // The waiting caller now runs the fresh download for 1.2.5.
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(localUpdater.downloadUpdate).toHaveBeenCalledTimes(2)
    localUpdater.emitProgress({ transferred: 100, total: 100 })
    finishSecondDownload()
    await secondDownload

    expect(service.hasDownloadedUpdate()).toBe(true)
    expect(secondEvents).toEqual([
      { event: 'Started', data: { contentLength: 100 } },
      { event: 'Progress', data: { chunkLength: 100 } },
      { event: 'Finished' },
    ])
  })

  it('sanitizes proxy credentials and URL queries in error logs and captures async updater errors', async () => {
    const localUpdater = fakeUpdater()
    const logs: string[] = []
    const proxyController = { apply: vi.fn().mockResolvedValue(undefined) }
    const service = new ElectronUpdaterService(localUpdater, proxyController, {
      log: message => logs.push(message),
    })

    localUpdater.checkForUpdates.mockRejectedValueOnce(
      new Error('connect failed via socks5://alice:top-secret@proxy.internal:1080 to https://bob:cdn-pass@cdn.example.com/latest.yml?token=secret-query'),
    )
    await expect(service.checkForUpdates({ proxy: 'socks5://alice:top-secret@proxy.internal:1080' })).rejects.toThrow()

    localUpdater.emitError(new Error('Squirrel verify failed for https://user:pw@127.0.0.1:9999/update.zip?sig=leak'))

    const combined = logs.join('\n')
    expect(combined).toContain('check_error')
    expect(combined).toContain('updater_error')
    expect(combined).not.toContain('top-secret')
    expect(combined).not.toContain('alice')
    expect(combined).not.toContain('proxy.internal:1080')
    expect(combined).not.toContain('cdn-pass')
    expect(combined).not.toContain('secret-query')
    expect(combined).not.toContain('pw')
    expect(combined).not.toContain('sig=leak')
  })
})
