import type { DesktopUpdateDownloadEvent } from '../../src/lib/desktopHost/types'
import { existsSync } from 'node:fs'

export type ElectronUpdateInfo = {
  version: string
  body?: string | null
  releaseNotes?: string | Array<{ note?: string | null }> | null
}

export type ElectronUpdateCheckResult = {
  updateInfo?: ElectronUpdateInfo
} | null

export type ElectronUpdateCheckOptions = {
  proxy?: string
}

export type ElectronUpdaterLike = {
  autoDownload: boolean
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
  /**
   * Currently running app version. When provided, a feed entry whose version
   * is not strictly newer is treated as "no update", so an already-latest
   * release is not surfaced as an available update. Omit to skip comparison.
   */
  currentVersion?: string
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

/**
 * Parse the numeric X.Y.Z core of a version string, ignoring any prerelease
 * (`-beta`) or build metadata (`+sha`) suffix. Missing segments default to 0.
 * Electron release versions are clean semver, so a self-contained comparator
 * avoids pulling a semver dependency into the electron main-process bundle.
 */
function parseVersionCore(version: string): [number, number, number] {
  const core = version.trim().replace(/^v/i, '').split(/[-+]/, 1)[0] ?? ''
  const parts = core.split('.')
  const toInt = (value: string | undefined) => {
    const parsed = Number.parseInt(value ?? '', 10)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
  }
  return [toInt(parts[0]), toInt(parts[1]), toInt(parts[2])]
}

/**
 * Whether `candidate` is a strictly newer release than `current`. Equal or
 * older versions return false so an "already latest" feed entry is not
 * mislabeled as an available update. Prerelease/build suffixes are ignored:
 * an equal numeric core counts as not newer (the safe up-to-date direction).
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const [aMajor, aMinor, aPatch] = parseVersionCore(candidate)
  const [bMajor, bMinor, bPatch] = parseVersionCore(current)
  if (aMajor !== bMajor) return aMajor > bMajor
  if (aMinor !== bMinor) return aMinor > bMinor
  return aPatch > bPatch
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
  private readonly currentVersion?: string
  private pendingUpdate: ElectronUpdateMetadata | null = null
  private downloaded = false
  private proxyKey: string | null = null

  constructor(
    updater: ElectronUpdaterLike,
    proxyController?: ElectronUpdaterProxyController,
    runtimeOptions: ElectronUpdaterRuntimeOptions = {},
  ) {
    this.updater = updater
    this.proxyController = proxyController
    this.updateConfigPath = runtimeOptions.updateConfigPath
    this.currentVersion = runtimeOptions.currentVersion
    this.updater.autoDownload = false
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
    const normalized = normalizeUpdateInfo(result?.updateInfo)
    this.pendingUpdate =
      normalized && this.currentVersion && !isNewerVersion(normalized.version, this.currentVersion)
        ? null
        : normalized
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
    this.pendingUpdate = null
    this.downloaded = false
  }

  stageDownloadedUpdate() {
    if (!this.pendingUpdate) {
      throw new Error('No Electron update is ready to install')
    }
    if (!this.downloaded) {
      throw new Error('Electron update has not finished downloading')
    }
  }

  hasDownloadedUpdate(): boolean {
    return !!this.pendingUpdate && this.downloaded
  }

  quitAndInstallDownloadedUpdate() {
    this.stageDownloadedUpdate()
    this.updater.quitAndInstall(false, true)
  }
}
