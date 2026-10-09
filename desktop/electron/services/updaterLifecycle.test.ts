import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { BaseUpdater } from 'electron-updater/out/BaseUpdater'
import { MacUpdater } from 'electron-updater/out/MacUpdater'
import type { AppAdapter } from 'electron-updater/out/AppAdapter'
import { ElectronUpdaterService, type ElectronUpdaterLike } from './updater'

function fixtureApp(root: string, events: EventEmitter): AppAdapter {
  return {
    version: '1.0.0',
    name: 'Updater fixture',
    isPackaged: true,
    appUpdateConfigPath: join(root, 'app-update.yml'),
    userDataPath: root,
    baseCachePath: root,
    whenReady: async () => {},
    relaunch: vi.fn(),
    quit: vi.fn(),
    onQuit: handler => { events.once('quit', handler) },
  }
}

// Keep the dependency's real quit handler, replacing only download transport
// and installer execution. These boundaries must never touch a real install.
class ExitUpdaterFixture extends BaseUpdater {
  install = vi.fn(() => true)

  constructor(app: AppAdapter) {
    super(undefined, app)
  }

  async checkForUpdates() {
    const updateInfo = { version: '1.2.4', files: [], releaseDate: '', path: 'fixture.exe', sha512: 'fixture' }
    return { isUpdateAvailable: true, updateInfo, versionInfo: updateInfo }
  }

  async downloadUpdate() {
    this.addQuitHandler()
    return []
  }

  protected async doDownloadUpdate() { return [] }
  protected doInstall() { return true }
}

describe('locked electron-updater lifecycle', () => {
  it('reproduces the upstream Windows/Linux default install on normal exit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'updater-exit-default-'))
    try {
      const events = new EventEmitter()
      const updater = new ExitUpdaterFixture(fixtureApp(root, events))
      updater.logger = null
      await updater.downloadUpdate()
      events.emit('quit', 0)

      expect(updater.install).toHaveBeenCalledWith(true, false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps the real exit hook disarmed across three updater instances and normal exits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'updater-exit-manual-'))
    try {
      for (let restart = 0; restart < 3; restart += 1) {
        const events = new EventEmitter()
        const updater = new ExitUpdaterFixture(fixtureApp(root, events))
        const service = new ElectronUpdaterService(updater)
        await service.checkForUpdates()
        await service.downloadUpdate(() => {})
        events.emit('quit', 0)

        expect(updater.install).not.toHaveBeenCalled()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps the macOS ZIP out of Squirrel until explicit installation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'updater-mac-manual-'))
    const archive = join(root, 'update.zip')
    writeFileSync(archive, 'fixture archive')
    const nativeEvents = new EventEmitter()
    let feed: { url: string, headers: Record<string, string> } | null = null
    let nativeDownload: Promise<void> | null = null
    const nativeUpdater = Object.assign(nativeEvents, {
      setFeedURL: vi.fn((next: NonNullable<typeof feed>) => { feed = next }),
      checkForUpdates: vi.fn(() => {
        nativeDownload = (async () => {
          const metadata = await fetch(feed!.url, { headers: feed!.headers })
          const { url } = await metadata.json() as { url: string }
          const response = await fetch(url)
          expect(await response.text()).toBe('fixture archive')
          nativeEvents.emit('update-downloaded')
        })()
      }),
      quitAndInstall: vi.fn(),
    })
    type MacFixture = ElectronUpdaterLike & {
      server?: Server
      squirrelDownloadedUpdate: boolean
      updateDownloaded(fileInfo: unknown, event: unknown): Promise<unknown>
      closeServerIfExists(): void
    }
    // Skip the constructor's require('electron') so this runs on every OS.
    // Download completion and quitAndInstall still use the locked dependency's
    // real implementation; only Squirrel itself is replaced with loopback I/O.
    const updater = Object.assign(Object.create(MacUpdater.prototype), {
      autoDownload: true,
      autoInstallOnAppQuit: true,
      autoRunAppAfterInstall: true,
      squirrelDownloadedUpdate: false,
      nativeUpdater,
      app: fixtureApp(root, new EventEmitter()),
      dispatchUpdateDownloaded: vi.fn(),
      checkForUpdates: vi.fn(async () => ({ updateInfo: { version: '1.2.4' } })),
    }) as MacFixture
    updater.downloadUpdate = vi.fn(() => updater.updateDownloaded({
      url: new URL('https://fixture.invalid/update.zip'),
      info: { size: Buffer.byteLength('fixture archive') },
    }, { downloadedFile: archive, version: '1.2.4' }))
    nativeEvents.on('update-downloaded', () => { updater.squirrelDownloadedUpdate = true })

    try {
      const service = new ElectronUpdaterService(updater)
      await service.checkForUpdates()
      await service.downloadUpdate(() => {})

      expect(nativeUpdater.setFeedURL).toHaveBeenCalledTimes(1)
      expect(nativeUpdater.checkForUpdates).not.toHaveBeenCalled()
      expect(nativeUpdater.quitAndInstall).not.toHaveBeenCalled()
      expect(service.hasStagedUpdate()).toBe(false)

      service.stageDownloadedUpdate()
      service.quitAndInstallDownloadedUpdate({})
      await nativeDownload

      expect(nativeUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
      expect(nativeUpdater.quitAndInstall).toHaveBeenCalledTimes(1)
    } finally {
      await nativeDownload
      if (updater.server?.listening) {
        await new Promise<void>(resolve => updater.server!.close(() => resolve()))
      }
      rmSync(root, { recursive: true, force: true })
    }
  })
})
