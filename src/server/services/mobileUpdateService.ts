import { createHash, randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SettingsService } from './settingsService.js'
import { getNetworkProxyFetchOptions, normalizeNetworkSettings } from './networkSettings.js'

export const ANDROID_RELEASE_MANIFEST_URL =
  'https://github.com/NanmiCoder/cc-haha/releases/latest/download/mobile-release-android.json'
export const GITHUB_RELEASES_BASE_URL = 'https://github.com/NanmiCoder/cc-haha/releases'
export const MOBILE_UPDATE_HEADER = 'X-CC-Haha-Mobile-Update'

const MAX_MANIFEST_BYTES = 64 * 1024
const MAX_APK_BYTES = 250 * 1024 * 1024
const MANIFEST_CACHE_TTL_MS = 60_000
const NEGATIVE_MANIFEST_CACHE_TTL_MS = 15_000
const APK_CACHE_TTL_MS = 24 * 60 * 60_000
const STALE_TMP_TTL_MS = 30 * 60_000
const MANIFEST_TIMEOUT_MS = 15_000
const APK_CHUNK_IDLE_TIMEOUT_MS = 30_000
const APK_TOTAL_TIMEOUT_MS = 10 * 60_000
const PREPARE_LIVENESS_MS = 60_000
const PREPARE_LIVENESS_CHECK_MS = 5_000
const FAILURE_RETENTION_MS = 30_000
const REFRESH_RATE_WINDOW_MS = 60_000
const REFRESH_RATE_LIMIT = 10
const UPSTREAM_PULL_RATE_WINDOW_MS = 60_000
const UPSTREAM_PULL_RATE_LIMIT = 3
const MAX_REDIRECTS = 5

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const TAG_RE = /^v\d+\.\d+\.\d+$/
const COMMIT_RE = /^[a-f0-9]{40}$/
const SHA256_RE = /^[a-f0-9]{64}$/
const UUID_RE = /^[a-f0-9-]{36}$/
const ASSET_RE = /^cc-haha-mobile-[\w.-]+\.apk$/

const EXACT_GITHUB_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
])

const BLOCKED_GITHUB_USERCONTENT_HOSTS = new Set([
  'raw.githubusercontent.com',
  'gist.githubusercontent.com',
  'camo.githubusercontent.com',
  'avatars.githubusercontent.com',
  'user-images.githubusercontent.com',
  'private-user-images.githubusercontent.com',
  'cloud.githubusercontent.com',
])

export type AndroidReleaseManifest = {
  schemaVersion: 1
  platform: 'android'
  tag: string
  commit: string
  fingerprint: string
  version: string
  buildId: string
  deliveredAt: string
  destination: 'github-release'
  asset: string
  sha256: string
}

export type MobileUpdateErrorCode =
  | 'MANIFEST_NOT_PUBLISHED'
  | 'RELEASE_CHANGED'
  | 'PROXY_UNAVAILABLE'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_UNREACHABLE'
  | 'UPSTREAM_HTTP_ERROR'
  | 'UPSTREAM_REDIRECT_BLOCKED'
  | 'UPSTREAM_INVALID_MANIFEST'
  | 'UPSTREAM_SHA256_MISMATCH'
  | 'RATE_LIMITED'

export class MobileUpdateServiceError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: MobileUpdateErrorCode,
    message: string,
    public readonly manifest?: AndroidReleaseManifest,
  ) {
    super(message)
    this.name = 'MobileUpdateServiceError'
  }
}

export type LatestAndroidReleaseResult =
  | {
      supported: true
      available: true
      manifest: AndroidReleaseManifest
      releaseUrl: string
      cachedSizeBytes: number | null
    }
  | {
      supported: true
      available: false
      reason: 'not_published'
      manifest: null
    }

export type PrepareApkResult =
  | {
      supported: true
      status: 'ready'
      sha256: string
      sizeBytes: number
      manifest: AndroidReleaseManifest
    }
  | {
      supported: true
      status: 'preparing'
      sha256: string
      downloadedBytes: number
      totalBytes: number | null
      manifest: AndroidReleaseManifest
    }
  | {
      supported: true
      status: 'idle'
      sha256: string
      manifest: AndroidReleaseManifest
    }
  | {
      supported: true
      status: 'failed'
      sha256: string
      code: MobileUpdateErrorCode
      error: string
      manifest: AndroidReleaseManifest
    }

