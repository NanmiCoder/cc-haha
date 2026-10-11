import type { DesktopUpdateDownloadEvent } from '../../src/lib/desktopHost/types'
import { existsSync } from 'node:fs'
import { clearAppManagedPortableEnv } from './appMode'

export type ElectronUpdateInfo = {
  version: string
  body?: string | null
  releaseNotes?: string | Array<{ note?: string | null }> | null
}

export type ElectronUpdateCheckResult = {
  isUpdateAvailable?: boolean
  updateInfo?: ElectronUpdateInfo
} | null

export type ElectronUpdateCheckOptions = {
  proxy?: string
}

export type ElectronUpdaterLike = {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  disableDifferentialDownload?: boolean
  logger?: unknown
  checkForUpdates(): Promise<ElectronUpdateCheckResult>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
  on(event: 'download-progress', handler: (progress: { transferred?: number, total?: number }) => void): ElectronUpdaterLike
  off(event: 'download-progress', handler: (progress: { transferred?: number, total?: number }) => void): ElectronUpdaterLike
}

export type ElectronUpdateMetadata = {
  version: string
  body: string | null
}

export type ElectronUpdaterProxyController = {
  apply(proxy: string | null): Promise<void>
}

export type ElectronUpdaterRuntimeOptions = {
  updateConfigPath?: string
}

export type UpdaterSessionProxyConfig = {
  mode?: 'system'
  proxyRules?: string
  proxyBypassRules?: string
}

// electron-updater performs all update traffic (metadata + downloads) on its
// own session partition, so proxy settings must target that session. Passing
// an empty config would mean fixed_servers with no rules (= direct), so the
// system fallback has to be an explicit `mode: 'system'`.
export function updaterSessionProxyConfig(proxy: string | null): UpdaterSessionProxyConfig {
  return proxy
    ? { proxyRules: proxy, proxyBypassRules: '<local>' }
    : { mode: 'system' }
}

export function normalizeUpdateInfo(info: ElectronUpdateInfo | undefined): ElectronUpdateMetadata | null {
  if (!info?.version) return null
  const releaseNotes = Array.isArray(info.releaseNotes)
    ? info.releaseNotes.map(note => note.note).filter(Boolean).join('\n\n')
    : info.releaseNotes
  return {
    version: info.version,
    body: info.body ?? releaseNotes ?? null,
  }
}

function isMissingUpdateMetadataError(error: unknown): boolean {
  if (!error) return false
  const maybeError = typeof error === 'object'
    ? error as { code?: unknown, message?: unknown, path?: unknown }
    : {}
  const code = typeof maybeError.code === 'string' ? maybeError.code : ''
  const path = typeof maybeError.path === 'string' ? maybeError.path : ''
  const message = typeof maybeError.message === 'string' && maybeError.message
    ? maybeError.message
    : String(error)
  const referencesChannelMetadata = /latest(?:-[a-z0-9]+)?(?:-[a-z0-9]+)?\.ya?ml/i.test(message)
  if (code === 'ENOENT') {
    return path.endsWith('app-update.yml') || message.includes('app-update.yml')
  }
  if (code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND') {
    return referencesChannelMetadata
  }
  return referencesChannelMetadata && /cannot find|not found|404/i.test(message)
}

export class ElectronUpdaterService {
  private readonly updater: ElectronUpdaterLike
  private readonly proxyController?: ElectronUpdaterProxyController
  private readonly updateConfigPath?: string
  private pendingUpdate: ElectronUpdateMetadata | null = null
  private downloaded = false
  private installRequested = false
  private proxyKey: string | null = null

