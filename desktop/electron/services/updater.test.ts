import { describe, expect, it, vi } from 'vitest'
import { ElectronUpdaterService, normalizeUpdateInfo, isNewerVersion, type ElectronUpdaterLike } from './updater'
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

  it('compares release versions, ignoring prerelease and build metadata', () => {
    expect(isNewerVersion('0.5.6', '0.5.5')).toBe(true)
    expect(isNewerVersion('1.0.0', '0.9.9')).toBe(true)
    expect(isNewerVersion('0.6.0', '0.5.9')).toBe(true)
    // Equal or older must not count as newer (the safe up-to-date direction).
    expect(isNewerVersion('0.5.5', '0.5.5')).toBe(false)
    expect(isNewerVersion('0.5.4', '0.5.5')).toBe(false)
    expect(isNewerVersion('v0.5.5', '0.5.5')).toBe(false)
    expect(isNewerVersion('0.5.5+abc123', '0.5.5')).toBe(false)
    expect(isNewerVersion('0.5.5-beta.1', '0.5.5')).toBe(false)
  })

  it('treats a feed version equal to the running version as no update', async () => {
    updater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '0.5.5', body: 'Same release' } })
    const service = new ElectronUpdaterService(updater, undefined, { currentVersion: '0.5.5' })

    await expect(service.checkForUpdates()).resolves.toBeNull()
    await expect(service.downloadUpdate(() => {})).rejects.toThrow(
      'No Electron update is available to download',
    )
  })

  it('treats a feed version older than the running version as no update', async () => {
    updater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '0.5.4' } })
    const service = new ElectronUpdaterService(updater, undefined, { currentVersion: '0.5.5' })

    await expect(service.checkForUpdates()).resolves.toBeNull()
  })

  it('surfaces a feed version newer than the running version as an update', async () => {
    updater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '0.5.6', body: 'New' } })
    const service = new ElectronUpdaterService(updater, undefined, { currentVersion: '0.5.5' })

    await expect(service.checkForUpdates()).resolves.toEqual({ version: '0.5.6', body: 'New' })
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

  it('does not hide non-metadata updater failures', async () => {
    const service = new ElectronUpdaterService(updater)
    updater.checkForUpdates.mockRejectedValueOnce(new Error('feed unavailable'))

    await expect(service.checkForUpdates()).rejects.toThrow('feed unavailable')
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
})
