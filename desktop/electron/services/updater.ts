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
  on(event: 'error', handler: (error: unknown) => void): ElectronUpdaterLike
  off(event: 'download-progress', handler: (progress: { transferred?: number, total?: number }) => void): ElectronUpdaterLike
  off(event: 'error', handler: (error: unknown) => void): ElectronUpdaterLike
}

export type ElectronUpdateDownloadOptions = {
  subscriberKey?: string
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
  log?: (message: string) => void
}

type ActiveDownloadState = {
  version: string
  proxyKey: string | null
  promise: Promise<void>
  started: boolean
  total: number | null
  transferred: number
  subscribers: Map<unknown, (event: DesktopUpdateDownloadEvent) => void>
}

function sanitizeUpdaterDiagnostic(text: string, knownProxyUrls: Iterable<string>): string {
  const sensitive = new Set<string>()
  for (const raw of knownProxyUrls) {
    if (!raw) continue
    sensitive.add(raw)
    try {
      const parsed = new URL(raw)
      if (parsed.host) sensitive.add(parsed.host)
      for (const part of [parsed.username, parsed.password]) {
        if (!part) continue
        sensitive.add(part)
        try {
          sensitive.add(decodeURIComponent(part))
        } catch {
          // Keep literal credential component if percent-decoding fails.
        }
      }
      if (parsed.username || parsed.password) {
        let user = parsed.username
        let pass = parsed.password
        try { user = decodeURIComponent(user) } catch { /* ignore */ }
        try { pass = decodeURIComponent(pass) } catch { /* ignore */ }
        sensitive.add(Buffer.from(`${user}:${pass}`).toString('base64'))
      }
    } catch {
      // Raw proxy string is already added for literal replacement.
    }
  }

  let sanitized = text.replace(/[\r\n]+/g, ' ')
  for (const secret of [...sensitive].sort((a, b) => b.length - a.length)) {
    sanitized = sanitized.replaceAll(secret, '[REDACTED]')
  }
  sanitized = sanitized.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s<>"')\]}]+/gi, candidate => {
    try {
      const parsed = new URL(candidate)
      const auth = parsed.username || parsed.password ? '[REDACTED]@' : ''
      const query = parsed.search ? '?[REDACTED]' : ''
      const hash = parsed.hash ? '#[REDACTED]' : ''
      return `${parsed.protocol}//${auth}${parsed.host}${parsed.pathname}${query}${hash}`
    } catch {
      return '[REDACTED_URL]'
    }
  })
  return sanitized.trim()
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
  private readonly log?: (message: string) => void
  private readonly knownProxyUrls = new Set<string>()
  private pendingUpdate: ElectronUpdateMetadata | null = null
  private downloaded = false
  private installRequested = false
  private proxyKey: string | null = null
  private activeDownload: ActiveDownloadState | null = null

  constructor(
    updater: ElectronUpdaterLike,
    proxyController?: ElectronUpdaterProxyController,
    runtimeOptions: ElectronUpdaterRuntimeOptions = {},
  ) {
    this.updater = updater
    this.proxyController = proxyController
    this.updateConfigPath = runtimeOptions.updateConfigPath
    this.log = runtimeOptions.log
    this.updater.autoDownload = false
    // Background downloads must stay pending after "Later", normal quits,
    // and app-mode restarts. On macOS this also keeps the ZIP out of Squirrel
    // until the user explicitly requests quitAndInstall.
    this.updater.autoInstallOnAppQuit = false
    // Differential download issues many small sequential range requests and is
    // RTT-bound against the GitHub CDN, so it downloads far below line speed.
    this.updater.disableDifferentialDownload = true
    this.updater.logger = null
    if (typeof this.updater.on === 'function') {
      this.updater.on('error', error => {
        const detail = error instanceof Error ? error.message : String(error)
        this.writeLog(`updater_error platform=${process.platform} message=${sanitizeUpdaterDiagnostic(detail, this.knownProxyUrls)}`)
      })
    }
  }

  private writeLog(message: string) {
    try {
      this.log?.(message)
    } catch {
      // Diagnostics logging must never disrupt the updater flow.
    }
  }

  private async applyProxy(options?: ElectronUpdateCheckOptions) {
    const proxy = options?.proxy?.trim() || null
    if (proxy) this.knownProxyUrls.add(proxy)
    const nextProxyKey = proxy ? `manual:${proxy}` : 'system'
    if (!this.proxyController) {
      this.proxyKey = nextProxyKey
      return
    }
    if (this.proxyKey === nextProxyKey) return

    await this.proxyController.apply(proxy)
    this.proxyKey = nextProxyKey
  }

  async checkForUpdates(options?: ElectronUpdateCheckOptions): Promise<ElectronUpdateMetadata | null> {
    this.installRequested = false
    const previousProxyKey = this.proxyKey
    const proxyMode = options?.proxy?.trim() ? 'manual' : 'system'
    this.writeLog(`check_start proxy=${proxyMode} platform=${process.platform}`)
    let result: ElectronUpdateCheckResult
    try {
      await this.applyProxy(options)
      if (this.activeDownload && this.pendingUpdate && this.activeDownload.proxyKey === this.proxyKey) {
        this.writeLog(`check_reused_active_download version=${this.pendingUpdate.version}`)
        return this.pendingUpdate
      }
      if (this.updateConfigPath && !existsSync(this.updateConfigPath)) {
        this.writeLog('check_skipped reason=missing_update_config')
        result = null
      } else {
        result = await this.updater.checkForUpdates()
      }
    } catch (error) {
      if (!isMissingUpdateMetadataError(error)) {
        const detail = error instanceof Error ? error.message : String(error)
        this.writeLog(`check_error message=${sanitizeUpdaterDiagnostic(detail, this.knownProxyUrls)}`)
        throw error
      }
      this.writeLog('check_skipped reason=missing_channel_metadata')
      result = null
    }
    const nextPending = result?.isUpdateAvailable === false ? null : normalizeUpdateInfo(result?.updateInfo)
    const keepDownloaded = !!nextPending
      && this.downloaded
      && this.pendingUpdate?.version === nextPending.version
      && previousProxyKey === this.proxyKey
    this.pendingUpdate = nextPending
    this.downloaded = keepDownloaded
    if (this.pendingUpdate) {
      this.writeLog(`check_available version=${this.pendingUpdate.version} cached=${keepDownloaded}`)
    } else {
      this.writeLog('check_up_to_date')
    }
    return this.pendingUpdate
  }

  async downloadUpdate(
    emit: (event: DesktopUpdateDownloadEvent) => void,
    options?: ElectronUpdateDownloadOptions,
  ): Promise<void> {
    const subscriberKey: unknown = options?.subscriberKey ?? emit

    while (true) {
      if (!this.pendingUpdate) {
        throw new Error('No Electron update is available to download')
      }
      if (this.downloaded) {
        this.writeLog(`download_cached version=${this.pendingUpdate.version}`)
        emit({ event: 'Finished' })
        return
      }

      const version = this.pendingUpdate.version
      const targetProxyKey = this.proxyKey

      if (this.activeDownload) {
        const active = this.activeDownload
        if (active.version === version && active.proxyKey === targetProxyKey) {
          this.writeLog(`download_join version=${version} transferred=${active.transferred} total=${active.total ?? 'unknown'}`)
          active.subscribers.set(subscriberKey, emit)
          if (active.started) {
            emit({ event: 'Started', data: { contentLength: active.total } })
            if (active.transferred > 0) {
              emit({ event: 'Progress', data: { chunkLength: active.transferred } })
            }
          }
          try {
            await active.promise
          } finally {
            if (active.subscribers.get(subscriberKey) === emit) {
              active.subscribers.delete(subscriberKey)
            }
          }
          return
        }

        // electron-updater shares a single underlying downloadPromise; wait for
        // the superseded download to finish rather than attaching duplicate listeners.
        this.writeLog(`download_wait_superseded previousVersion=${active.version} nextVersion=${version}`)
        await active.promise.catch(() => undefined)
        continue
      }

      const startedAt = Date.now()
      let nextMilestone = 25
      const subscribers = new Map<unknown, (event: DesktopUpdateDownloadEvent) => void>([[subscriberKey, emit]])
      const broadcast = (event: DesktopUpdateDownloadEvent) => {
        for (const subscriber of subscribers.values()) {
          try {
            subscriber(event)
          } catch {
            // One failing listener (e.g. closed window) must not abort the download.
          }
        }
      }

      const activeState: ActiveDownloadState = {
        version,
        proxyKey: targetProxyKey,
        promise: Promise.resolve(),
        started: false,
        total: null,
        transferred: 0,
        subscribers,
      }

      const onProgress = (progress: { transferred?: number, total?: number }) => {
        const transferred = Math.max(0, progress.transferred ?? 0)
        if (!activeState.started) {
          activeState.started = true
          activeState.total = progress.total ?? null
          broadcast({ event: 'Started', data: { contentLength: activeState.total } })
        }
        const chunkLength = Math.max(0, transferred - activeState.transferred)
        activeState.transferred = transferred
        if (chunkLength > 0) {
          broadcast({ event: 'Progress', data: { chunkLength } })
        }
        if (activeState.total && activeState.total > 0) {
          const percent = Math.floor((activeState.transferred / activeState.total) * 100)
          if (percent >= nextMilestone && nextMilestone < 100) {
            this.writeLog(`download_progress version=${version} percent=${percent} transferred=${activeState.transferred} total=${activeState.total}`)
            while (nextMilestone <= percent) nextMilestone += 25
          }
        }
      }

      this.writeLog(`download_start version=${version} platform=${process.platform}`)
      this.updater.on('download-progress', onProgress)
      const downloadPromise = (async () => {
        try {
          await this.updater.downloadUpdate()
          const isCurrent = this.activeDownload === activeState
            && this.pendingUpdate?.version === version
            && this.proxyKey === activeState.proxyKey
          if (!isCurrent) {
            this.writeLog(`download_discarded_stale version=${version} durationMs=${Date.now() - startedAt}`)
            return
          }
          if (!activeState.started) {
            activeState.started = true
            broadcast({ event: 'Started', data: { contentLength: null } })
          }
          broadcast({ event: 'Finished' })
          this.downloaded = true
          this.writeLog(`download_complete version=${version} transferred=${activeState.transferred} durationMs=${Date.now() - startedAt}`)
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          this.writeLog(`download_error version=${version} durationMs=${Date.now() - startedAt} message=${sanitizeUpdaterDiagnostic(detail, this.knownProxyUrls)}`)
          throw error
        } finally {
          this.updater.off('download-progress', onProgress)
          if (this.activeDownload === activeState) {
            this.activeDownload = null
          }
        }
      })()
      activeState.promise = downloadPromise
      this.activeDownload = activeState

      try {
        await downloadPromise
      } finally {
        if (subscribers.get(subscriberKey) === emit) {
          subscribers.delete(subscriberKey)
        }
      }
      return
    }
  }

  cancelInstall() {
    // The renderer retains the downloaded update on an install/relaunch
    // failure. Revoke the install request, but keep the download retryable.
    this.installRequested = false
    this.writeLog(`cancel_install version=${this.pendingUpdate?.version ?? 'none'}`)
  }

  stageDownloadedUpdate() {
    if (!this.pendingUpdate) {
      throw new Error('No Electron update is ready to install')
    }
    if (!this.downloaded) {
      throw new Error('Electron update has not finished downloading')
    }
    this.installRequested = true
    this.writeLog(`stage_install version=${this.pendingUpdate.version}`)
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
    this.writeLog(`quit_and_install version=${this.pendingUpdate?.version ?? 'unknown'} platform=${process.platform}`)
    // The NSIS installer spawned here inherits this process's environment.
    // Hand it the same clean environment a manually launched setup gets, so
    // its legacy-data checks read the persisted app-mode.json instead of a
    // process-local snapshot that may disagree with it (#1160).
    clearAppManagedPortableEnv(env)
    this.updater.quitAndInstall(false, true)
  }
}