export type ResolvedApkCache = {
  filePath: string
  manifest: AndroidReleaseManifest
  sizeBytes: number
}

type FetchLike = (url: string, init?: RequestInit & { proxy?: unknown }) => Promise<Response>

export type MobileUpdateServiceOptions = {
  cacheDir?: string
  manifestUrl?: string
  apkUrlBuilder?: (manifest: AndroidReleaseManifest) => string
  isAllowedRedirectUrl?: (url: URL) => boolean
  fetch?: FetchLike
  readUserSettings?: () => Promise<Record<string, unknown>>
  resolveProxyOptions?: (targetUrl: string) => Promise<Record<string, unknown>>
  now?: () => number
  manifestTimeoutMs?: number
  apkChunkIdleTimeoutMs?: number
  apkTotalTimeoutMs?: number
  prepareLivenessMs?: number
  maxApkBytes?: number
  refreshRateLimit?: number
  upstreamPullRateLimit?: number
}

export function parseAndroidReleaseManifest(value: unknown): AndroidReleaseManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MobileUpdateServiceError(502, 'UPSTREAM_INVALID_MANIFEST', 'Invalid Android release manifest')
  }
  const item = value as Record<string, unknown>
  if (
    item.schemaVersion !== 1 ||
    item.platform !== 'android' ||
    item.destination !== 'github-release' ||
    typeof item.tag !== 'string' || !TAG_RE.test(item.tag) ||
    typeof item.commit !== 'string' || !COMMIT_RE.test(item.commit) ||
    typeof item.fingerprint !== 'string' || !SHA256_RE.test(item.fingerprint) ||
    typeof item.version !== 'string' || !SEMVER_RE.test(item.version) ||
    typeof item.buildId !== 'string' || !UUID_RE.test(item.buildId) ||
    typeof item.deliveredAt !== 'string' || !Number.isFinite(Date.parse(item.deliveredAt)) ||
    typeof item.asset !== 'string' || !ASSET_RE.test(item.asset) ||
    typeof item.sha256 !== 'string' || !SHA256_RE.test(item.sha256)
  ) {
    throw new MobileUpdateServiceError(502, 'UPSTREAM_INVALID_MANIFEST', 'Invalid Android release manifest')
  }
  return {
    schemaVersion: 1,
    platform: 'android',
    tag: item.tag,
    commit: item.commit,
    fingerprint: item.fingerprint,
    version: item.version,
    buildId: item.buildId,
    deliveredAt: item.deliveredAt,
    destination: 'github-release',
    asset: item.asset,
    sha256: item.sha256,
  }
}

export function isTrustedGitHubReleaseUrl(url: URL): boolean {
  if (url.protocol !== 'https:') return false
  if (url.username || url.password) return false
  if (url.port && url.port !== '443') return false
  const host = url.hostname.toLowerCase()
  if (EXACT_GITHUB_HOSTS.has(host)) return true
  if (
    host.endsWith('.githubusercontent.com') &&
    !host.startsWith('.') &&
    !host.includes('..') &&
    !BLOCKED_GITHUB_USERCONTENT_HOSTS.has(host)
  ) {
    return true
  }
  return false
}

export function buildGitHubApkUrl(manifest: AndroidReleaseManifest): string {
  return `${GITHUB_RELEASES_BASE_URL}/download/${manifest.tag}/${manifest.asset}`
}

export function buildGitHubReleaseUrl(manifest: AndroidReleaseManifest): string {
  return `${GITHUB_RELEASES_BASE_URL}/tag/${manifest.tag}`
}

function isValidHttpProxyUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && Boolean(parsed.hostname)
  } catch {
    return false
  }
}

export function resolveDesktopUpdateProxyFetchOptions(
  userSettings: Record<string, unknown>,
  targetUrl: string,
): Record<string, unknown> {
  const network = normalizeNetworkSettings(userSettings)
  const rawUpdateProxy = userSettings.updateProxy
  const updateProxy = rawUpdateProxy && typeof rawUpdateProxy === 'object' && !Array.isArray(rawUpdateProxy)
    ? rawUpdateProxy as { mode?: unknown; url?: unknown }
    : null

  let effective = network
  if (
    updateProxy?.mode === 'manual' &&
    typeof updateProxy.url === 'string' &&
    isValidHttpProxyUrl(updateProxy.url.trim())
  ) {
    effective = { ...network, proxy: { mode: 'manual', url: updateProxy.url.trim() } }
  } else if (network.proxy.mode === 'manual' && isValidHttpProxyUrl(network.proxy.url)) {
    effective = network
  } else {
    // Even if AI providers use direct mode in China, GitHub Releases should still
    // honor the OS system proxy bridge when available.
    effective = { ...network, proxy: { mode: 'system', url: '' } }
  }

  let options: Record<string, unknown>
  try {
    options = getNetworkProxyFetchOptions(effective, targetUrl) as Record<string, unknown>
  } catch {
    throw new MobileUpdateServiceError(502, 'PROXY_UNAVAILABLE', 'Desktop proxy is unavailable')
  }
  if (typeof Bun !== 'undefined' && !options.proxy) {
    return { ...options, proxy: false as const }
  }
  return options
}

