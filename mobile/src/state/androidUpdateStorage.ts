import type { Storage } from './storage'
import type { UpdateSource } from '../core/androidUpdateModel'

const STORAGE_KEY = 'cc-haha.android-update'
const SHA256_RE = /^[a-f0-9]{64}$/
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const TAG_RE = /^v\d+\.\d+\.\d+$/
const ASSET_RE = /^cc-haha-mobile-[\w.-]+\.apk$/

export type PersistedDownloadedApk = {
  version: string
  tag: string
  asset: string
  sha256: string
  sizeBytes: number | null
  releaseUrl: string
  downloadUrl: string
  verifiedAt: number
  via?: UpdateSource
}

export type PersistedPartialDownload = {
  version: string
  tag: string
  asset: string
  sha256: string
  downloadedBytes: number
  totalBytes: number | null
  downloadUrl: string
  releaseUrl: string
  via: UpdateSource
}

export type PersistedPendingInstall = {
  version: string
  sha256: string
  requestedAt: number
}

export type AndroidUpdateRecord = {
  version: 1
  lastCheckedAt: number | null
  dismissedVersion: string | null
  downloaded: PersistedDownloadedApk | null
  partial: PersistedPartialDownload | null
  pendingInstall: PersistedPendingInstall | null
}

export const EMPTY_ANDROID_UPDATE_RECORD: AndroidUpdateRecord = {
  version: 1,
  lastCheckedAt: null,
  dismissedVersion: null,
  downloaded: null,
  partial: null,
  pendingInstall: null,
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isHttpsUrl(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('https://') && value.length <= 512
}

function parseDownloaded(value: unknown): PersistedDownloadedApk | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  if (
    typeof item.version !== 'string' || !SEMVER_RE.test(item.version) ||
    typeof item.tag !== 'string' || !TAG_RE.test(item.tag) ||
    typeof item.asset !== 'string' || !ASSET_RE.test(item.asset) ||
    typeof item.sha256 !== 'string' || !SHA256_RE.test(item.sha256) ||
    !isHttpsUrl(item.releaseUrl) ||
    !isHttpsUrl(item.downloadUrl) ||
    !isFiniteNonNegative(item.verifiedAt)
  ) {
    return null
  }
  const sizeBytes = isFiniteNonNegative(item.sizeBytes) && item.sizeBytes > 0 ? item.sizeBytes : null
  const via = item.via === 'desktop' || item.via === 'github' ? item.via : undefined
  return {
    version: item.version,
    tag: item.tag,
    asset: item.asset,
    sha256: item.sha256,
    sizeBytes,
    releaseUrl: item.releaseUrl,
    downloadUrl: item.downloadUrl,
    verifiedAt: item.verifiedAt,
    ...(via ? { via } : {}),
  }
}

function parsePartial(value: unknown): PersistedPartialDownload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  if (
    typeof item.version !== 'string' || !SEMVER_RE.test(item.version) ||
    typeof item.tag !== 'string' || !TAG_RE.test(item.tag) ||
    typeof item.asset !== 'string' || !ASSET_RE.test(item.asset) ||
    typeof item.sha256 !== 'string' || !SHA256_RE.test(item.sha256) ||
    !isFiniteNonNegative(item.downloadedBytes) ||
    !isHttpsUrl(item.downloadUrl) ||
    !isHttpsUrl(item.releaseUrl) ||
    (item.via !== 'github' && item.via !== 'desktop')
  ) {
    return null
  }
  const totalBytes = isFiniteNonNegative(item.totalBytes) && item.totalBytes > 0 ? item.totalBytes : null
  return {
    version: item.version,
    tag: item.tag,
    asset: item.asset,
    sha256: item.sha256,
    downloadedBytes: item.downloadedBytes,
    totalBytes,
    downloadUrl: item.downloadUrl,
    releaseUrl: item.releaseUrl,
    via: item.via,
  }
}

function parsePendingInstall(value: unknown): PersistedPendingInstall | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  if (
    typeof item.version !== 'string' || !SEMVER_RE.test(item.version) ||
    typeof item.sha256 !== 'string' || !SHA256_RE.test(item.sha256) ||
    !isFiniteNonNegative(item.requestedAt)
  ) {
    return null
  }
  return {
    version: item.version,
    sha256: item.sha256,
    requestedAt: item.requestedAt,
  }
}

/**
 * 读取版本化的 Android 更新状态。缺失、损坏或来自更新 schema 版本时安全回退为空，不阻塞 App 启动。
 */
export function parseAndroidUpdateRecord(raw: string | null): AndroidUpdateRecord {
  if (!raw) return { ...EMPTY_ANDROID_UPDATE_RECORD }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ...EMPTY_ANDROID_UPDATE_RECORD }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...EMPTY_ANDROID_UPDATE_RECORD }
  }
  const value = parsed as Record<string, unknown>
  if (value.version !== 1) return { ...EMPTY_ANDROID_UPDATE_RECORD }

  return {
    version: 1,
    lastCheckedAt: isFiniteNonNegative(value.lastCheckedAt) ? value.lastCheckedAt : null,
    dismissedVersion:
      typeof value.dismissedVersion === 'string' && SEMVER_RE.test(value.dismissedVersion)
        ? value.dismissedVersion
        : null,
    downloaded: parseDownloaded(value.downloaded),
    partial: parsePartial(value.partial),
    pendingInstall: parsePendingInstall(value.pendingInstall),
  }
}

export class AndroidUpdateStore {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly storage: Storage) {}

  private transaction<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task)
    this.queue = result.catch(() => {})
    return result
  }

  load(): Promise<AndroidUpdateRecord> {
    return this.transaction(async () => {
      try {
        return parseAndroidUpdateRecord(await this.storage.getItem(STORAGE_KEY))
      } catch {
        return { ...EMPTY_ANDROID_UPDATE_RECORD }
      }
    })
  }

  update(mutate: (current: AndroidUpdateRecord) => AndroidUpdateRecord): Promise<AndroidUpdateRecord> {
    return this.transaction(async () => {
      let current: AndroidUpdateRecord
      try {
        current = parseAndroidUpdateRecord(await this.storage.getItem(STORAGE_KEY))
      } catch {
        current = { ...EMPTY_ANDROID_UPDATE_RECORD }
      }
      const next = mutate(current)
      await this.storage.setItem(STORAGE_KEY, JSON.stringify(next))
      return next
    })
  }
}
