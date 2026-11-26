import { describe, expect, test } from 'bun:test'
import type {
  CCHahaUpdaterModule,
  CachedApkStatus,
  DownloadProgressEvent,
} from '../../modules/cchaha-updater'
import { buildAndroidUpdateViewModel, type AndroidReleaseManifest } from '../core/androidUpdateModel'
import type { Host } from '../core/types'
import {
  AndroidUpdateController,
  SILENT_CHECK_COOLDOWN_MS,
  SILENT_FAILURE_COOLDOWN_MS,
  type ActiveDesktopConnection,
  type DesktopLatestResponse,
  type NetworkProbeResult,
} from './androidUpdateController'
import { AndroidUpdateStore } from './androidUpdateStorage'
import type { Storage } from './storage'

const SHA_17 = 'a'.repeat(64)
const SHA_18 = 'b'.repeat(64)

function makeManifest(version: string, sha256: string, tag = 'v0.8.1'): AndroidReleaseManifest {
  return {
    schemaVersion: 1,
    platform: 'android',
    tag,
    commit: 'c'.repeat(40),
    fingerprint: 'd'.repeat(64),
    version,
    buildId: '12345678-1234-1234-1234-123456789abc',
    deliveredAt: '2026-11-25T10:00:00Z',
    destination: 'github-release',
    asset: `cc-haha-mobile-${version}-12345678-1234-1234-1234-123456789abc.apk`,
    sha256,
  }
}

function makeMemoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    getItem: async (k) => map.get(k) ?? null,
    setItem: async (k, v) => {
      map.set(k, v)
    },
    removeItem: async (k) => {
      map.delete(k)
    },
  }
}

function makeHost(): Host {
  return {
    id: 'host-1',
    name: 'MacBook Pro',
    url: 'http://192.168.1.20:3000',
    auth: 'lan',
  }
}