function defaultCacheDir(): string {
  const uid = typeof process.getuid === 'function' ? String(process.getuid()) : 'user'
  return path.join(os.tmpdir(), `cc-haha-mobile-updates-${uid}`)
}

type CachedManifestEntry = {
  fetchedAt: number
  available: boolean
  manifest: AndroidReleaseManifest | null
}

type VerifiedDiskEntry = {
  sha256: string
  size: number
  mtimeMs: number
}

type InFlightDownload = {
  sha256: string
  promise: Promise<ResolvedApkCache>
  controller: AbortController
  waiters: number
  detachedUntil: number
  livenessTimer: ReturnType<typeof setInterval> | null
  downloadedBytes: number
  totalBytes: number | null
}

type RecentFailure = {
  sha256: string
  code: MobileUpdateErrorCode
  error: string
  failedAt: number
}

export class MobileUpdateService {
  private readonly cacheDir: string
  private readonly manifestUrl: string
  private readonly apkUrlBuilder: (manifest: AndroidReleaseManifest) => string
  private readonly isAllowedRedirectUrl: (url: URL) => boolean
  private readonly fetchImpl: FetchLike
  private readonly resolveProxyOptions: (targetUrl: string) => Promise<Record<string, unknown>>
  private readonly now: () => number
  private readonly manifestTimeoutMs: number
  private readonly apkChunkIdleTimeoutMs: number
  private readonly apkTotalTimeoutMs: number
  private readonly prepareLivenessMs: number
  private readonly maxApkBytes: number
  private readonly refreshRateLimit: number
  private readonly upstreamPullRateLimit: number

  private manifestCache: CachedManifestEntry | null = null
  private verifiedDisk: VerifiedDiskEntry | null = null
  private inFlight = new Map<string, InFlightDownload>()
  private lastFailure: RecentFailure | null = null
  private refreshTimestamps: number[] = []
  private upstreamPullTimestamps: number[] = []

