import type {
  CCHahaUpdaterModule,
  DownloadProgressEvent,
  InstalledAppInfo,
} from '../../modules/cchaha-updater'
import { connectionHeaders, hostOrigin } from '../core/connection'
import {
  classifyUpdateError,
  compareSemver,
  extractErrorCode,
  isNewerVersion,
  isOlderDesktopRelayError,
  parseAndroidReleaseManifest,
  releaseFromManifest,
  type AndroidReleaseManifest,
  type AndroidUpdateRelease,
  type AndroidUpdateSnapshot,
  type UpdateErrorKind,
  type UpdateSource,
} from '../core/androidUpdateModel'
import type { Host } from '../core/types'
import {
  AndroidUpdateStore,
  EMPTY_ANDROID_UPDATE_RECORD,
  type AndroidUpdateRecord,
} from './androidUpdateStorage'

export const SILENT_CHECK_COOLDOWN_MS = 12 * 60 * 60 * 1000
export const SILENT_FAILURE_COOLDOWN_MS = 15 * 60 * 1000
export const STARTUP_SILENT_CHECK_DELAY_MS = 5_000
export const PENDING_INSTALL_AUTO_LAUNCH_MS = 60 * 1000
export const PENDING_INSTALL_WINDOW_MS = 10 * 60 * 1000
export const INSTALL_WATCHDOG_MS = 5_000
export const UNSUPPORTED_RELAY_TTL_MS = 5 * 60 * 1000
export const DESKTOP_UNREACHABLE_TTL_MS = 60 * 1000
export const DESKTOP_PREPARE_POLL_MS = 1_000
export const DESKTOP_PREPARE_MAX_WAIT_MS = 10 * 60 * 1000
const CANCEL_WAIT_MS = 1_500

export type DesktopLatestResponse =
  | {
      supported: true
      available: true
      manifest: unknown
      releaseUrl?: string
      cachedSizeBytes?: number | null
    }
  | {
      supported: true
      available: false
      reason?: string
      manifest?: null
    }

export type DesktopPrepareResponse =
  | {
      supported: true
      status: 'ready'
      sha256: string
      sizeBytes: number
      manifest: unknown
    }
  | {
      supported: true
      status: 'preparing'
      sha256: string
      downloadedBytes: number
      totalBytes: number | null
      manifest: unknown
    }
  | {
      supported: true
      status: 'idle'
      sha256: string
      manifest: unknown
    }
  | {
      supported: true
      status: 'failed'
      sha256: string
      code: string
      error: string
      manifest: unknown
    }

export type ActiveDesktopConnection = {
  host: Host
  credential: string
  fetchLatest(refresh: boolean): Promise<DesktopLatestResponse>
  prepareApk?(sha256: string, start: boolean): Promise<DesktopPrepareResponse>
}

export type NetworkProbeResult = {
  online: boolean
  cellular: boolean
}

export type AndroidUpdateControllerDeps = {
  nativeUpdater: CCHahaUpdaterModule
  store: AndroidUpdateStore
  getNetworkState(): Promise<NetworkProbeResult>
  getConnection?: () => ActiveDesktopConnection | null
  now?: () => number
  randomId?: () => string
  preparePollIntervalMs?: number
  installWatchdogMs?: number
}

type Listener = (snapshot: AndroidUpdateSnapshot) => void

function isAlreadyInstalled(candidate: string, installed: string): boolean {
  const order = compareSemver(candidate, installed)
  return order !== null && order <= 0
}

export class AndroidUpdateController {
  private readonly nativeUpdater: CCHahaUpdaterModule
  private readonly store: AndroidUpdateStore
  private readonly getNetworkState: () => Promise<NetworkProbeResult>
  private readonly externalGetConnection?: () => ActiveDesktopConnection | null
  private activeConnection: ActiveDesktopConnection | null = null
  private readonly now: () => number
  private readonly randomId: () => string
  private readonly preparePollIntervalMs: number
  private readonly installWatchdogMs: number

  private listeners = new Set<Listener>()
  private progressSub: { remove(): void } | null = null
  private initialization: Promise<void> | null = null
  private running = false
  private settingsFocused = false
  private downloadStarting = false
  private activeDownloadId: string | null = null
  private activeDownloadPromise: Promise<void> | null = null
  private prepareCancelController: AbortController | null = null
  private checkInFlight: Promise<void> | null = null
  private checkIsManual = false
  private lastSilentFailureAt: number | null = null
  private installLaunchedAt: number | null = null
  private sawBackgroundDuringInstall = false
  private installWatchdogTimer: ReturnType<typeof setTimeout> | null = null
  private startupTimer: ReturnType<typeof setTimeout> | null = null
  private unsupportedRelayUntil = new Map<string, number>()
  private unreachableDesktopUntil = new Map<string, number>()
  private lastDownloadSource: UpdateSource = 'github'
  private record: AndroidUpdateRecord = { ...EMPTY_ANDROID_UPDATE_RECORD }
  private snapshot: AndroidUpdateSnapshot