function createHarness(options: {
  installedVersion?: string
  canInstall?: boolean
  storage?: Storage
  network?: NetworkProbeResult
  connection?: ActiveDesktopConnection | null
  initialNow?: number
} = {}) {
  let installedVersion = options.installedVersion ?? '0.1.6'
  let canInstall = options.canInstall ?? true
  let currentNow = options.initialNow ?? 1_700_000_000_000
  let network: NetworkProbeResult = options.network ?? { online: true, cellular: false }
  let connection: ActiveDesktopConnection | null = options.connection ?? null
  let progressListener: ((event: DownloadProgressEvent) => void) | null = null

  const storage = options.storage ?? makeMemoryStorage()
  const store = new AndroidUpdateStore(storage)
  const calls = {
    fetchGitHubManifest: 0,
    downloadApk: [] as Record<string, unknown>[],
    installApk: [] as { sha256: string; version: string }[],
    cleanup: [] as (string | null)[],
    openSettings: 0,
    cancel: [] as { id: string | null; deletePartial: boolean }[],
  }

  let fetchManifestImpl: () => Promise<string> = async () => JSON.stringify(makeManifest('0.1.7', SHA_17))
  let getCachedApkImpl: (sha: string, version: string | null) => Promise<CachedApkStatus> = async () => ({
    ready: false,
    verified: false,
    partialBytes: 0,
    totalBytes: null,
    sizeBytes: null,
    versionName: null,
    versionCode: null,
  })
  let downloadApkImpl: (opts: Record<string, unknown>) => Promise<{
    sha256: string
    versionName: string
    versionCode: number
    sizeBytes: number
  }> = async (opts) => {
    const id = String(opts.downloadId)
    progressListener?.({
      downloadId: id,
      phase: 'downloading',
      bytesWritten: 30_000_000,
      totalBytes: 60_000_000,
      resumedFromBytes: 0,
    })
    progressListener?.({
      downloadId: id,
      phase: 'verifying',
      bytesWritten: 60_000_000,
      totalBytes: 60_000_000,
      resumedFromBytes: 0,
    })
    return {
      sha256: String(opts.expectedSha256),
      versionName: String(opts.expectedVersion),
      versionCode: 12,
      sizeBytes: 60_000_000,
    }
  }
  let installApkImpl: (sha: string, version: string) => Promise<{
    launched: boolean
    needsUnknownSourcesPermission: boolean
  }> = async () => ({ launched: true, needsUnknownSourcesPermission: false })

  const nativeUpdater: CCHahaUpdaterModule = {
    getInstalledAppInfo: () => ({
      packageName: 'app.cchaha.mobile',
      versionName: installedVersion,
      versionCode: 10,
      signingCertSha256s: ['1'.repeat(64)],
    }),
    canRequestPackageInstalls: () => canInstall,
    openUnknownSourcesSettings: () => {
      calls.openSettings++
      return true
    },
    cancelDownload: (id, deletePartial) => {
      calls.cancel.push({ id, deletePartial })
      return true
    },
    fetchGitHubManifest: async () => {
      calls.fetchGitHubManifest++
      return fetchManifestImpl()
    },
    getCachedApk: (sha, version) => getCachedApkImpl(sha, version),
    cleanupCachedApks: async (keep) => {
      calls.cleanup.push(keep)
      return 0
    },
    downloadApk: async (optionsJson) => {
      const parsed = JSON.parse(optionsJson) as Record<string, unknown>
      calls.downloadApk.push(parsed)
      return downloadApkImpl(parsed)
    },
    installApk: async (sha, version) => {
      calls.installApk.push({ sha256: sha, version })
      return installApkImpl(sha, version)
    },
    addListener: (_name, listener) => {
      progressListener = listener
      return {
        remove: () => {
          progressListener = null
        },
      }
    },
  }

  const controller = new AndroidUpdateController({
    nativeUpdater,
    store,
    getNetworkState: async () => network,
    getConnection: () => connection,
    now: () => currentNow,
    randomId: () => 'dl-fixed',
    preparePollIntervalMs: 5,
    installWatchdogMs: 30,
  })

  return {
    controller,
    store,
    storage,
    calls,
    setInstalledVersion: (v: string) => {
      installedVersion = v
    },
    setCanInstall: (v: boolean) => {
      canInstall = v
    },
    setNow: (ms: number) => {
      currentNow = ms
    },
    setNetwork: (next: NetworkProbeResult) => {
      network = next
    },
    setConnection: (next: ActiveDesktopConnection | null) => {
      connection = next
      controller.syncConnection()
    },
    setFetchManifest: (fn: typeof fetchManifestImpl) => {
      fetchManifestImpl = fn
    },
    setGetCachedApk: (fn: typeof getCachedApkImpl) => {
      getCachedApkImpl = fn
    },
    setDownloadApk: (fn: typeof downloadApkImpl) => {
      downloadApkImpl = fn
    },
    setInstallApk: (fn: typeof installApkImpl) => {
      installApkImpl = fn
    },
  }
}