  constructor(options: MobileUpdateServiceOptions = {}) {
    this.cacheDir = options.cacheDir ?? defaultCacheDir()
    this.manifestUrl = options.manifestUrl ?? ANDROID_RELEASE_MANIFEST_URL
    this.apkUrlBuilder = options.apkUrlBuilder ?? buildGitHubApkUrl
    this.isAllowedRedirectUrl = options.isAllowedRedirectUrl ?? isTrustedGitHubReleaseUrl
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init))
    const readUserSettings = options.readUserSettings ?? (() => new SettingsService().getUserSettings())
    this.resolveProxyOptions = options.resolveProxyOptions ?? (async (targetUrl) => {
      const settings = await readUserSettings()
      return resolveDesktopUpdateProxyFetchOptions(settings, targetUrl)
    })
    this.now = options.now ?? Date.now
    this.manifestTimeoutMs = options.manifestTimeoutMs ?? MANIFEST_TIMEOUT_MS
    this.apkChunkIdleTimeoutMs = options.apkChunkIdleTimeoutMs ?? APK_CHUNK_IDLE_TIMEOUT_MS
    this.apkTotalTimeoutMs = options.apkTotalTimeoutMs ?? APK_TOTAL_TIMEOUT_MS
    this.prepareLivenessMs = options.prepareLivenessMs ?? PREPARE_LIVENESS_MS
    this.maxApkBytes = options.maxApkBytes ?? MAX_APK_BYTES
    this.refreshRateLimit = options.refreshRateLimit ?? REFRESH_RATE_LIMIT
    this.upstreamPullRateLimit = options.upstreamPullRateLimit ?? UPSTREAM_PULL_RATE_LIMIT
  }

  async getLatestManifest(options: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<LatestAndroidReleaseResult> {
    const now = this.now()
    if (options.refresh) {
      this.consumeRateLimit(this.refreshTimestamps, REFRESH_RATE_WINDOW_MS, this.refreshRateLimit, 'Too many update refresh requests')
    } else if (this.manifestCache) {
      const ttl = this.manifestCache.available ? MANIFEST_CACHE_TTL_MS : NEGATIVE_MANIFEST_CACHE_TTL_MS
      if (now - this.manifestCache.fetchedAt < ttl) {
        return this.formatManifestResult(this.manifestCache.manifest)
      }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('manifest_timeout')), this.manifestTimeoutMs)
    const onCallerAbort = () => controller.abort(options.signal?.reason)
    if (options.signal?.aborted) onCallerAbort()
    else options.signal?.addEventListener('abort', onCallerAbort, { once: true })

    try {
      const response = await this.fetchWithValidatedRedirects(this.manifestUrl, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      })

      if (response.status === 404) {
        await response.body?.cancel().catch(() => {})
        this.manifestCache = { fetchedAt: this.now(), available: false, manifest: null }
        return this.formatManifestResult(null)
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => {})
        throw new MobileUpdateServiceError(502, 'UPSTREAM_HTTP_ERROR', `GitHub returned HTTP ${response.status}`)
      }

      const raw = await readBoundedText(response, MAX_MANIFEST_BYTES)
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        throw new MobileUpdateServiceError(502, 'UPSTREAM_INVALID_MANIFEST', 'GitHub returned invalid JSON manifest')
      }
      const manifest = parseAndroidReleaseManifest(parsed)
      this.manifestCache = { fetchedAt: this.now(), available: true, manifest }
      return this.formatManifestResult(manifest)
    } catch (error) {
      throw this.classifyUpstreamError(error, controller.signal, options.signal)
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onCallerAbort)
    }
  }

  /**
   * Decouples desktop's potentially multi-minute GitHub APK pull from the phone's
   * `/apk` HTTP response headers so neither OkHttp's 30s read timeout nor
   * Cloudflare Quick Tunnel's 100s TTFB timeout aborts slow upstream downloads.
   */
  async prepareApk(options: { expectedSha256?: string; start: boolean; signal?: AbortSignal }): Promise<PrepareApkResult> {
    const manifest = await this.resolveTargetManifest(options.expectedSha256, options.signal)
    this.ensureSecureCacheDir()

    const cached = await this.tryReadVerifiedDiskApk(manifest.sha256)
    if (cached) {
      return {
        supported: true,
        status: 'ready',
        sha256: manifest.sha256,
        sizeBytes: cached.sizeBytes,
        manifest,
      }
    }

    const live = this.getLiveFlight(manifest.sha256)
    if (live) {
      this.extendDetachedLiveness(live)
      return {
        supported: true,
        status: 'preparing',
        sha256: manifest.sha256,
        downloadedBytes: live.downloadedBytes,
        totalBytes: live.totalBytes,
        manifest,
      }
    }

    if (!options.start) {
      const failure = this.lastFailure
      if (failure && failure.sha256 === manifest.sha256 && this.now() - failure.failedAt < FAILURE_RETENTION_MS) {
        return {
          supported: true,
          status: 'failed',
          sha256: manifest.sha256,
          code: failure.code,
          error: failure.error,
          manifest,
        }
      }
      return {
        supported: true,
        status: 'idle',
        sha256: manifest.sha256,
        manifest,
      }
    }

    if (this.lastFailure?.sha256 === manifest.sha256) {
      this.lastFailure = null
    }
    const flight = this.startFlight(manifest, true)
    return {
      supported: true,
      status: 'preparing',
      sha256: manifest.sha256,
      downloadedBytes: flight.downloadedBytes,
      totalBytes: flight.totalBytes,
      manifest,
    }
  }

  async ensureApkFile(options: { expectedSha256?: string; signal?: AbortSignal } = {}): Promise<ResolvedApkCache> {
    const manifest = await this.resolveTargetManifest(options.expectedSha256, options.signal)
    this.ensureSecureCacheDir()
    const cached = await this.tryReadVerifiedDiskApk(manifest.sha256)
    if (cached) {
      return { filePath: cached.filePath, manifest, sizeBytes: cached.sizeBytes }
    }
    return this.joinOrStartUpstreamDownload(manifest, options.signal)
  }

  private async resolveTargetManifest(
    expectedSha256: string | undefined,
    signal?: AbortSignal,
  ): Promise<AndroidReleaseManifest> {
    let latest = await this.getLatestManifest({ refresh: false, signal })
    if (
      expectedSha256 &&
      (!latest.available || latest.manifest.sha256 !== expectedSha256)
    ) {
      // Refresh once when the phone asks for a newer hash than our 60s cache.
      try {
        latest = await this.getLatestManifest({ refresh: true, signal })
      } catch (error) {
        if (!(error instanceof MobileUpdateServiceError && error.code === 'RATE_LIMITED')) {
          throw error
        }
      }
    }

    if (!latest.available) {
      throw new MobileUpdateServiceError(404, 'MANIFEST_NOT_PUBLISHED', 'Android release not published yet')
    }
    if (expectedSha256 && expectedSha256 !== latest.manifest.sha256) {
      throw new MobileUpdateServiceError(409, 'RELEASE_CHANGED', 'A newer Android release is available', latest.manifest)
    }
    return latest.manifest
  }

  private formatManifestResult(manifest: AndroidReleaseManifest | null): LatestAndroidReleaseResult {
    if (!manifest) {
      return { supported: true, available: false, reason: 'not_published', manifest: null }
    }
    const cachedSizeBytes = this.peekCachedApkSize(manifest.sha256)
    return {
      supported: true,
      available: true,
      manifest,
      releaseUrl: buildGitHubReleaseUrl(manifest),
      cachedSizeBytes,
    }
  }

  private peekCachedApkSize(sha256: string): number | null {
    const filePath = path.join(this.cacheDir, `${sha256}.apk`)
    try {
      const stat = fs.lstatSync(filePath)
      if (!stat.isFile() || stat.isSymbolicLink()) return null
      if (this.now() - stat.mtimeMs > APK_CACHE_TTL_MS) return null
      return stat.size
    } catch {
      return null
    }
  }

  private async tryReadVerifiedDiskApk(sha256: string): Promise<{ filePath: string; sizeBytes: number } | null> {
    const filePath = path.join(this.cacheDir, `${sha256}.apk`)
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(filePath)
    } catch {
      return null
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > this.maxApkBytes) {
      safeUnlink(filePath)
      return null
    }
    if (this.now() - stat.mtimeMs > APK_CACHE_TTL_MS) {
      safeUnlink(filePath)
      if (this.verifiedDisk?.sha256 === sha256) this.verifiedDisk = null
      return null
    }
    if (
      this.verifiedDisk &&
      this.verifiedDisk.sha256 === sha256 &&
      this.verifiedDisk.size === stat.size &&
      this.verifiedDisk.mtimeMs === stat.mtimeMs
    ) {
      return { filePath, sizeBytes: stat.size }
    }
    const digest = await hashFileSha256(filePath)
    if (digest !== sha256) {
      safeUnlink(filePath)
      return null
    }
    this.verifiedDisk = { sha256, size: stat.size, mtimeMs: stat.mtimeMs }
    return { filePath, sizeBytes: stat.size }
  }

  private getLiveFlight(sha256: string): InFlightDownload | null {
    const existing = this.inFlight.get(sha256)
    if (!existing || existing.controller.signal.aborted) return null
    return existing
  }

  private extendDetachedLiveness(flight: InFlightDownload) {
    flight.detachedUntil = Math.max(flight.detachedUntil, this.now() + this.prepareLivenessMs)
    if (!flight.livenessTimer) {
      const interval = Math.min(PREPARE_LIVENESS_CHECK_MS, Math.max(25, Math.floor(this.prepareLivenessMs / 4)))
      flight.livenessTimer = setInterval(() => {
        if (flight.controller.signal.aborted) {
          this.clearFlightTimer(flight)
          return
        }
        if (flight.waiters === 0 && this.now() > flight.detachedUntil) {
          this.abortFlight(flight, new Error('prepare_liveness_expired'))
        }
      }, interval)
      flight.livenessTimer.unref?.()
    }
  }

  private clearFlightTimer(flight: InFlightDownload) {
    if (flight.livenessTimer) {
      clearInterval(flight.livenessTimer)
      flight.livenessTimer = null
    }
  }

  private abortFlight(flight: InFlightDownload, reason: Error) {
    // Delete synchronously BEFORE aborting so no concurrent/immediate retry can
    // attach to an already-aborted singleflight entry.
    if (this.inFlight.get(flight.sha256) === flight) {
      this.inFlight.delete(flight.sha256)
    }
    this.clearFlightTimer(flight)
    if (!flight.controller.signal.aborted) {
      flight.controller.abort(reason)
    }
  }

  private startFlight(manifest: AndroidReleaseManifest, detached: boolean): InFlightDownload {
    this.consumeRateLimit(
      this.upstreamPullTimestamps,
      UPSTREAM_PULL_RATE_WINDOW_MS,
      this.upstreamPullRateLimit,
      'Too many upstream APK download attempts',
    )
    const controller = new AbortController()
    const entry: InFlightDownload = {
      sha256: manifest.sha256,
      controller,
      waiters: 0,
      detachedUntil: 0,
      livenessTimer: null,
      downloadedBytes: 0,
      totalBytes: null,
      promise: Promise.resolve({ filePath: '', manifest, sizeBytes: 0 }),
    }
    if (detached) {
      this.extendDetachedLiveness(entry)
    }
    entry.promise = this.downloadAndVerifyUpstreamApk(manifest, entry)
      .then((result) => {
        if (this.lastFailure?.sha256 === manifest.sha256) {
          this.lastFailure = null
        }
        return result
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          const classified = error instanceof MobileUpdateServiceError
            ? error
            : new MobileUpdateServiceError(502, 'UPSTREAM_UNREACHABLE', 'Desktop could not download APK from GitHub')
          this.lastFailure = {
            sha256: manifest.sha256,
            code: classified.code,
            error: classified.message,
            failedAt: this.now(),
          }
        }
        throw error
      })
      .finally(() => {
        this.clearFlightTimer(entry)
        if (this.inFlight.get(manifest.sha256) === entry) {
          this.inFlight.delete(manifest.sha256)
        }
      })
    // Prevent unhandled rejections if a detached pull fails or every waiter leaves.
    entry.promise.catch(() => {})
    this.inFlight.set(manifest.sha256, entry)
    return entry
  }

  private async joinOrStartUpstreamDownload(
    manifest: AndroidReleaseManifest,
    callerSignal?: AbortSignal,
  ): Promise<ResolvedApkCache> {
    if (callerSignal?.aborted) {
      throw callerSignal.reason ?? new Error('Aborted')
    }

    const flight = this.getLiveFlight(manifest.sha256) ?? this.startFlight(manifest, false)
    flight.waiters += 1
    let released = false
    const release = () => {
      if (released) return
      released = true
      flight.waiters = Math.max(0, flight.waiters - 1)
      if (flight.waiters === 0 && this.now() > flight.detachedUntil) {
        this.abortFlight(flight, new Error('all_waiters_aborted'))
      }
    }

    if (!callerSignal) {
      try {
        return await flight.promise
      } finally {
        release()
      }
    }

    return new Promise<ResolvedApkCache>((resolve, reject) => {
      const onAbort = () => {
        release()
        reject(callerSignal.reason ?? new Error('Aborted'))
      }
      callerSignal.addEventListener('abort', onAbort, { once: true })
      flight.promise.then(
        (result) => {
          callerSignal.removeEventListener('abort', onAbort)
          release()
          resolve(result)
        },
        (error) => {
          callerSignal.removeEventListener('abort', onAbort)
          release()
          reject(error)
        },
      )
    })
  }

  private async downloadAndVerifyUpstreamApk(
    manifest: AndroidReleaseManifest,
    flight: InFlightDownload,
  ): Promise<ResolvedApkCache> {
    const signal = flight.controller.signal
    const controller = new AbortController()
    let timedOut = false
    const totalTimer = setTimeout(() => {
      timedOut = true
      controller.abort(new Error('apk_total_timeout'))
    }, this.apkTotalTimeoutMs)
    const onParentAbort = () => controller.abort(signal.reason)
    if (signal.aborted) onParentAbort()
    else signal.addEventListener('abort', onParentAbort, { once: true })

    const tmpPath = path.join(this.cacheDir, `${manifest.sha256}.apk.tmp.${randomBytes(6).toString('hex')}`)
    const finalPath = path.join(this.cacheDir, `${manifest.sha256}.apk`)

    let handle: fs.promises.FileHandle | null = null
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        timedOut = true
        controller.abort(new Error('apk_idle_timeout'))
      }, this.apkChunkIdleTimeoutMs)
    }

    try {
      resetIdleTimer()
      const apkUrl = this.apkUrlBuilder(manifest)
      const response = await this.fetchWithValidatedRedirects(apkUrl, {
        headers: { Accept: 'application/vnd.android.package-archive, application/octet-stream' },
        signal: controller.signal,
      })

      if (response.status === 404) {
        await response.body?.cancel().catch(() => {})
        throw new MobileUpdateServiceError(404, 'MANIFEST_NOT_PUBLISHED', 'Android APK asset not found on GitHub')
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => {})
        throw new MobileUpdateServiceError(502, 'UPSTREAM_HTTP_ERROR', `GitHub APK download returned HTTP ${response.status}`)
      }

      const contentLength = Number(response.headers.get('content-length'))
      if (Number.isFinite(contentLength) && contentLength > 0) {
        if (contentLength > this.maxApkBytes) {
          await response.body?.cancel().catch(() => {})
          throw new MobileUpdateServiceError(502, 'UPSTREAM_SHA256_MISMATCH', 'Upstream APK exceeds size limit')
        }
        flight.totalBytes = contentLength
      }
      if (!response.body) {
        throw new MobileUpdateServiceError(502, 'UPSTREAM_HTTP_ERROR', 'Upstream APK body is empty')
      }

      // Use async file handle writes so downloading 60–100 MB APKs never blocks
      // the main Bun server event loop serving desktop UI and chat WebSockets.
      handle = await fs.promises.open(tmpPath, 'wx', 0o600)
      const hasher = createHash('sha256')
      const reader = response.body.getReader()
      let totalBytes = 0
      let magic0: number | null = null
      let magic1: number | null = null

      while (true) {
        resetIdleTimer()
        const { done, value } = await reader.read()
        if (done) break
        if (!value || value.byteLength === 0) continue

        if (magic0 === null) {
          magic0 = value[0]!
          if (value.byteLength > 1) magic1 = value[1]!
        } else if (magic1 === null) {
          magic1 = value[0]!
        }

        totalBytes += value.byteLength
        if (totalBytes > this.maxApkBytes) {
          await reader.cancel().catch(() => {})
          throw new MobileUpdateServiceError(502, 'UPSTREAM_SHA256_MISMATCH', 'Upstream APK exceeded 250 MiB limit')
        }
        hasher.update(value)
        await writeAll(handle, value)
        flight.downloadedBytes = totalBytes
      }

      await handle.sync()
      await handle.close()
      handle = null

      if (magic0 !== 0x50 || magic1 !== 0x4b) {
        throw new MobileUpdateServiceError(502, 'UPSTREAM_SHA256_MISMATCH', 'Upstream file is not a valid APK archive')
      }

      const digest = hasher.digest('hex')
      if (digest !== manifest.sha256) {
        throw new MobileUpdateServiceError(502, 'UPSTREAM_SHA256_MISMATCH', 'Upstream APK SHA-256 verification failed')
      }

      await fs.promises.rename(tmpPath, finalPath)
      const stat = await fs.promises.stat(finalPath)
      this.verifiedDisk = { sha256: manifest.sha256, size: stat.size, mtimeMs: stat.mtimeMs }
      this.pruneCache(manifest.sha256)
      return { filePath: finalPath, manifest, sizeBytes: stat.size }
    } catch (error) {
      if (handle !== null) {
        try { await handle.close() } catch {}
        handle = null
      }
      safeUnlink(tmpPath)
      if (timedOut) {
        throw new MobileUpdateServiceError(504, 'UPSTREAM_TIMEOUT', 'Desktop timed out downloading APK from GitHub')
      }
      throw this.classifyUpstreamError(error, controller.signal, signal)
    } finally {
      if (idleTimer) clearTimeout(idleTimer)
      clearTimeout(totalTimer)
      signal.removeEventListener('abort', onParentAbort)
    }
  }

  private async fetchWithValidatedRedirects(
    initialUrl: string,
    init: { headers: Record<string, string>; signal: AbortSignal },
  ): Promise<Response> {
    let currentUrl = initialUrl
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const proxyOptions = await this.resolveProxyOptions(currentUrl)
      const response = await this.fetchImpl(currentUrl, {
        ...proxyOptions,
        method: 'GET',
        redirect: 'manual',
        headers: init.headers,
        signal: init.signal,
      })

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        await response.body?.cancel().catch(() => {})
        if (!location || hop === MAX_REDIRECTS) {
          throw new MobileUpdateServiceError(502, 'UPSTREAM_REDIRECT_BLOCKED', 'Blocked invalid or excessive upstream redirect')
        }
        let resolved: URL
        try {
          resolved = new URL(location, currentUrl)
        } catch {
          throw new MobileUpdateServiceError(502, 'UPSTREAM_REDIRECT_BLOCKED', 'Blocked malformed upstream redirect')
        }
        if (!this.isAllowedRedirectUrl(resolved)) {
          throw new MobileUpdateServiceError(502, 'UPSTREAM_REDIRECT_BLOCKED', 'Blocked redirect outside GitHub release hosts')
        }
        currentUrl = resolved.toString()
        continue
      }

      return response
    }
    throw new MobileUpdateServiceError(502, 'UPSTREAM_REDIRECT_BLOCKED', 'Too many upstream redirects')
  }

  private classifyUpstreamError(
    error: unknown,
    internalSignal: AbortSignal,
    callerSignal?: AbortSignal,
  ): Error {
    if (error instanceof MobileUpdateServiceError) return error
    if (callerSignal?.aborted) {
      return error instanceof Error ? error : new Error('Aborted')
    }
    if (internalSignal.aborted) {
      return new MobileUpdateServiceError(504, 'UPSTREAM_TIMEOUT', 'Desktop timed out connecting to GitHub')
    }
    const message = error instanceof Error ? error.message : String(error)
    if (/timeout|timed out|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/i.test(message)) {
      return new MobileUpdateServiceError(504, 'UPSTREAM_TIMEOUT', 'Desktop timed out connecting to GitHub')
    }
    if (/proxy|407|ECONNREFUSED.*127\.0\.0\.1/i.test(message)) {
      return new MobileUpdateServiceError(502, 'PROXY_UNAVAILABLE', 'Desktop proxy could not reach GitHub')
    }
    return new MobileUpdateServiceError(502, 'UPSTREAM_UNREACHABLE', 'Desktop could not reach GitHub')
  }

  private consumeRateLimit(bucket: number[], windowMs: number, limit: number, message: string) {
    const now = this.now()
    while (bucket.length > 0 && now - bucket[0]! >= windowMs) {
      bucket.shift()
    }
    if (bucket.length >= limit) {
      throw new MobileUpdateServiceError(429, 'RATE_LIMITED', message)
    }
    bucket.push(now)
  }

  private ensureSecureCacheDir() {
    fs.mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 })
    const stat = fs.lstatSync(this.cacheDir)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new MobileUpdateServiceError(502, 'UPSTREAM_UNREACHABLE', 'Mobile update cache directory is invalid')
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new MobileUpdateServiceError(502, 'UPSTREAM_UNREACHABLE', 'Mobile update cache directory has unexpected owner')
    }
    try {
      fs.chmodSync(this.cacheDir, 0o700)
    } catch {
      // Best-effort on Windows/non-POSIX filesystems.
    }
  }

  private pruneCache(keepSha256: string) {
    const keepName = `${keepSha256}.apk`
    const now = this.now()
    let entries: string[]
    try {
      entries = fs.readdirSync(this.cacheDir)
    } catch {
      return
    }
    for (const name of entries) {
      if (name === keepName) continue
      const fullPath = path.join(this.cacheDir, name)
      try {
        const stat = fs.lstatSync(fullPath)
        if (!stat.isFile()) continue
        if (name.endsWith('.apk')) {
          safeUnlink(fullPath)
        } else if (name.includes('.apk.tmp.') && now - stat.mtimeMs > STALE_TMP_TTL_MS) {
          safeUnlink(fullPath)
        }
      } catch {
        // Ignore concurrent removals.
      }
    }
  }
}

async function writeAll(handle: fs.promises.FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset)
    if (bytesWritten <= 0) throw new Error('Short write while saving APK')
    offset += bytesWritten
  }
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new MobileUpdateServiceError(502, 'UPSTREAM_INVALID_MANIFEST', 'GitHub manifest exceeds size limit')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks, total).toString('utf8')
}

async function hashFileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

function safeUnlink(filePath: string) {
  try {
    fs.unlinkSync(filePath)
  } catch {
    // Ignore missing files.
  }
}

let defaultService: MobileUpdateService | null = null

export function getMobileUpdateService(): MobileUpdateService {
  defaultService ??= new MobileUpdateService()
  return defaultService
}