  constructor(deps: AndroidUpdateControllerDeps) {
    this.nativeUpdater = deps.nativeUpdater
    this.store = deps.store
    this.getNetworkState = deps.getNetworkState
    this.externalGetConnection = deps.getConnection
    this.now = deps.now ?? Date.now
    this.randomId = deps.randomId ?? (() => `dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    this.preparePollIntervalMs = deps.preparePollIntervalMs ?? DESKTOP_PREPARE_POLL_MS
    this.installWatchdogMs = deps.installWatchdogMs ?? INSTALL_WATCHDOG_MS

    let installed: InstalledAppInfo | null = null
    try {
      installed = this.nativeUpdater.getInstalledAppInfo()
    } catch {
      installed = null
    }

    const conn = this.getConnection()
    this.snapshot = {
      status: 'idle',
      checkingVia: 'github',
      currentVersion: installed?.versionName ?? '',
      release: null,
      downloadingVia: null,
      downloadingStage: null,
      downloadedBytes: 0,
      totalBytes: null,
      partialBytes: 0,
      dismissedVersion: null,
      permissionStillDenied: false,
      installCancelledHint: false,
      errorKind: null,
      errorSource: null,
      errorPhase: null,
      errorCanRetryInstall: false,
      desktopOnline: Boolean(conn),
      desktopRelaySupported: true,
      hostName: conn?.host.name,
    }
  }

  getSnapshot(): AndroidUpdateSnapshot {
    return this.snapshot
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  setConnection(conn: ActiveDesktopConnection | null): void {
    const prevId = this.activeConnection?.host.id
    this.activeConnection = conn
    if (conn && conn.host.id !== prevId) {
      this.unreachableDesktopUntil.delete(conn.host.id)
    }
    this.syncConnection()
  }

  private getConnection(): ActiveDesktopConnection | null {
    return this.externalGetConnection ? this.externalGetConnection() : this.activeConnection
  }

  private isRelayUnsupported(hostId: string): boolean {
    const until = this.unsupportedRelayUntil.get(hostId)
    if (until === undefined) return false
    if (this.now() >= until) {
      this.unsupportedRelayUntil.delete(hostId)
      return false
    }
    return true
  }

  private isDesktopMarkedUnreachable(hostId: string): boolean {
    const until = this.unreachableDesktopUntil.get(hostId)
    if (until === undefined) return false
    if (this.now() >= until) {
      this.unreachableDesktopUntil.delete(hostId)
      return false
    }
    return true
  }

  syncConnection(): void {
    const conn = this.getConnection()
    const desktopOnline = Boolean(conn && !this.isDesktopMarkedUnreachable(conn.host.id))
    const desktopRelaySupported = conn ? !this.isRelayUnsupported(conn.host.id) : true
    const hostName = conn?.host.name
    if (
      this.snapshot.desktopOnline !== desktopOnline ||
      this.snapshot.desktopRelaySupported !== desktopRelaySupported ||
      this.snapshot.hostName !== hostName
    ) {
      this.patch({ desktopOnline, desktopRelaySupported, hostName })
    }
  }

  setSettingsFocused(focused: boolean): void {
    this.settingsFocused = focused
    if (focused && this.initialization && this.running) {
      void this.maybeSilentCheck()
    }
  }

  /** Symmetric lifecycle start (safe across React StrictMode / Fast Refresh effect re-runs). */
  start(options: { scheduleStartupCheck?: boolean } = {}): Promise<void> {
    this.running = true
    if (!this.progressSub) {
      this.progressSub = this.nativeUpdater.addListener('onDownloadProgress', (event) => {
        this.handleProgress(event)
      })
    }
    return this.initialize(options)
  }

  /** Pauses timers and native event listeners without permanently poisoning the instance. */
  stop(): void {
    this.running = false
    if (this.startupTimer) {
      clearTimeout(this.startupTimer)
      this.startupTimer = null
    }
    this.clearInstallWatchdog()
    this.progressSub?.remove()
    this.progressSub = null
  }

  /** Alias for test/unmount cleanup; re-starting via `start()` remains safe. */
  dispose(): void {
    this.stop()
    this.listeners.clear()
  }

  initialize(options: { scheduleStartupCheck?: boolean } = {}): Promise<void> {
    this.initialization ??= this.restoreState(options).catch((error) => {
      this.initialization = null
      throw error
    })
    return this.initialization
  }

  private async restoreState(options: { scheduleStartupCheck?: boolean }): Promise<void> {
    this.running = true

    if (!this.progressSub) {
      this.progressSub = this.nativeUpdater.addListener('onDownloadProgress', (event) => {
        this.handleProgress(event)
      })
    }

    const currentVersion = this.readCurrentVersion()
    this.record = await this.store.load()
    let nextRecord = this.record
    let keepSha256: string | null = null
    let restoredRelease: AndroidUpdateRelease | null = null
    let restoredStatus: AndroidUpdateSnapshot['status'] = 'idle'
    let restoredPartialBytes = 0
    let restoredTotalBytes: number | null = null
    let shouldAutoInstall = false

    // 1. Reconcile downloaded APK against currently installed version.
    if (nextRecord.downloaded) {
      const dl = nextRecord.downloaded
      if (isAlreadyInstalled(dl.version, currentVersion)) {
        nextRecord = {
          ...nextRecord,
          downloaded: null,
          partial: null,
          pendingInstall: null,
          dismissedVersion:
            nextRecord.dismissedVersion && isAlreadyInstalled(nextRecord.dismissedVersion, currentVersion)
              ? null
              : nextRecord.dismissedVersion,
        }
      } else {
        const cached = await this.safeGetCachedApk(dl.sha256, dl.version)
        if (cached?.ready && cached.verified) {
          keepSha256 = dl.sha256
          this.lastDownloadSource = dl.via ?? 'github'
          restoredRelease = {
            version: dl.version,
            tag: dl.tag,
            asset: dl.asset,
            sha256: dl.sha256,
            buildId: '',
            deliveredAt: '',
            downloadUrl: dl.downloadUrl,
            releaseUrl: dl.releaseUrl,
            sizeBytes: cached.sizeBytes ?? dl.sizeBytes,
            discoveredVia: dl.via ?? 'github',
          }
          restoredStatus = 'downloaded'
          restoredTotalBytes = restoredRelease.sizeBytes

          const pending = nextRecord.pendingInstall
          if (pending && pending.sha256 === dl.sha256 && pending.version === dl.version) {
            const age = this.now() - pending.requestedAt
            nextRecord = { ...nextRecord, pendingInstall: null }
            if (
              age >= 0 && age < PENDING_INSTALL_WINDOW_MS &&
              isNewerVersion(dl.version, currentVersion) && this.safeCanRequestPackageInstalls()
            ) {
              if (age < PENDING_INSTALL_AUTO_LAUNCH_MS || this.settingsFocused) {
                shouldAutoInstall = true
              }
            }
          }
        } else {
          nextRecord = { ...nextRecord, downloaded: null, pendingInstall: null }
        }
      }
    } else if (nextRecord.pendingInstall) {
      nextRecord = { ...nextRecord, pendingInstall: null }
    }

    // 2. Reconcile resumable partial download if no verified APK is ready.
    if (!restoredRelease && nextRecord.partial) {
      const part = nextRecord.partial
      if (isAlreadyInstalled(part.version, currentVersion)) {
        nextRecord = { ...nextRecord, partial: null }
      } else {
        const cached = await this.safeGetCachedApk(part.sha256, part.version)
        if (cached?.ready && cached.verified) {
          keepSha256 = part.sha256
          this.lastDownloadSource = part.via
          restoredRelease = {
            version: part.version,
            tag: part.tag,
            asset: part.asset,
            sha256: part.sha256,
            buildId: '',
            deliveredAt: '',
            downloadUrl: part.downloadUrl,
            releaseUrl: part.releaseUrl,
            sizeBytes: cached.sizeBytes ?? part.totalBytes,
            discoveredVia: part.via,
          }
          restoredStatus = 'downloaded'
          restoredTotalBytes = restoredRelease.sizeBytes
          nextRecord = {
            ...nextRecord,
            partial: null,
            downloaded: {
              version: part.version,
              tag: part.tag,
              asset: part.asset,
              sha256: part.sha256,
              sizeBytes: restoredRelease.sizeBytes,
              releaseUrl: part.releaseUrl,
              downloadUrl: part.downloadUrl,
              verifiedAt: this.now(),
              via: part.via,
            },
          }
        } else if (cached && cached.partialBytes > 0) {
          keepSha256 = part.sha256
          this.lastDownloadSource = part.via
          restoredPartialBytes = cached.partialBytes
          restoredTotalBytes = cached.totalBytes ?? part.totalBytes
          restoredRelease = {
            version: part.version,
            tag: part.tag,
            asset: part.asset,
            sha256: part.sha256,
            buildId: '',
            deliveredAt: '',
            downloadUrl: part.downloadUrl,
            releaseUrl: part.releaseUrl,
            sizeBytes: restoredTotalBytes,
            discoveredVia: part.via,
          }
          restoredStatus = 'available'
        } else {
          nextRecord = { ...nextRecord, partial: null }
        }
      }
    }

    const available = nextRecord.available
    if (available) {
      if (isAlreadyInstalled(available.manifest.version, currentVersion)) {
        nextRecord = { ...nextRecord, available: null }
      } else if (!restoredRelease) {
        restoredRelease = releaseFromManifest(available.manifest, available)
        restoredStatus = 'available'
        restoredTotalBytes = restoredRelease.sizeBytes
      }
    } else if (!restoredRelease) {
      // Older records only kept a release alongside its download. If the OS
      // evicted that file, rediscover the release instead of waiting 12 hours.
      const oldTarget = this.record.downloaded ?? this.record.partial ?? this.record.pendingInstall
      if (oldTarget && !isAlreadyInstalled(oldTarget.version, currentVersion)) {
        nextRecord = { ...nextRecord, lastCheckedAt: null }
      }
    }

    if (nextRecord !== this.record) {
      this.record = await this.store.update(() => nextRecord)
    }

    await this.safeCleanupCachedApks(keepSha256)

    this.patch({
      currentVersion,
      status: restoredStatus,
      release: restoredRelease,
      partialBytes: restoredPartialBytes,
      totalBytes: restoredTotalBytes,
      dismissedVersion: this.record.dismissedVersion,
    })

    if (shouldAutoInstall && this.running) {
      await this.install()
      return
    }

    if (options.scheduleStartupCheck !== false && this.running) {
      this.startupTimer = setTimeout(() => {
        this.startupTimer = null
        void this.maybeSilentCheck()
      }, STARTUP_SILENT_CHECK_DELAY_MS)
    }
  }

  handleAppBackground(): void {
    if (this.snapshot.status === 'installing') {
      this.sawBackgroundDuringInstall = true
    }
  }

  async handleAppForeground(): Promise<void> {
    await this.initialization
    if (!this.running) return
    this.syncConnection()

    // 1. Check if installation finished while backgrounded.
    const currentVersion = this.readCurrentVersion()
    if (this.snapshot.release && isAlreadyInstalled(this.snapshot.release.version, currentVersion)) {
      this.installLaunchedAt = null
      this.sawBackgroundDuringInstall = false
      this.clearInstallWatchdog()
      this.record = await this.store.update((cur) => ({
        ...cur,
        available: null,
        downloaded: null,
        partial: null,
        pendingInstall: null,
      }))
      await this.safeCleanupCachedApks(null)
      this.patch({
        currentVersion,
        status: 'idle',
        release: null,
        partialBytes: 0,
        downloadedBytes: 0,
        totalBytes: null,
        permissionStillDenied: false,
        installCancelledHint: false,
        errorKind: null,
      })
      return
    }

    // 2. If user returned from "Install unknown apps" system settings, resume install cleanly.
    if (this.snapshot.status === 'permission-needed' && this.snapshot.release) {
      const granted = this.safeCanRequestPackageInstalls()
      this.record = await this.store.update((cur) => ({ ...cur, pendingInstall: null }))
      if (granted) {
        this.patch({ permissionStillDenied: false })
        await this.install()
      } else {
        this.patch({ permissionStillDenied: true })
      }
      return
    }

    // 3. Always exit `installing` once the user returns from PackageInstaller (even <500ms).
    if (this.snapshot.status === 'installing' && (this.sawBackgroundDuringInstall || this.installLaunchedAt !== null)) {
      this.relaxInstallingToDownloaded(true)
      return
    }

    // 4. Gentle 12h-cooldown silent check.
    if (this.initialization) {
      await this.maybeSilentCheck()
    }
  }

  async maybeSilentCheck(): Promise<void> {
    await this.initialization
    if (!this.running || this.downloadStarting) return
    if (
      this.snapshot.status === 'downloading' ||
      this.snapshot.status === 'verifying' ||
      this.snapshot.status === 'downloaded' ||
      this.snapshot.status === 'permission-needed' ||
      this.snapshot.status === 'installing'
    ) {
      return
    }
    const now = this.now()
    const lastCheckedAt = this.record.lastCheckedAt
    if (lastCheckedAt !== null && now - lastCheckedAt < SILENT_CHECK_COOLDOWN_MS) {
      return
    }
    if (this.lastSilentFailureAt !== null && now - this.lastSilentFailureAt < SILENT_FAILURE_COOLDOWN_MS) {
      return
    }
    await this.checkForUpdates({ manual: false })
  }

  async checkForUpdates(options: { manual: boolean; preferDesktop?: boolean; directOnly?: boolean }): Promise<void> {
    await this.initialization
    if (!this.running) return

    if (options.manual) {
      const conn = this.getConnection()
      if (conn) {
        // Manual check re-probes desktop relay support & reachability so upgrading
        // or re-enabling desktop H5 takes effect immediately without restarting the app.
        this.unsupportedRelayUntil.delete(conn.host.id)
        this.unreachableDesktopUntil.delete(conn.host.id)
      }
    }
    this.syncConnection()

    if (
      this.snapshot.status === 'downloading' ||
      this.snapshot.status === 'verifying' ||
      this.snapshot.status === 'installing'
    ) {
      return
    }

    if (this.checkInFlight) {
      if (options.manual && !this.checkIsManual) {
        this.checkIsManual = true
        this.patch({ status: 'checking', errorKind: null })
      }
      return this.checkInFlight
    }

    this.checkIsManual = options.manual
    if (options.manual) {
      this.patch({
        status: 'checking',
        checkingVia: options.preferDesktop ? 'desktop' : 'github',
        errorKind: null,
        errorSource: null,
        errorPhase: null,
        errorCanRetryInstall: false,
        permissionStillDenied: false,
        installCancelledHint: false,
      })
    }

    const task = this.runCheck({
      preferDesktop: Boolean(options.preferDesktop),
      directOnly: Boolean(options.directOnly),
    }).finally(() => {
      this.checkInFlight = null
      this.checkIsManual = false
    })
    this.checkInFlight = task
    return task
  }

  async shouldWarnCellular(): Promise<boolean> {
    try {
      const net = await this.getNetworkState()
      return net.online && net.cellular
    } catch {
      return false
    }
  }

  async download(source: UpdateSource): Promise<void> {
    if (this.checkInFlight) {
      const selectedSha = this.snapshot.release?.sha256
      await this.checkInFlight
      if (this.snapshot.release?.sha256 !== selectedSha) return
    }
    if (!this.running) return
    // Acquire the download slot synchronously, including after a shared version check.
    if (
      this.downloadStarting ||
      this.activeDownloadId !== null ||
      this.snapshot.status === 'downloading' ||
      this.snapshot.status === 'verifying'
    ) {
      return
    }

    const release = this.snapshot.release
    if (!release) {
      await this.checkForUpdates({ manual: true, preferDesktop: source === 'desktop' })
      return
    }

    this.downloadStarting = true
    const downloadId = this.randomId()
    this.activeDownloadId = downloadId
    this.lastDownloadSource = source

    const runPromise = this.runDownload(downloadId, source, release).finally(() => {
      this.downloadStarting = false
      if (this.activeDownloadId === downloadId) {
        this.activeDownloadId = null
      }
      if (this.activeDownloadPromise === runPromise) {
        this.activeDownloadPromise = null
      }
    })
    this.activeDownloadPromise = runPromise
    return runPromise
  }

  async cancelDownload(): Promise<void> {
    const downloadId = this.activeDownloadId
    const inflight = this.activeDownloadPromise
    this.activeDownloadId = null
    this.prepareCancelController?.abort()
    this.prepareCancelController = null

    try {
      this.nativeUpdater.cancelDownload(downloadId, true)
    } catch {
      // Best effort.
    }

    if (inflight) {
      await Promise.race([
        inflight.catch(() => {}),
        new Promise<void>((resolve) => setTimeout(resolve, CANCEL_WAIT_MS)),
      ])
    }

    this.record = await this.store.update((cur) => ({ ...cur, partial: null }))
    this.patch({
      status: this.snapshot.release ? 'available' : 'idle',
      downloadingVia: null,
      downloadingStage: null,
      downloadedBytes: 0,
      partialBytes: 0,
      errorKind: null,
    })
  }

  async install(): Promise<void> {
    if (!this.running) return
    const release = this.snapshot.release
    if (!release) return

    if (!this.safeCanRequestPackageInstalls()) {
      this.clearInstallWatchdog()
      this.patch({
        status: 'permission-needed',
        permissionStillDenied: false,
        errorKind: null,
      })
      return
    }

    this.installLaunchedAt = this.now()
    this.sawBackgroundDuringInstall = false
    this.armInstallWatchdog()
    this.patch({
      status: 'installing',
      permissionStillDenied: false,
      installCancelledHint: false,
      errorKind: null,
      errorCanRetryInstall: false,
    })

    try {
      const result = await this.nativeUpdater.installApk(release.sha256, release.version)
      if (result.needsUnknownSourcesPermission) {
        this.installLaunchedAt = null
        this.sawBackgroundDuringInstall = false
        this.clearInstallWatchdog()
        this.patch({ status: 'permission-needed' })
        return
      }
      if (!result.launched) {
        this.installLaunchedAt = null
        this.sawBackgroundDuringInstall = false
        this.clearInstallWatchdog()
        this.setError('signature_or_install_failed', this.lastDownloadSource, 'install', true)
      }
    } catch (error) {
      this.installLaunchedAt = null
      this.sawBackgroundDuringInstall = false
      this.clearInstallWatchdog()
      const code = extractErrorCode(error)
      if (code === 'SHA256_MISMATCH' || code === 'APK_NOT_FOUND') {
        this.record = await this.store.update((cur) => ({
          ...cur,
          downloaded: null,
          pendingInstall: null,
        }))
      }
      const kind = classifyUpdateError(error, {
        source: this.lastDownloadSource,
        phase: 'install',
        online: true,
      })
      this.setError(kind, this.lastDownloadSource, 'install', code === 'INSTALL_LAUNCH_FAILED')
    }
  }

  async openUnknownSourcesSettings(): Promise<void> {
    const release = this.snapshot.release
    if (release) {
      this.record = await this.store.update((cur) => ({
        ...cur,
        pendingInstall: {
          version: release.version,
          sha256: release.sha256,
          requestedAt: this.now(),
        },
      }))
    }
    this.patch({ permissionStillDenied: false })
    try {
      this.nativeUpdater.openUnknownSourcesSettings()
    } catch {
      this.setError('signature_or_install_failed', this.lastDownloadSource, 'install', true)
    }
  }

  async retryInstallAfterPermission(): Promise<void> {
    this.record = await this.store.update((cur) => ({ ...cur, pendingInstall: null }))
    if (!this.safeCanRequestPackageInstalls()) {
      this.patch({ status: 'permission-needed', permissionStillDenied: true })
      return
    }
    await this.install()
  }

  async deleteDownloadedApk(): Promise<void> {
    this.clearInstallWatchdog()
    this.record = await this.store.update((cur) => ({
      ...cur,
      downloaded: null,
      partial: null,
      pendingInstall: null,
    }))
    await this.safeCleanupCachedApks(null)
    this.patch({
      status: this.snapshot.release ? 'available' : 'idle',
      downloadedBytes: 0,
      partialBytes: 0,
      installCancelledHint: false,
      permissionStillDenied: false,
      errorKind: null,
    })
  }

  async dismissAvailableVersion(): Promise<void> {
    const version = this.snapshot.release?.version ?? null
    if (!version) return
    this.record = await this.store.update((cur) => ({
      ...cur,
      dismissedVersion: version,
    }))
    this.patch({ dismissedVersion: version })
  }

  private async runDownload(
    downloadId: string,
    source: UpdateSource,
    release: AndroidUpdateRelease
  ): Promise<void> {
    this.syncConnection()
    const net = await this.safeNetworkState()
    if (this.activeDownloadId !== downloadId) return
    if (!net.online) {
      this.setError('offline', source, 'download', false)
      return
    }

    let url = release.downloadUrl
    let relayOrigin: string | undefined
    let headers: Record<string, string> | undefined
    let activeHostId: string | undefined

    if (source === 'desktop') {
      const conn = this.getConnection()
      if (!conn) {
        this.setError('desktop_relay_disconnected', 'desktop', 'download', false)
        return
      }
      activeHostId = conn.host.id
      relayOrigin = hostOrigin(conn.host)
      url = `${relayOrigin}/api/mobile-update/android/apk?sha256=${release.sha256}`
      headers = connectionHeaders(conn.host, conn.credential)

      // Prepare APK asynchronously on desktop first so neither OkHttp's 30s read
      // timeout nor Cloudflare Quick Tunnel's 100s TTFB timeout aborts slow pulls.
      if (conn.prepareApk) {
        this.patch({
          status: 'downloading',
          downloadingVia: 'desktop',
          downloadingStage: 'desktop_preparing',
          downloadedBytes: 0,
          totalBytes: this.snapshot.totalBytes ?? release.sizeBytes,
          errorKind: null,
          errorSource: null,
          errorPhase: null,
          errorCanRetryInstall: false,
          permissionStillDenied: false,
          installCancelledHint: false,
        })

        const prepOutcome = await this.waitForDesktopPrepare(downloadId, conn, release)
        if (this.activeDownloadId !== downloadId) return
        if (prepOutcome === 'cancelled') return
        if (prepOutcome === 'release_changed') {
          this.record = await this.store.update((cur) => ({ ...cur, partial: null }))
          this.patch({ partialBytes: 0, downloadingVia: null, downloadingStage: null, status: 'available' })
          await this.checkForUpdates({ manual: true, preferDesktop: true })
          return
        }
        if (prepOutcome && typeof prepOutcome === 'object' && 'error' in prepOutcome) {
          this.handleDownloadError(prepOutcome.error, source, activeHostId, release, downloadId)
          return
        }
        if (prepOutcome && typeof prepOutcome === 'object' && 'sizeBytes' in prepOutcome) {
          this.patch({ totalBytes: prepOutcome.sizeBytes })
        }
      }
    }

    if (this.activeDownloadId !== downloadId) return

    this.patch({
      status: 'downloading',
      downloadingVia: source,
      downloadingStage: 'downloading',
      downloadedBytes: this.snapshot.partialBytes,
      totalBytes: this.snapshot.totalBytes ?? release.sizeBytes,
      errorKind: null,
      errorSource: null,
      errorPhase: null,
      errorCanRetryInstall: false,
      permissionStillDenied: false,
      installCancelledHint: false,
    })

    try {
      // Android can kill the process before the native promise resolves or rejects.
      // Save the target first (best-effort); recovery reads the actual byte count from disk.
      try {
        await this.savePartial(release, source, this.snapshot.partialBytes, this.snapshot.totalBytes)
      } catch {
        // Storage failures must not block starting the native download.
      }
      if (this.activeDownloadId !== downloadId) return
      const result = await this.nativeUpdater.downloadApk(
        JSON.stringify({
          downloadId,
          source: source === 'desktop' ? 'relay' : 'github',
          url,
          expectedSha256: release.sha256,
          expectedVersion: release.version,
          ...(relayOrigin ? { relayOrigin } : {}),
          ...(headers ? { headers } : {}),
        })
      )

      if (this.activeDownloadId !== downloadId) return

      const nextRelease: AndroidUpdateRelease = {
        ...release,
        sizeBytes: result.sizeBytes,
      }
      this.record = await this.store.update((cur) => ({
        ...cur,
        partial: null,
        downloaded: {
          version: nextRelease.version,
          tag: nextRelease.tag,
          asset: nextRelease.asset,
          sha256: nextRelease.sha256,
          sizeBytes: result.sizeBytes,
          releaseUrl: nextRelease.releaseUrl,
          downloadUrl: nextRelease.downloadUrl,
          verifiedAt: this.now(),
          via: source,
        },
      }))

      this.patch({
        status: 'downloaded',
        release: nextRelease,
        downloadingVia: null,
        downloadingStage: null,
        downloadedBytes: result.sizeBytes,
        totalBytes: result.sizeBytes,
        partialBytes: 0,
        errorKind: null,
      })
    } catch (error) {
      await this.handleDownloadError(error, source, activeHostId, release, downloadId)
    }
  }

  private async waitForDesktopPrepare(
    downloadId: string,
    conn: ActiveDesktopConnection,
    release: AndroidUpdateRelease
  ): Promise<{ sizeBytes: number } | { error: unknown } | 'cancelled' | 'release_changed' | 'fallback_direct_apk'> {
    const cancelController = new AbortController()
    this.prepareCancelController = cancelController
    const startedAt = this.now()

    try {
      let start = true
      while (true) {
        if (this.activeDownloadId !== downloadId || cancelController.signal.aborted) {
          return 'cancelled'
        }
        let res: DesktopPrepareResponse
        try {
          res = await conn.prepareApk!(release.sha256, start)
        } catch (error) {
          const code = extractErrorCode(error)
          if (code === 'RELEASE_CHANGED') return 'release_changed'
          // Older desktop without /prepare endpoint (404) falls back cleanly to /apk or marks unsupported.
          if (isOlderDesktopRelayError(error)) return 'fallback_direct_apk'
          return { error }
        }
        start = false

        if (this.activeDownloadId !== downloadId || cancelController.signal.aborted) {
          return 'cancelled'
        }
        if (res.status === 'ready') {
          return { sizeBytes: res.sizeBytes }
        }
        if (res.status === 'failed') {
          return { error: Object.assign(new Error(res.error), { code: res.code }) }
        }
        if (res.status === 'idle') {
          // Restart prepare once if desktop dropped it transiently.
          start = true
        } else {
          this.patch({
            status: 'downloading',
            downloadingVia: 'desktop',
            downloadingStage: 'desktop_preparing',
            downloadedBytes: res.downloadedBytes,
            totalBytes: res.totalBytes ?? this.snapshot.totalBytes ?? release.sizeBytes,
          })
        }

        if (this.now() - startedAt > DESKTOP_PREPARE_MAX_WAIT_MS) {
          return { error: Object.assign(new Error('Desktop prepare timed out'), { code: 'UPSTREAM_TIMEOUT' }) }
        }

        const waited = await sleepAbortable(this.preparePollIntervalMs, cancelController.signal)
        if (!waited) return 'cancelled'
      }
    } finally {
      if (this.prepareCancelController === cancelController) {
        this.prepareCancelController = null
      }
    }
  }

  private async handleDownloadError(
    error: unknown,
    source: UpdateSource,
    activeHostId: string | undefined,
    release: AndroidUpdateRelease,
    downloadId: string
  ): Promise<void> {
    const code = extractErrorCode(error)
    if (code === 'CANCELLED' || this.activeDownloadId !== downloadId) {
      return
    }
    if (source === 'desktop' && activeHostId && isOlderDesktopRelayError(error)) {
      this.unsupportedRelayUntil.set(activeHostId, this.now() + UNSUPPORTED_RELAY_TTL_MS)
      this.syncConnection()
    }
    if (source === 'desktop' && code === 'RELEASE_CHANGED') {
      this.record = await this.store.update((cur) => ({ ...cur, partial: null }))
      this.patch({ partialBytes: 0, downloadingVia: null, downloadingStage: null, status: 'available' })
      await this.checkForUpdates({ manual: true, preferDesktop: true })
      return
    }

    const cached = await this.safeGetCachedApk(release.sha256, release.version)
    const partialBytes = cached?.partialBytes ?? 0
    const totalBytes = cached?.totalBytes ?? this.snapshot.totalBytes ?? release.sizeBytes

    try {
      if (partialBytes > 0) {
        await this.savePartial(release, source, partialBytes, totalBytes)
      } else {
        this.record = await this.store.update((cur) => ({ ...cur, partial: null }))
      }
    } catch {
      // Never strand the UI in downloading state if local storage writes fail.
    }

    const netAfter = await this.safeNetworkState()
    const kind = classifyUpdateError(error, {
      source,
      phase: 'download',
      online: netAfter.online,
      partialBytes,
    })

    if (source === 'desktop' && activeHostId && kind === 'desktop_relay_disconnected') {
      this.unreachableDesktopUntil.set(activeHostId, this.now() + DESKTOP_UNREACHABLE_TTL_MS)
      this.syncConnection()
    }

    this.patch({
      downloadingVia: null,
      downloadingStage: null,
      partialBytes,
      downloadedBytes: partialBytes,
      totalBytes,
    })
    this.setError(kind, source, 'download', false)
  }

  private async savePartial(
    release: AndroidUpdateRelease,
    source: UpdateSource,
    downloadedBytes: number,
    totalBytes: number | null
  ): Promise<void> {
    this.record = await this.store.update((cur) => ({
      ...cur,
      downloaded: null,
      pendingInstall: null,
      partial: {
        version: release.version,
        tag: release.tag,
        asset: release.asset,
        sha256: release.sha256,
        downloadedBytes,
        totalBytes,
        downloadUrl: release.downloadUrl,
        releaseUrl: release.releaseUrl,
        via: source,
      },
    }))
  }

  private async runCheck(input: {
    preferDesktop: boolean
    directOnly: boolean
  }): Promise<void> {
    const net = await this.safeNetworkState()
    if (!net.online) {
      if (this.checkIsManual) {
        this.setError('offline', 'github', 'check', false)
      } else {
        this.lastSilentFailureAt = this.now()
      }
      return
    }

    const conn = this.getConnection()
    const canTryDesktop = Boolean(conn && !this.isRelayUnsupported(conn.host.id))

    const applyManifest = async (
      manifest: AndroidReleaseManifest | null,
      via: UpdateSource,
      cachedSizeBytes: number | null = null
    ) => {
      const checkedAt = this.now()
      this.lastSilentFailureAt = null
      if (via === 'desktop' && conn) {
        this.unreachableDesktopUntil.delete(conn.host.id)
        this.unsupportedRelayUntil.delete(conn.host.id)
        this.syncConnection()
      }

      if (!manifest) {
        this.lastSilentFailureAt = checkedAt
        if (this.checkIsManual) {
          this.setError('manifest_unavailable', via, 'check', false)
        }
        return
      }

      const currentVersion = this.readCurrentVersion()
      const order = compareSemver(manifest.version, currentVersion)
      if (order === null) {
        this.lastSilentFailureAt = checkedAt
        if (this.checkIsManual) this.setError('unknown', via, 'check', false)
        return
      }
      const available = order > 0
        ? { manifest, discoveredVia: via, sizeBytes: cachedSizeBytes }
        : null
      const targetSha = available?.manifest.sha256
      this.record = await this.store.update((cur) => ({
        ...cur,
        lastCheckedAt: checkedAt,
        dismissedVersion: this.checkIsManual && cur.dismissedVersion === manifest.version ? null : cur.dismissedVersion,
        available,
        downloaded: cur.downloaded?.sha256 === targetSha ? cur.downloaded : null,
        partial: cur.partial?.sha256 === targetSha ? cur.partial : null,
        pendingInstall: cur.pendingInstall?.sha256 === targetSha ? cur.pendingInstall : null,
      }))

      if (!available) {
        await this.safeCleanupCachedApks(null)
        this.patch({
          currentVersion,
          status: this.checkIsManual ? 'up-to-date' : 'idle',
          release: null,
          partialBytes: 0,
          downloadedBytes: 0,
          totalBytes: null,
          dismissedVersion: this.record.dismissedVersion,
          errorKind: null,
        })
        return
      }

      const release = releaseFromManifest(manifest, available)
      const cached = await this.safeGetCachedApk(release.sha256, release.version)

      if (cached?.ready && cached.verified) {
        const readyRelease: AndroidUpdateRelease = {
          ...release,
          sizeBytes: cached.sizeBytes ?? release.sizeBytes,
        }
        this.record = await this.store.update((cur) => ({
          ...cur,
          partial: null,
          downloaded: {
            version: readyRelease.version,
            tag: readyRelease.tag,
            asset: readyRelease.asset,
            sha256: readyRelease.sha256,
            sizeBytes: readyRelease.sizeBytes,
            releaseUrl: readyRelease.releaseUrl,
            downloadUrl: readyRelease.downloadUrl,
            verifiedAt: this.now(),
            via,
          },
        }))
        this.patch({
          currentVersion,
          status: 'downloaded',
          release: readyRelease,
          partialBytes: 0,
          downloadedBytes: readyRelease.sizeBytes ?? 0,
          totalBytes: readyRelease.sizeBytes,
          dismissedVersion: this.record.dismissedVersion,
          errorKind: null,
        })
        return
      }

      const partialBytes = cached?.partialBytes ?? 0
      const totalBytes = cached?.totalBytes ?? release.sizeBytes
      this.patch({
        currentVersion,
        status: 'available',
        release: { ...release, sizeBytes: totalBytes },
        partialBytes,
        downloadedBytes: partialBytes,
        totalBytes,
        dismissedVersion: this.record.dismissedVersion,
        errorKind: null,
      })
    }

    // Explicit desktop check path.
    if (input.preferDesktop) {
      if (!conn) {
        if (this.checkIsManual) this.setError('desktop_relay_disconnected', 'desktop', 'check', false)
        return
      }
      try {
        const res = await conn.fetchLatest(this.checkIsManual)
        if (!res.available) {
          await applyManifest(null, 'desktop')
          return
        }
        const manifest = parseAndroidReleaseManifest(res.manifest)
        if (!manifest) {
          if (this.checkIsManual) this.setError('checksum_mismatch', 'desktop', 'check', false)
          return
        }
        await applyManifest(manifest, 'desktop', res.cachedSizeBytes ?? null)
        return
      } catch (error) {
        if (isOlderDesktopRelayError(error)) {
          this.unsupportedRelayUntil.set(conn.host.id, this.now() + UNSUPPORTED_RELAY_TTL_MS)
          this.syncConnection()
        }
        const kind = classifyUpdateError(error, {
          source: 'desktop',
          phase: 'check',
          online: (await this.safeNetworkState()).online,
        })
        if (kind === 'desktop_relay_disconnected') {
          this.unreachableDesktopUntil.set(conn.host.id, this.now() + DESKTOP_UNREACHABLE_TTL_MS)
          this.syncConnection()
        }
        if (this.checkIsManual) {
          this.setError(kind, 'desktop', 'check', false)
        } else {
          this.lastSilentFailureAt = this.now()
        }
        return
      }
    }

    // Default path: direct GitHub first, transparently fall back to paired desktop unless directOnly.
    try {
      const raw = await this.nativeUpdater.fetchGitHubManifest()
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        throw Object.assign(new Error('Invalid manifest JSON'), { code: 'INVALID_MANIFEST' })
      }
      const manifest = parseAndroidReleaseManifest(parsed)
      if (!manifest) {
        throw Object.assign(new Error('Invalid manifest schema'), { code: 'INVALID_MANIFEST' })
      }
      await applyManifest(manifest, 'github')
      return
    } catch (directError) {
      const directCode = extractErrorCode(directError)
      const directReachableFailure =
        directCode === 'TIMEOUT' ||
        directCode === 'NETWORK_ERROR' ||
        directCode === 'TLS_ERROR' ||
        directCode === 'HTTP_ERROR' ||
        directCode === 'RATE_LIMITED' ||
        directCode === 'REDIRECT_BLOCKED' ||
        directCode === ''

      if (!input.directOnly && canTryDesktop && conn && directReachableFailure) {
        if (this.checkIsManual) {
          this.patch({ checkingVia: 'desktop' })
        }
        try {
          const res = await conn.fetchLatest(this.checkIsManual)
          if (!res.available) {
            await applyManifest(null, 'desktop')
            return
          }
          const manifest = parseAndroidReleaseManifest(res.manifest)
          if (manifest) {
            await applyManifest(manifest, 'desktop', res.cachedSizeBytes ?? null)
            return
          }
        } catch (relayError) {
          if (isOlderDesktopRelayError(relayError)) {
            this.unsupportedRelayUntil.set(conn.host.id, this.now() + UNSUPPORTED_RELAY_TTL_MS)
            this.syncConnection()
          } else {
            const relayKind = classifyUpdateError(relayError, {
              source: 'desktop',
              phase: 'check',
              online: (await this.safeNetworkState()).online,
            })
            if (relayKind === 'desktop_relay_disconnected') {
              // Desktop itself is offline/unreachable (e.g. phone is outside on 5G):
              // mark desktop temporarily unreachable and preserve the original GitHub error
              // so the user still gets accurate GitHub/proxy + browser guidance.
              this.unreachableDesktopUntil.set(conn.host.id, this.now() + DESKTOP_UNREACHABLE_TTL_MS)
              this.syncConnection()
            } else if (this.checkIsManual) {
              this.setError(relayKind, 'desktop', 'check', false)
              return
            }
          }
        }
      }

      if (!this.checkIsManual) {
        this.lastSilentFailureAt = this.now()
        return
      }

      const kind = classifyUpdateError(directError, {
        source: 'github',
        phase: 'check',
        online: (await this.safeNetworkState()).online,
      })
      this.setError(kind, 'github', 'check', false)
    }
  }

  private armInstallWatchdog(): void {
    this.clearInstallWatchdog()
    this.installWatchdogTimer = setTimeout(() => {
      this.installWatchdogTimer = null
      if (this.snapshot.status === 'installing' && !this.sawBackgroundDuringInstall) {
        this.relaxInstallingToDownloaded(false)
      }
    }, this.installWatchdogMs)
  }

  private clearInstallWatchdog(): void {
    if (this.installWatchdogTimer) {
      clearTimeout(this.installWatchdogTimer)
      this.installWatchdogTimer = null
    }
  }

  private relaxInstallingToDownloaded(cancelledHint: boolean): void {
    this.installLaunchedAt = null
    this.sawBackgroundDuringInstall = false
    this.clearInstallWatchdog()
    this.patch({
      status: 'downloaded',
      installCancelledHint: cancelledHint,
    })
  }

  private handleProgress(event: DownloadProgressEvent): void {
    if (!this.activeDownloadId || event.downloadId !== this.activeDownloadId) return
    if (event.phase === 'verifying') {
      this.patch({
        status: 'verifying',
        downloadingStage: 'downloading',
        downloadedBytes: event.bytesWritten,
        totalBytes: event.totalBytes ?? this.snapshot.totalBytes,
      })
      return
    }
    this.patch({
      status: 'downloading',
      downloadingStage: 'downloading',
      downloadedBytes: event.bytesWritten,
      totalBytes: event.totalBytes ?? this.snapshot.totalBytes,
    })
  }

  private setError(
    kind: UpdateErrorKind,
    source: UpdateSource,
    phase: 'check' | 'download' | 'install',
    canRetryInstall: boolean
  ): void {
    this.patch({
      status: 'error',
      errorKind: kind,
      errorSource: source,
      errorPhase: phase,
      errorCanRetryInstall: canRetryInstall,
    })
  }

  private readCurrentVersion(): string {
    try {
      return this.nativeUpdater.getInstalledAppInfo().versionName || this.snapshot.currentVersion
    } catch {
      return this.snapshot.currentVersion
    }
  }

  private safeCanRequestPackageInstalls(): boolean {
    try {
      return this.nativeUpdater.canRequestPackageInstalls()
    } catch {
      return false
    }
  }

  private async safeGetCachedApk(sha256: string, version: string) {
    try {
      return await this.nativeUpdater.getCachedApk(sha256, version)
    } catch {
      return null
    }
  }

  private async safeCleanupCachedApks(keepSha256: string | null) {
    try {
      await this.nativeUpdater.cleanupCachedApks(keepSha256)
    } catch {
      // Best effort cache cleanup.
    }
  }

  private async safeNetworkState(): Promise<NetworkProbeResult> {
    try {
      return await this.getNetworkState()
    } catch {
      return { online: true, cellular: false }
    }
  }

  private patch(next: Partial<AndroidUpdateSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...next }
    for (const listener of this.listeners) {
      listener(this.snapshot)
    }
  }
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
