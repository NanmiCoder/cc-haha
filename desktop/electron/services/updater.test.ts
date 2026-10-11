import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { ElectronUpdaterService, normalizeUpdateInfo, updaterSessionProxyConfig, type ElectronUpdaterLike } from './updater'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function fakeUpdater(): ElectronUpdaterLike & {
  emitProgress(progress: { transferred?: number, total?: number }): void
  checkForUpdates: ReturnType<typeof vi.fn>
  downloadUpdate: ReturnType<typeof vi.fn>
  quitAndInstall: ReturnType<typeof vi.fn>
} {
  let progressHandler: ((progress: { transferred?: number, total?: number }) => void) | null = null
  const updater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
    on: vi.fn((_event, handler) => {
      progressHandler = handler
      return updater
    }),
    off: vi.fn((_event, handler) => {
      if (progressHandler === handler) progressHandler = null
      return updater
    }),
    emitProgress(progress) {
      progressHandler?.(progress)
    },
  } as ElectronUpdaterLike & {
    emitProgress(progress: { transferred?: number, total?: number }): void
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
})