  constructor(
    updater: ElectronUpdaterLike,
    proxyController?: ElectronUpdaterProxyController,
    runtimeOptions: ElectronUpdaterRuntimeOptions = {},
  ) {
    this.updater = updater
    this.proxyController = proxyController
    this.updateConfigPath = runtimeOptions.updateConfigPath
    this.updater.autoDownload = false
    // Background downloads must stay pending after "Later", normal quits,
    // and app-mode restarts. On macOS this also keeps the ZIP out of Squirrel
    // until the user explicitly requests quitAndInstall.
    this.updater.autoInstallOnAppQuit = false
    // Differential download issues many small sequential range requests and is
    // RTT-bound against the GitHub CDN, so it downloads far below line speed.
    this.updater.disableDifferentialDownload = true
    this.updater.logger = null
  }

  private async applyProxy(options?: ElectronUpdateCheckOptions) {
    if (!this.proxyController) return

    const proxy = options?.proxy?.trim() || null
    const nextProxyKey = proxy ? `manual:${proxy}` : 'system'
    if (this.proxyKey === nextProxyKey) return

    await this.proxyController.apply(proxy)
    this.proxyKey = nextProxyKey
  }

  async checkForUpdates(options?: ElectronUpdateCheckOptions): Promise<ElectronUpdateMetadata | null> {
    this.installRequested = false
    let result: ElectronUpdateCheckResult
    try {
      await this.applyProxy(options)
      if (this.updateConfigPath && !existsSync(this.updateConfigPath)) {
        result = null
      } else {
        result = await this.updater.checkForUpdates()
      }
    } catch (error) {
      if (!isMissingUpdateMetadataError(error)) throw error
      result = null
    }
    this.pendingUpdate = result?.isUpdateAvailable === false ? null : normalizeUpdateInfo(result?.updateInfo)
    this.downloaded = false
    return this.pendingUpdate
  }

  async downloadUpdate(emit: (event: DesktopUpdateDownloadEvent) => void): Promise<void> {
    if (!this.pendingUpdate) {
      throw new Error('No Electron update is available to download')
    }
    if (this.downloaded) {
      emit({ event: 'Finished' })
      return
    }

    let lastTransferred = 0
    let started = false
    const onProgress = (progress: { transferred?: number, total?: number }) => {
      const transferred = Math.max(0, progress.transferred ?? 0)
      if (!started) {
        started = true
        emit({ event: 'Started', data: { contentLength: progress.total ?? null } })
      }
      const chunkLength = Math.max(0, transferred - lastTransferred)
      lastTransferred = transferred
      if (chunkLength > 0) {
        emit({ event: 'Progress', data: { chunkLength } })
      }
    }

    this.updater.on('download-progress', onProgress)
    try {
      await this.updater.downloadUpdate()
      if (!started) {
        emit({ event: 'Started', data: { contentLength: null } })
      }
      emit({ event: 'Finished' })
      this.downloaded = true
    } finally {
      this.updater.off('download-progress', onProgress)
    }
  }

  cancelInstall() {
    // The renderer retains the downloaded update on an install/relaunch
    // failure. Revoke the install request, but keep the download retryable.
    this.installRequested = false
  }

  stageDownloadedUpdate() {
    if (!this.pendingUpdate) {
      throw new Error('No Electron update is ready to install')
    }
    if (!this.downloaded) {
      throw new Error('Electron update has not finished downloading')
    }
    this.installRequested = true
  }

  hasDownloadedUpdate(): boolean {
    return !!this.pendingUpdate && this.downloaded
  }

  hasStagedUpdate(): boolean {
    return this.hasDownloadedUpdate() && this.installRequested
  }

  quitAndInstallDownloadedUpdate(env: NodeJS.ProcessEnv = process.env) {
    if (!this.hasStagedUpdate()) {
      throw new Error('Electron update installation has not been requested')
    }
    // The NSIS installer spawned here inherits this process's environment.
    // Hand it the same clean environment a manually launched setup gets, so
    // its legacy-data checks read the persisted app-mode.json instead of a
    // process-local snapshot that may disagree with it (#1160).
    clearAppManagedPortableEnv(env)
    this.updater.quitAndInstall(false, true)
  }
}