describe('AndroidUpdateController', () => {
  test('transparently falls back to paired desktop relay when direct GitHub fails without VPN', async () => {
    let desktopHits = 0
    const manifest = makeManifest('0.1.7', SHA_17)
    const h = createHarness({
      connection: {
        host: makeHost(),
        credential: 'lan-token',
        fetchLatest: async (): Promise<DesktopLatestResponse> => {
          desktopHits++
          return { supported: true, available: true, manifest, cachedSizeBytes: 64_000_000 }
        },
      },
    })
    h.setFetchManifest(async () => {
      throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' })
    })

    await h.controller.initialize({ scheduleStartupCheck: false })
    await h.controller.checkForUpdates({ manual: true })

    expect(desktopHits).toBe(1)
    const snap = h.controller.getSnapshot()
    expect(snap.status).toBe('available')
    expect(snap.release?.version).toBe('0.1.7')
    expect(snap.release?.discoveredVia).toBe('desktop')
    expect(snap.totalBytes).toBe(64_000_000)

    await h.controller.download('desktop')
    expect(h.calls.downloadApk).toHaveLength(1)
    expect(h.calls.downloadApk[0]).toMatchObject({
      source: 'relay',
      relayOrigin: 'http://192.168.1.20:3000',
      url: `http://192.168.1.20:3000/api/mobile-update/android/apk?sha256=${SHA_17}`,
      headers: { Authorization: 'Bearer lan-token' },
    })
    expect(h.controller.getSnapshot().status).toBe('downloaded')
    h.controller.dispose()
  })

  test('degrades cleanly on older desktop (404) without losing direct GitHub error guidance', async () => {
    const h = createHarness({
      connection: {
        host: makeHost(),
        credential: 'lan-token',
        fetchLatest: async () => {
          throw Object.assign(new Error('Unknown API resource'), { status: 404 })
        },
      },
    })
    h.setFetchManifest(async () => {
      throw Object.assign(new Error('reset'), { code: 'NETWORK_ERROR' })
    })

    await h.controller.initialize({ scheduleStartupCheck: false })
    await h.controller.checkForUpdates({ manual: true })

    const snap = h.controller.getSnapshot()
    expect(snap.status).toBe('error')
    expect(snap.errorKind).toBe('github_unreachable')
    expect(snap.desktopRelaySupported).toBe(false)
    h.controller.dispose()
  })

  test('silent check respects 12h cooldown and swallows network failures silently', async () => {
    const h = createHarness()
    h.setFetchManifest(async () => {
      throw Object.assign(new Error('blocked'), { code: 'TIMEOUT' })
    })

    await h.controller.initialize({ scheduleStartupCheck: false })
    await h.controller.maybeSilentCheck()
    expect(h.controller.getSnapshot().status).toBe('idle')
    expect(h.calls.fetchGitHubManifest).toBe(1)

    // Within 15m failure backoff, repeated silent check is suppressed.
    h.setFetchManifest(async () => JSON.stringify(makeManifest('0.1.6', SHA_17)))
    await h.controller.maybeSilentCheck()
    expect(h.calls.fetchGitHubManifest).toBe(1)

    // After 15m failure backoff, succeeding check records lastCheckedAt; within 12h cooldown, maybeSilentCheck is a no-op.
    const tAfterFailureBackoff = 1_700_000_000_000 + SILENT_FAILURE_COOLDOWN_MS + 1
    h.setNow(tAfterFailureBackoff)
    await h.controller.maybeSilentCheck()
    expect(h.calls.fetchGitHubManifest).toBe(2)
    expect(h.controller.getSnapshot().status).toBe('idle')

    await h.controller.maybeSilentCheck()
    expect(h.calls.fetchGitHubManifest).toBe(2)

    // After 12h cooldown, silent check runs again.
    h.setNow(tAfterFailureBackoff + SILENT_CHECK_COOLDOWN_MS + 1)
    await h.controller.maybeSilentCheck()
    expect(h.calls.fetchGitHubManifest).toBe(3)
    h.controller.dispose()
  })

  test('restores an undownloaded desktop release without fetching during the cooldown', async () => {
    const manifest = makeManifest('0.1.7', SHA_17)
    const first = createHarness({ connection: {
      host: makeHost(), credential: 'lan-token',
      fetchLatest: async () => ({ supported: true, available: true, manifest, cachedSizeBytes: 65_000_000 }),
    } })
    await first.controller.initialize({ scheduleStartupCheck: false })
    await first.controller.checkForUpdates({ manual: true, preferDesktop: true })
    const release = first.controller.getSnapshot().release
    first.controller.dispose()

    const next = createHarness({ storage: first.storage })
    await next.controller.initialize({ scheduleStartupCheck: false })
    await next.controller.maybeSilentCheck()
    expect(next.controller.getSnapshot()).toMatchObject({ status: 'available', release, totalBytes: 65_000_000 })
    expect(buildAndroidUpdateViewModel(next.controller.getSnapshot()).homeDot).not.toBeNull()
    expect(next.calls.fetchGitHubManifest).toBe(0)
    await next.controller.dismissAvailableVersion()
    next.controller.dispose()

    const dismissed = createHarness({ storage: first.storage })
    await dismissed.controller.initialize({ scheduleStartupCheck: false })
    expect(dismissed.controller.getSnapshot().release).toEqual(release)
    expect(buildAndroidUpdateViewModel(dismissed.controller.getSnapshot()).homeDot).toBeNull()
    dismissed.setNow(1_700_000_000_000 + SILENT_CHECK_COOLDOWN_MS)
    dismissed.setFetchManifest(async () => JSON.stringify(makeManifest('0.1.8', SHA_18)))
    await dismissed.controller.maybeSilentCheck()
    expect(dismissed.calls.fetchGitHubManifest).toBe(1)
    expect(buildAndroidUpdateViewModel(dismissed.controller.getSnapshot()).homeDot).not.toBeNull()
    dismissed.controller.dispose()

    const updated = createHarness({ storage: first.storage, installedVersion: '0.1.8' })
    await updated.controller.initialize({ scheduleStartupCheck: false })
    expect(updated.controller.getSnapshot()).toMatchObject({ status: 'idle', release: null })
    expect((await updated.store.load()).available).toBeNull()
    updated.controller.dispose()
  })

  test('never restores a downloaded APK superseded by a later successful check', async () => {
    const first = createHarness()
    await first.controller.initialize({ scheduleStartupCheck: false })
    await first.controller.checkForUpdates({ manual: true })
    await first.controller.download('github')
    first.setFetchManifest(async () => JSON.stringify(makeManifest('0.1.8', SHA_18)))
    await first.controller.checkForUpdates({ manual: true })
    first.controller.dispose()

    const next = createHarness({ storage: first.storage })
    next.setGetCachedApk(async (sha) => ({
      ready: sha === SHA_17, verified: sha === SHA_17, partialBytes: 0,
      totalBytes: null, sizeBytes: null, versionName: null, versionCode: null,
    }))
    await next.controller.initialize({ scheduleStartupCheck: false })
    expect(next.controller.getSnapshot()).toMatchObject({ status: 'available', release: { sha256: SHA_18 } })
    expect((await next.store.load()).downloaded).toBeNull()
    next.controller.dispose()
  })

  test('a download requested while refreshing cannot replace a newly discovered release', async () => {
    const h = createHarness()
    await h.controller.start({ scheduleStartupCheck: false })
    await h.controller.checkForUpdates({ manual: true })
    h.setNow(1_700_000_000_000 + SILENT_CHECK_COOLDOWN_MS)
    const started = Promise.withResolvers<void>()
    const manifest = Promise.withResolvers<string>()
    h.setFetchManifest(() => { started.resolve(); return manifest.promise })
    const finished = Promise.withResolvers<{ sha256: string; versionName: string; versionCode: number; sizeBytes: number }>()
    h.setDownloadApk(() => finished.promise)
    const refresh = h.controller.maybeSilentCheck()
    await started.promise
    const download = h.controller.download('github')
    manifest.resolve(JSON.stringify(makeManifest('0.1.8', SHA_18)))
    await refresh
    finished.resolve({ sha256: SHA_17, versionName: '0.1.7', versionCode: 12, sizeBytes: 100 })
    await download
    expect(h.controller.getSnapshot()).toMatchObject({ status: 'available', release: { sha256: SHA_18 } })
    expect(h.calls.downloadApk).toHaveLength(0)
    h.controller.dispose()
  })

  test('a foreground refresh waits for startup restoration and preserves a known update on failure', async () => {
    const first = createHarness()
    await first.controller.start({ scheduleStartupCheck: false })
    await first.controller.checkForUpdates({ manual: true })
    first.controller.dispose()
    const read = Promise.withResolvers<void>()
    const next = createHarness({
      storage: {
        ...first.storage,
        getItem: async (key) => { await read.promise; return first.storage.getItem(key) },
      },
    })
    const fetch = Promise.withResolvers<string>()
    next.setFetchManifest(() => fetch.promise)
    const start = next.controller.start({ scheduleStartupCheck: false })
    const foreground = next.controller.handleAppForeground()
    await Promise.resolve()
    await Promise.resolve()
    try {
      expect(next.calls.fetchGitHubManifest).toBe(0)
      read.resolve()
      await Promise.all([start, foreground])
      expect(next.controller.getSnapshot()).toMatchObject({ status: 'available', release: { sha256: SHA_17 } })
      expect(next.calls.fetchGitHubManifest).toBe(0)
      next.setNow(1_700_000_000_000 + SILENT_CHECK_COOLDOWN_MS)
      const refresh = next.controller.maybeSilentCheck()
      fetch.reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' }))
      await refresh
      expect(next.controller.getSnapshot()).toMatchObject({ status: 'available', release: { sha256: SHA_17 } })
    } finally {
      read.resolve()
      fetch.resolve(JSON.stringify(makeManifest('0.1.7', SHA_17)))
      await Promise.all([start, foreground])
      next.controller.dispose()
    }
  })

  test('rediscovers v1 check-only state once and keeps the dismissed version hidden', async () => {
    const h = createHarness()
    await h.storage.setItem('cc-haha.android-update', JSON.stringify({
      version: 1, lastCheckedAt: 1_700_000_000_000, dismissedVersion: '0.1.7',
      downloaded: null, partial: null, pendingInstall: null,
    }))
    await h.controller.start({ scheduleStartupCheck: false })
    await h.controller.maybeSilentCheck()
    expect(h.calls.fetchGitHubManifest).toBe(1)
    expect(h.controller.getSnapshot()).toMatchObject({ status: 'available', release: { sha256: SHA_17 } })
    expect(buildAndroidUpdateViewModel(h.controller.getSnapshot()).homeDot).toBeNull()
    h.controller.dispose()
    const next = createHarness({ storage: h.storage })
    await next.controller.start({ scheduleStartupCheck: false })
    await next.controller.maybeSilentCheck()
    expect(next.calls.fetchGitHubManifest).toBe(0)
    next.controller.dispose()
  })

  test('rechecks after an evicted legacy APK leaves no release to restore', async () => {
    const first = createHarness()
    await first.controller.start({ scheduleStartupCheck: false })
    await first.controller.checkForUpdates({ manual: true })
    await first.controller.download('github')
    const saved = await first.store.load()
    await first.storage.setItem('cc-haha.android-update', JSON.stringify({
      version: 1, downloaded: saved.downloaded, lastCheckedAt: saved.lastCheckedAt,
      partial: null, pendingInstall: null, dismissedVersion: null,
    }))
    first.controller.dispose()
    const next = createHarness({ storage: first.storage })
    await next.controller.start({ scheduleStartupCheck: false })
    await next.controller.maybeSilentCheck()
    expect(next.calls.fetchGitHubManifest).toBe(1)
    expect(next.controller.getSnapshot()).toMatchObject({ status: 'available', release: { sha256: SHA_17 } })
    next.controller.dispose()
  })

  test('a temporarily unavailable installed version cannot erase an already discovered update', async () => {
    const first = createHarness()
    await first.controller.start({ scheduleStartupCheck: false })
    await first.controller.checkForUpdates({ manual: true })
    first.controller.dispose()
    const next = createHarness({ storage: first.storage, installedVersion: '' })
    await next.controller.start({ scheduleStartupCheck: false })
    await next.controller.handleAppForeground()
    await next.controller.checkForUpdates({ manual: true })
    expect((await next.store.load()).available?.manifest.sha256).toBe(SHA_17)
    expect(next.controller.getSnapshot().status).not.toBe('up-to-date')
    next.setInstalledVersion('0.1.7')
    await next.controller.handleAppForeground()
    expect((await next.store.load()).available).toBeNull()
    expect(next.controller.getSnapshot()).toMatchObject({ status: 'idle', release: null })
    next.controller.dispose()
  })

  test('a late silent failure cannot restore the release that was installed during the check', async () => {
    const h = createHarness()
    await h.controller.start({ scheduleStartupCheck: false })
    await h.controller.checkForUpdates({ manual: true })
    h.setNow(1_700_000_000_000 + SILENT_CHECK_COOLDOWN_MS)
    const started = Promise.withResolvers<void>()
    const result = Promise.withResolvers<string>()
    h.setFetchManifest(() => { started.resolve(); return result.promise })
    const refresh = h.controller.maybeSilentCheck()
    await started.promise
    h.setInstalledVersion('0.1.7')
    await h.controller.handleAppForeground()
    result.reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' }))
    await refresh
    expect(h.controller.getSnapshot()).toMatchObject({ status: 'idle', release: null })
    expect((await h.store.load()).available).toBeNull()
    h.controller.dispose()
  })

  test('a temporarily missing relay manifest preserves the known update and retries after failure backoff', async () => {
    const h = createHarness({ connection: {
      host: makeHost(), credential: 'lan-token',
      fetchLatest: async () => ({ supported: true, available: false }),
    } })
    await h.controller.start({ scheduleStartupCheck: false })
    await h.controller.checkForUpdates({ manual: true })
    const expiresAt = 1_700_000_000_000 + SILENT_CHECK_COOLDOWN_MS
    h.setNow(expiresAt)
    h.setFetchManifest(async () => { throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' }) })
    await h.controller.maybeSilentCheck()
    expect(h.controller.getSnapshot()).toMatchObject({ status: 'available', release: { sha256: SHA_17 } })
    await h.controller.maybeSilentCheck()
    expect(h.calls.fetchGitHubManifest).toBe(2)
    h.setNow(expiresAt + SILENT_FAILURE_COOLDOWN_MS)
    h.setFetchManifest(async () => JSON.stringify(makeManifest('0.1.8', SHA_18)))
    await h.controller.maybeSilentCheck()
    expect(h.controller.getSnapshot().release?.sha256).toBe(SHA_18)
    h.controller.dispose()
  })

  test('recovers pendingInstall after Android kills and recreates process on unknown-sources grant', async () => {
    const sharedStorage = makeMemoryStorage()

    // Session 1: download succeeds, install hits permission-needed, user opens system settings.
    const s1 = createHarness({ storage: sharedStorage, canInstall: false })
    await s1.controller.initialize({ scheduleStartupCheck: false })
    await s1.controller.checkForUpdates({ manual: true })
    await s1.controller.download('github')
    await s1.controller.install()
    expect(s1.controller.getSnapshot().status).toBe('permission-needed')

    await s1.controller.openUnknownSourcesSettings()
    expect(s1.calls.openSettings).toBe(1)
    s1.controller.dispose()

    // Session 2: process recreated 10 seconds later with permission granted and cached APK intact.
    const s2 = createHarness({
      storage: sharedStorage,
      canInstall: true,
      initialNow: 1_700_000_010_000,
    })
    s2.setGetCachedApk(async () => ({
      ready: true,
      verified: true,
      partialBytes: 60_000_000,
      totalBytes: 60_000_000,
      sizeBytes: 60_000_000,
      versionName: '0.1.7',
      versionCode: 12,
    }))
    await s2.controller.initialize({ scheduleStartupCheck: false })

    // One-shot auto-launch triggered, and pendingInstall cleared so cancelling never loops.
    expect(s2.calls.installApk).toEqual([{ sha256: SHA_17, version: '0.1.7' }])
    expect((await s2.store.load()).pendingInstall).toBeNull()

    // User cancels system installer and returns to app immediately (<500ms) -> safely back to downloaded.
    s2.controller.handleAppBackground()
    s2.setNow(1_700_000_010_100)
    await s2.controller.handleAppForeground()
    expect(s2.controller.getSnapshot().status).toBe('downloaded')
    expect(s2.controller.getSnapshot().installCancelledHint).toBe(true)
    s2.controller.dispose()

    // Session 3: upgrade completed! App restarts as 0.1.7 -> cached APK cleaned up automatically.
    const s3 = createHarness({
      storage: sharedStorage,
      installedVersion: '0.1.7',
      initialNow: 1_700_000_050_000,
    })
    await s3.controller.initialize({ scheduleStartupCheck: false })
    expect(s3.controller.getSnapshot().status).toBe('idle')
    expect(s3.calls.cleanup).toEqual([null])
    expect((await s3.store.load()).downloaded).toBeNull()
    s3.controller.dispose()
  })

  test('refreshes manifest automatically when desktop relay responds with RELEASE_CHANGED', async () => {
    const manifest18 = makeManifest('0.1.8', SHA_18, 'v0.8.2')
    const h = createHarness({
      connection: {
        host: makeHost(),
        credential: 'lan-token',
        fetchLatest: async () => ({ supported: true, available: true, manifest: manifest18, cachedSizeBytes: 65_000_000 }),
      },
    })
    await h.controller.initialize({ scheduleStartupCheck: false })
    await h.controller.checkForUpdates({ manual: true })
    expect(h.controller.getSnapshot().release?.version).toBe('0.1.7')

    h.setDownloadApk(async () => {
      throw Object.assign(new Error('changed'), { code: 'RELEASE_CHANGED' })
    })
    await h.controller.download('desktop')

    expect(h.controller.getSnapshot().status).toBe('available')
    expect(h.controller.getSnapshot().release?.version).toBe('0.1.8')
    h.controller.dispose()
  })

  test('recovers the first in-progress download after Android kills the process', async () => {
    const storage = makeMemoryStorage()
    const first = createHarness({ storage })
    const started = Promise.withResolvers<void>()
    const interrupted = Promise.withResolvers<never>()
    first.setDownloadApk(() => {
      started.resolve()
      return interrupted.promise
    })
    await first.controller.initialize({ scheduleStartupCheck: false })
    await first.controller.checkForUpdates({ manual: true })
    const download = first.controller.download('github')
    await started.promise

    // Recreate the controller using only the persisted state, before native completion.
    first.controller.dispose()
    const next = createHarness({ storage })
    next.setGetCachedApk(async () => ({
      ready: false, verified: false, partialBytes: 4096, totalBytes: 8192,
      sizeBytes: null, versionName: null, versionCode: null,
    }))
    await next.controller.initialize({ scheduleStartupCheck: false })
    expect(next.calls.cleanup).toEqual([SHA_17])
    expect(next.controller.getSnapshot()).toMatchObject({
      status: 'available', partialBytes: 4096, totalBytes: 8192,
      release: { version: '0.1.7', sha256: SHA_17 },
    })
    await next.controller.download('github')
    expect(next.calls.downloadApk[0]?.expectedSha256).toBe(SHA_17)
    expect((await next.store.load()).partial).toBeNull()
    next.controller.dispose()
    interrupted.reject(Object.assign(new Error('process ended'), { code: 'CANCELLED' }))
    await download
  })

  test('does not block download or strand downloading state when persisting partial metadata fails', async () => {
    const inner = makeMemoryStorage()
    let failWrites = false
    const storage = {
      getItem: (key: string) => inner.getItem(key),
      setItem: async (key: string, value: string) => {
        if (failWrites) throw new Error('ENOSPC: storage full')
        await inner.setItem(key, value)
      },
      removeItem: (key: string) => inner.removeItem(key),
    }
    const h = createHarness({ storage })
    await h.controller.initialize({ scheduleStartupCheck: false })
    await h.controller.checkForUpdates({ manual: true })

    failWrites = true
    h.setDownloadApk(async () => {
      throw Object.assign(new Error('network dropped'), { code: 'NETWORK_ERROR' })
    })
    await h.controller.download('github')

    expect(h.calls.downloadApk).toHaveLength(1)
    expect(h.controller.getSnapshot().status).toBe('error')
    expect(h.controller.getSnapshot().errorKind).toBe('github_unreachable')
    h.controller.dispose()
  })

  test('preserves partial bytes on download interruption and deletes partial on explicit cancel', async () => {
    const h = createHarness()
    await h.controller.initialize({ scheduleStartupCheck: false })
    await h.controller.checkForUpdates({ manual: true })

    h.setDownloadApk(async () => {
      throw Object.assign(new Error('dropped'), { code: 'NETWORK_ERROR' })
    })
    h.setGetCachedApk(async () => ({
      ready: false,
      verified: false,
      partialBytes: 12_500_000,
      totalBytes: 60_000_000,
      sizeBytes: null,
      versionName: null,
      versionCode: null,
    }))

    await h.controller.download('github')
    expect(h.controller.getSnapshot().status).toBe('error')
    expect(h.controller.getSnapshot().errorKind).toBe('download_interrupted')
    expect(h.controller.getSnapshot().partialBytes).toBe(12_500_000)

    await h.controller.cancelDownload()
    expect(h.calls.cancel[0]?.deletePartial).toBe(true)
    expect(h.controller.getSnapshot().status).toBe('available')
    expect(h.controller.getSnapshot().partialBytes).toBe(0)
    h.controller.dispose()
  })

  test('polls desktop /prepare until ready before native /apk stream and supports cancel during prepare', async () => {
    const manifest = makeManifest('0.1.7', SHA_17)
    let prepCalls = 0
    const h = createHarness({
      connection: {
        host: makeHost(),
        credential: 'lan-token',
        fetchLatest: async () => ({ supported: true, available: true, manifest, cachedSizeBytes: null }),
        prepareApk: async (sha, start) => {
          prepCalls++
          if (prepCalls === 1) {
            expect(start).toBe(true)
            return { supported: true, status: 'preparing', sha256: sha, downloadedBytes: 10_000_000, totalBytes: 60_000_000, manifest }
          }
          expect(start).toBe(false)
          return { supported: true, status: 'ready', sha256: sha, sizeBytes: 60_000_000, manifest }
        },
      },
    })
    h.setFetchManifest(async () => {
      throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' })
    })

    await h.controller.initialize({ scheduleStartupCheck: false })
    await h.controller.checkForUpdates({ manual: true })

    const stages: (string | null)[] = []
    h.controller.subscribe((snap) => stages.push(snap.downloadingStage))
    await h.controller.download('desktop')

    expect(prepCalls).toBe(2)
    expect(stages).toContain('desktop_preparing')
    expect(stages).toContain('downloading')
    expect(h.calls.downloadApk).toHaveLength(1)
    expect(h.controller.getSnapshot().status).toBe('downloaded')
    h.controller.dispose()
  })

  test('guards against double-tap download re-entrancy, recovers installing via watchdog, and survives stop/start', async () => {
    let releaseNet!: () => void
    const netGate = new Promise<void>((resolve) => {
      releaseNet = resolve
    })
    const h = createHarness()
    await h.controller.start({ scheduleStartupCheck: false })
    // Simulate React StrictMode unmount + remount on the same controller instance.
    h.controller.stop()
    await h.controller.start({ scheduleStartupCheck: false })

    await h.controller.checkForUpdates({ manual: true })

    // Double-tap download concurrently before first native download completes.
    h.setDownloadApk(async (opts) => {
      await netGate
      return {
        sha256: String(opts.expectedSha256),
        versionName: String(opts.expectedVersion),
        versionCode: 12,
        sizeBytes: 60_000_000,
      }
    })
    const p1 = h.controller.download('github')
    const p2 = h.controller.download('github')
    releaseNet()
    await Promise.all([p1, p2])
    expect(h.calls.downloadApk).toHaveLength(1)
    expect(h.controller.getSnapshot().status).toBe('downloaded')

    // Installing watchdog relaxes back to downloaded even without AppState background cycle.
    await h.controller.install()
    expect(h.controller.getSnapshot().status).toBe('installing')
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(h.controller.getSnapshot().status).toBe('downloaded')

    // Cache eviction (APK_NOT_FOUND) clears persisted downloaded record and enters apk_missing.
    h.setInstallApk(async () => {
      throw Object.assign(new Error('missing'), { code: 'APK_NOT_FOUND' })
    })
    await h.controller.install()
    expect(h.controller.getSnapshot().status).toBe('error')
    expect(h.controller.getSnapshot().errorKind).toBe('apk_missing')
    expect((await h.store.load()).downloaded).toBeNull()
    h.controller.dispose()
  })

  test('preserves GitHub error when paired desktop is offline, respects directOnly, and applies silent failure backoff', async () => {
    let desktopCalls = 0
    const h = createHarness({
      connection: {
        host: makeHost(),
        credential: 'lan-token',
        fetchLatest: async () => {
          desktopCalls++
          throw Object.assign(new Error('connect failed'), { code: 'TIMEOUT' })
        },
      },
    })
    h.setFetchManifest(async () => {
      throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' })
    })

    await h.controller.initialize({ scheduleStartupCheck: false })

    // Silent check fails -> enters 15-minute failure backoff so repeated foregrounding doesn't spam.
    await h.controller.maybeSilentCheck()
    expect(h.calls.fetchGitHubManifest).toBe(1)
    await h.controller.maybeSilentCheck()
    expect(h.calls.fetchGitHubManifest).toBe(1)

    // Manual check: direct fails + offline desktop fails -> keeps github_unreachable (not desktop_relay_disconnected).
    await h.controller.checkForUpdates({ manual: true })
    expect(h.controller.getSnapshot().status).toBe('error')
    expect(h.controller.getSnapshot().errorKind).toBe('github_unreachable')
    expect(h.controller.getSnapshot().desktopOnline).toBe(false)

    // directOnly skips desktop completely.
    const beforeDesktop = desktopCalls
    await h.controller.checkForUpdates({ manual: true, directOnly: true })
    expect(desktopCalls).toBe(beforeDesktop)
    expect(h.controller.getSnapshot().errorKind).toBe('github_unreachable')
    h.controller.dispose()
  })
})
