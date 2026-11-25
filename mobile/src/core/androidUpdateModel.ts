import { formatBytes } from './changesView'

export const GITHUB_RELEASES_BASE_URL = 'https://github.com/NanmiCoder/cc-haha/releases'
export const GITHUB_RELEASES_LATEST_URL = `${GITHUB_RELEASES_BASE_URL}/latest`
export const GITHUB_ANDROID_MANIFEST_URL = `${GITHUB_RELEASES_BASE_URL}/latest/download/mobile-release-android.json`

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const TAG_RE = /^v\d+\.\d+\.\d+$/
const COMMIT_RE = /^[a-f0-9]{40}$/
const SHA256_RE = /^[a-f0-9]{64}$/
const UUID_RE = /^[a-f0-9-]{36}$/
const ASSET_RE = /^cc-haha-mobile-[\w.-]+\.apk$/

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

export type UpdateSource = 'github' | 'desktop'

export type AndroidUpdateRelease = {
  version: string
  tag: string
  asset: string
  sha256: string
  buildId: string
  deliveredAt: string
  downloadUrl: string
  releaseUrl: string
  sizeBytes: number | null
  discoveredVia: UpdateSource
}

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'verifying'
  | 'downloaded'
  | 'permission-needed'
  | 'installing'
  | 'error'

export type UpdateErrorKind =
  | 'offline'
  | 'github_unreachable'
  | 'desktop_relay_failed'
  | 'desktop_relay_disconnected'
  | 'desktop_relay_unsupported'
  | 'download_interrupted'
  | 'rate_limited'
  | 'checksum_mismatch'
  | 'insufficient_storage'
  | 'apk_missing'
  | 'signature_or_install_failed'
  | 'manifest_unavailable'
  | 'unknown'

export type UpdateActionKind =
  | 'check'
  | 'checkDirectOnly'
  | 'checkDesktop'
  | 'downloadDirect'
  | 'downloadDesktop'
  | 'cancelDownload'
  | 'install'
  | 'deleteApk'
  | 'openUnknownSources'
  | 'retryInstallAfterPermission'
  | 'dismiss'
  | 'openBrowser'
  | 'copyLink'

export type UpdateAction = {
  kind: UpdateActionKind
  label: string
  look: 'primary' | 'secondary' | 'plain'
}

export type DownloadingStage = 'desktop_preparing' | 'downloading'

export type AndroidUpdateSnapshot = {
  status: UpdateStatus
  checkingVia: UpdateSource
  currentVersion: string
  release: AndroidUpdateRelease | null
  downloadingVia: UpdateSource | null
  downloadingStage: DownloadingStage | null
  downloadedBytes: number
  totalBytes: number | null
  partialBytes: number
  dismissedVersion: string | null
  permissionStillDenied: boolean
  installCancelledHint: boolean
  errorKind: UpdateErrorKind | null
  errorSource: UpdateSource | null
  errorPhase: 'check' | 'download' | 'install' | null
  errorCanRetryInstall: boolean
  desktopOnline: boolean
  desktopRelaySupported: boolean
  hostName: string | undefined
}

export type AndroidUpdateHomeDot = {
  tone: 'run' | 'ok'
  accessibilitySuffix: string
}

export type AndroidUpdateTopNotice = {
  tone: 'run' | 'ok' | 'attn'
  icon: 'arrow-down' | 'circle-check' | 'circle-alert'
  spinning?: boolean
  title: string
  subtitle: string
  monoSubtitle?: boolean
}

export type AndroidUpdateViewModel = {
  rowValue: string
  rowTone: 'muted' | 'run' | 'ok' | 'attn' | 'err'
  rowChecking: boolean
  rowPressable: boolean
  expanded: boolean
  homeDot: AndroidUpdateHomeDot | null
  topNotice: AndroidUpdateTopNotice | null
  headline: string
  sizeBadge: string | null
  progressPercent: number | null
  progressMeta: string | null
  calloutTone: 'attention' | 'error' | null
  calloutText: string | null
  description: string | null
  note: string | null
  actions: UpdateAction[]
  showExternalLinks: boolean
  browserUrl: string
  copyUrl: string
}

export function parseAndroidReleaseManifest(value: unknown): AndroidReleaseManifest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
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
    return null
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

export function releaseFromManifest(
  manifest: AndroidReleaseManifest,
  options: { discoveredVia: UpdateSource; sizeBytes?: number | null }
): AndroidUpdateRelease {
  return {
    version: manifest.version,
    tag: manifest.tag,
    asset: manifest.asset,
    sha256: manifest.sha256,
    buildId: manifest.buildId,
    deliveredAt: manifest.deliveredAt,
    downloadUrl: `${GITHUB_RELEASES_BASE_URL}/download/${manifest.tag}/${manifest.asset}`,
    releaseUrl: `${GITHUB_RELEASES_BASE_URL}/tag/${manifest.tag}`,
    sizeBytes:
      typeof options.sizeBytes === 'number' && Number.isFinite(options.sizeBytes) && options.sizeBytes > 0
        ? options.sizeBytes
        : null,
    discoveredVia: options.discoveredVia,
  }
}

export function compareSemver(left: string | null | undefined, right: string | null | undefined): number | null {
  if (!left || !right) return null
  const l = SEMVER_RE.exec(left.trim().replace(/^v/i, ''))
  const r = SEMVER_RE.exec(right.trim().replace(/^v/i, ''))
  if (!l || !r) return null
  for (let i = 1; i <= 3; i++) {
    const diff = Number(l[i]) - Number(r[i])
    if (diff !== 0) return diff
  }
  return 0
}

export function isNewerVersion(candidate: string | null | undefined, current: string | null | undefined): boolean {
  const cmp = compareSemver(candidate, current)
  return cmp !== null && cmp > 0
}

export function extractErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return ''
  const record = error as { code?: unknown; cause?: unknown }
  if (typeof record.code === 'string' && record.code) return record.code
  if (record.cause && typeof record.cause === 'object') {
    const nested = (record.cause as { code?: unknown }).code
    if (typeof nested === 'string' && nested) return nested
  }
  return ''
}

export function extractErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null
  const status = (error as { status?: unknown }).status
  return typeof status === 'number' && Number.isFinite(status) ? status : null
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message
  }
  return ''
}

/** 电脑版本过旧、还没有 /api/mobile-update 接口时的 HTTP 状态码（见 deliveryModel.ts）。 */
const OLD_DESKTOP_STATUSES = new Set([403, 404, 405])

export function isOlderDesktopRelayError(error: unknown): boolean {
  const code = extractErrorCode(error)
  if (code === 'RELAY_UNSUPPORTED') return true
  if (
    code === 'MANIFEST_NOT_PUBLISHED' ||
    code === 'MANIFEST_NOT_FOUND' ||
    code === 'RELEASE_CHANGED' ||
    code === 'RATE_LIMITED' ||
    code === 'PROXY_UNAVAILABLE' ||
    code.startsWith('UPSTREAM_')
  ) {
    return false
  }
  // A modern desktop with LAN H5 disabled replies 403 "H5 access is disabled..." —
  // never misclassify that as an older desktop lacking mobile-update routes.
  if (/H5 access is disabled/i.test(extractErrorMessage(error))) {
    return false
  }
  const status = extractErrorStatus(error)
  return status !== null && OLD_DESKTOP_STATUSES.has(status)
}

export function classifyUpdateError(
  error: unknown,
  context: {
    source: UpdateSource
    phase: 'check' | 'download' | 'install'
    online: boolean
    partialBytes?: number
  }
): UpdateErrorKind {
  if (!context.online) return 'offline'

  const code = extractErrorCode(error)
  const status = extractErrorStatus(error)
  const hasPartial = (context.partialBytes ?? 0) > 0

  if (code === 'INSUFFICIENT_STORAGE') return 'insufficient_storage'
  if (code === 'APK_NOT_FOUND') return 'apk_missing'
  if (
    code === 'SHA256_MISMATCH' ||
    code === 'UPSTREAM_SHA256_MISMATCH' ||
    code === 'INVALID_MANIFEST' ||
    code === 'UPSTREAM_INVALID_MANIFEST' ||
    code === 'RESPONSE_TOO_LARGE' ||
    code === 'APK_TOO_LARGE'
  ) {
    return 'checksum_mismatch'
  }
  if (
    code === 'SIGNATURE_MISMATCH' ||
    code === 'INVALID_APK' ||
    code === 'PACKAGE_NAME_MISMATCH' ||
    code === 'VERSION_MISMATCH' ||
    code === 'DOWNGRADE_REJECTED' ||
    code === 'INSTALL_LAUNCH_FAILED'
  ) {
    return 'signature_or_install_failed'
  }
  if (code === 'MANIFEST_NOT_FOUND' || code === 'MANIFEST_NOT_PUBLISHED') {
    return 'manifest_unavailable'
  }
  if (code === 'RATE_LIMITED' || status === 429) {
    return 'rate_limited'
  }

  if (context.source === 'desktop') {
    if (isOlderDesktopRelayError(error)) return 'desktop_relay_unsupported'
    if (/H5 access is disabled/i.test(extractErrorMessage(error))) {
      return 'desktop_relay_disconnected'
    }
    if (
      code === 'PROXY_UNAVAILABLE' ||
      code === 'UPSTREAM_TIMEOUT' ||
      code === 'UPSTREAM_UNREACHABLE' ||
      code === 'UPSTREAM_HTTP_ERROR' ||
      code === 'UPSTREAM_REDIRECT_BLOCKED' ||
      code === 'RELAY_ERROR' ||
      status === 502 ||
      status === 504
    ) {
      return 'desktop_relay_failed'
    }
    if (code === 'DOWNLOAD_INTERRUPTED') return 'download_interrupted'
    if (
      code === 'RELAY_UNAUTHORIZED' ||
      code === 'TIMEOUT' ||
      code === 'NETWORK_ERROR' ||
      code === 'TLS_ERROR' ||
      status === 401
    ) {
      return 'desktop_relay_disconnected'
    }
    return hasPartial && context.phase === 'download' ? 'download_interrupted' : 'desktop_relay_failed'
  }

  if (code === 'DOWNLOAD_INTERRUPTED') return 'download_interrupted'
  if (
    code === 'TIMEOUT' ||
    code === 'NETWORK_ERROR' ||
    code === 'TLS_ERROR' ||
    code === 'REDIRECT_BLOCKED' ||
    code === 'HTTP_ERROR'
  ) {
    if (context.phase === 'download' && hasPartial) return 'download_interrupted'
    return 'github_unreachable'
  }

  if (context.phase === 'install') return 'signature_or_install_failed'
  return hasPartial && context.phase === 'download' ? 'download_interrupted' : 'unknown'
}

function displayHostName(name: string | undefined): string {
  const trimmed = name?.trim()
  return trimmed || '已连接的电脑'
}

export function isUpdateActionable(snapshot: Pick<AndroidUpdateSnapshot, 'status' | 'release' | 'dismissedVersion'>): boolean {
  if (snapshot.status === 'downloading' || snapshot.status === 'verifying' || snapshot.status === 'downloaded' || snapshot.status === 'permission-needed') {
    return true
  }
  if (snapshot.status === 'available' && snapshot.release) {
    return snapshot.dismissedVersion !== snapshot.release.version
  }
  return false
}

function buildErrorCopyAndActions(snapshot: AndroidUpdateSnapshot): {
  message: string
  actions: UpdateAction[]
} {
  const hostLabel = displayHostName(snapshot.hostName)
  const canRelay = snapshot.desktopOnline && snapshot.desktopRelaySupported
  const hasPartial = snapshot.partialBytes > 0
  const hasRelease = Boolean(snapshot.release)
  const totalBytes = snapshot.totalBytes ?? snapshot.release?.sizeBytes ?? null
  const isCheckPhase = snapshot.errorPhase === 'check' || !hasRelease
  const preferredRedownload: UpdateActionKind =
    snapshot.errorSource === 'desktop' && canRelay ? 'downloadDesktop' : 'downloadDirect'

  switch (snapshot.errorKind) {
    case 'offline':
      return {
        message: '当前没有网络连接，请连接 Wi-Fi 或移动网络后重试。',
        actions: [
          {
            kind: isCheckPhase ? 'check' : snapshot.errorSource === 'desktop' ? 'downloadDesktop' : 'downloadDirect',
            label: '重试',
            look: 'primary',
          },
        ],
      }

    case 'github_unreachable':
      if (canRelay) {
        return {
          message: `当前网络无法直接连接 GitHub。如果手机开启了代理，请确认未将 cc-haha 排除在代理规则外；也可以直接通过 ${hostLabel} 代为${isCheckPhase ? '检查并下载' : '下载'}，或在浏览器中打开。`,
          actions: [
            {
              kind: isCheckPhase ? 'checkDesktop' : 'downloadDesktop',
              label: isCheckPhase ? '通过电脑检查' : '通过电脑下载',
              look: 'primary',
            },
            {
              kind: isCheckPhase ? 'checkDirectOnly' : 'downloadDirect',
              label: '重试直连',
              look: 'secondary',
            },
          ],
        }
      }
      if (snapshot.desktopOnline && !snapshot.desktopRelaySupported) {
        return {
          message: '当前网络无法连接 GitHub。升级电脑端 cc-haha 后可支持通过电脑下载，也可以先在浏览器打开或复制链接。',
          actions: [
            { kind: isCheckPhase ? 'checkDirectOnly' : 'downloadDirect', label: '重试', look: 'primary' },
            { kind: 'openBrowser', label: '在浏览器打开', look: 'secondary' },
          ],
        }
      }
      return {
        message: '当前网络无法连接 GitHub。请检查网络或代理（确认未排除 cc-haha）后重试，也可连接电脑后通过电脑下载。',
        actions: [
          { kind: isCheckPhase ? 'check' : 'downloadDirect', label: '重试', look: 'primary' },
          { kind: 'openBrowser', label: '在浏览器打开', look: 'secondary' },
        ],
      }

    case 'desktop_relay_unsupported':
      return {
        message: `${hostLabel} 的版本暂不支持代为下载更新，请先升级电脑端，或在手机浏览器中打开版本页下载。`,
        actions: [
          { kind: isCheckPhase ? 'checkDirectOnly' : 'downloadDirect', label: '尝试直连', look: 'primary' },
          { kind: 'openBrowser', label: '在浏览器打开', look: 'secondary' },
        ],
      }

    case 'desktop_relay_failed':
      return {
        message: `${hostLabel} 暂时无法访问 GitHub。如果电脑需要代理上网，请在电脑端「设置 → 通用」或「设置 → 关于」配置网络代理后重试。`,
        actions: [
          {
            kind: isCheckPhase ? 'checkDesktop' : 'downloadDesktop',
            label: hasPartial ? '继续下载' : '重试',
            look: 'primary',
          },
          { kind: isCheckPhase ? 'checkDirectOnly' : 'downloadDirect', label: '尝试直连', look: 'secondary' },
        ],
      }

    case 'desktop_relay_disconnected': {
      const progressNote = hasPartial ? `已保留 ${formatBytes(snapshot.partialBytes)} 进度。` : ''
      return {
        message: `与 ${hostLabel} 的连接已断开，请确认电脑在线并已开启手机连接后重试。${progressNote}`,
        actions: [
          {
            kind: isCheckPhase ? 'checkDesktop' : 'downloadDesktop',
            label: hasPartial ? '继续下载' : '重试',
            look: 'primary',
          },
          { kind: isCheckPhase ? 'checkDirectOnly' : 'downloadDirect', label: '尝试直连', look: 'secondary' },
        ],
      }
    }

    case 'download_interrupted': {
      const progress = hasPartial
        ? totalBytes
          ? `下载中断，已保存 ${formatBytes(snapshot.partialBytes)} / ${formatBytes(totalBytes)}，可从断点继续。`
          : `下载中断，已保存 ${formatBytes(snapshot.partialBytes)}，可从断点继续。`
        : '下载中断，请检查网络后重试。'
      const actions: UpdateAction[] = [
        {
          kind: snapshot.errorSource === 'desktop' ? 'downloadDesktop' : 'downloadDirect',
          label: hasPartial ? '继续下载' : '重新下载',
          look: 'primary',
        },
      ]
      if (snapshot.errorSource !== 'desktop' && canRelay) {
        actions.push({ kind: 'downloadDesktop', label: '通过电脑下载', look: 'secondary' })
      } else {
        actions.push({ kind: 'openBrowser', label: '在浏览器打开', look: 'secondary' })
      }
      return { message: progress, actions }
    }

    case 'rate_limited':
      return {
        message: 'GitHub 暂时限制了访问频率，请几分钟后再试，或前往版本页查看。',
        actions: canRelay
          ? [
              { kind: isCheckPhase ? 'checkDesktop' : 'downloadDesktop', label: isCheckPhase ? '通过电脑检查' : '通过电脑下载', look: 'primary' },
              { kind: 'openBrowser', label: '打开版本页', look: 'secondary' },
            ]
          : [
              { kind: isCheckPhase ? 'checkDirectOnly' : 'downloadDirect', label: '重试', look: 'primary' },
              { kind: 'openBrowser', label: '打开版本页', look: 'secondary' },
            ],
      }

    case 'checksum_mismatch':
      return {
        message: '安装包完整性校验未通过，已自动清理损坏文件，请重新下载。',
        actions: [
          { kind: preferredRedownload, label: '重新下载', look: 'primary' },
          ...(preferredRedownload !== 'downloadDesktop' && canRelay
            ? [{ kind: 'downloadDesktop' as const, label: '通过电脑下载', look: 'secondary' as const }]
            : [{ kind: 'openBrowser' as const, label: '在浏览器打开', look: 'secondary' as const }]),
        ],
      }

    case 'apk_missing':
      return {
        message: '本地缓存的安装包已被系统清理，请重新下载后再安装。',
        actions: [
          { kind: preferredRedownload, label: '重新下载', look: 'primary' },
          ...(preferredRedownload !== 'downloadDesktop' && canRelay
            ? [{ kind: 'downloadDesktop' as const, label: '通过电脑下载', look: 'secondary' as const }]
            : [{ kind: 'openBrowser' as const, label: '在浏览器打开', look: 'secondary' as const }]),
        ],
      }

    case 'insufficient_storage':
      return {
        message: '手机可用存储空间不足，无法下载或安装更新，清理空间后再试。',
        actions: [
          { kind: preferredRedownload, label: '重试', look: 'primary' },
        ],
      }

    case 'signature_or_install_failed': {
      const canRetryInstall = hasRelease && snapshot.errorPhase === 'install' && snapshot.errorCanRetryInstall
      if (canRetryInstall) {
        return {
          message: '无法启动系统安装程序。如果当前安装的是开发测试包，签名与正式版不同，需先卸载旧包再安装正式版，也可在浏览器中手动下载安装。',
          actions: [
            { kind: 'install', label: '重试安装', look: 'primary' },
            { kind: 'openBrowser', label: '在浏览器打开', look: 'secondary' },
          ],
        }
      }
      return {
        message: '安装包签名或版本校验未通过，无法直接覆盖安装。如果当前安装的是开发测试包，需先卸载旧包再安装正式版，也可在浏览器中手动下载。',
        actions: [
          ...(hasRelease ? [{ kind: preferredRedownload, label: '重新下载', look: 'secondary' as const }] : []),
          { kind: 'openBrowser', label: '在浏览器打开', look: 'primary' },
        ],
      }
    }

    case 'manifest_unavailable':
      return {
        message: '暂时没有找到可用的安卓安装包，新版本可能正在构建中，请稍后再检查。',
        actions: [
          { kind: 'check', label: '重新检查', look: 'primary' },
          { kind: 'openBrowser', label: '打开版本页', look: 'secondary' },
        ],
      }

    default:
      return {
        message: '更新暂时无法完成，请稍后重试，或在浏览器中手动下载安装。',
        actions: [
          { kind: isCheckPhase ? 'check' : preferredRedownload, label: '重试', look: 'primary' },
          { kind: 'openBrowser', label: '在浏览器打开', look: 'secondary' },
        ],
      }
  }
}

export function buildAndroidUpdateViewModel(snapshot: AndroidUpdateSnapshot): AndroidUpdateViewModel {
  const release = snapshot.release
  const version = release?.version ?? ''
  const sizeBytes = snapshot.totalBytes ?? release?.sizeBytes ?? null
  const sizeBadge = sizeBytes ? formatBytes(sizeBytes) : null
  const hostLabel = displayHostName(snapshot.hostName)
  const canRelay = snapshot.desktopOnline && snapshot.desktopRelaySupported
  const browserUrl = release?.releaseUrl ?? GITHUB_RELEASES_LATEST_URL
  const copyUrl = release?.downloadUrl ?? GITHUB_RELEASES_LATEST_URL
  const actionable = isUpdateActionable(snapshot)

  const homeDot: AndroidUpdateHomeDot | null = !actionable
    ? null
    : snapshot.status === 'downloaded'
      ? { tone: 'ok', accessibilitySuffix: '，新版本已就绪' }
      : { tone: 'run', accessibilitySuffix: '，有新版本可用' }

  const percent =
    snapshot.status === 'downloading' && sizeBytes && sizeBytes > 0
      ? Math.min(100, Math.round((snapshot.downloadedBytes / sizeBytes) * 100))
      : snapshot.status === 'verifying'
        ? 100
        : null

  let topNotice: AndroidUpdateTopNotice | null = null
  if (actionable && release) {
    if (snapshot.status === 'available') {
      topNotice = {
        tone: 'run',
        icon: 'arrow-down',
        title: `发现新版本 ${version}`,
        subtitle: sizeBadge ? `约 ${sizeBadge}，点击查看更新` : '点击查看更新并下载',
      }
    } else if (snapshot.status === 'downloading') {
      const preparing = snapshot.downloadingStage === 'desktop_preparing'
      const bytesText = sizeBytes
        ? `${formatBytes(snapshot.downloadedBytes)} / ${formatBytes(sizeBytes)}`
        : snapshot.downloadedBytes > 0
          ? `已下载 ${formatBytes(snapshot.downloadedBytes)}`
          : '正在准备…'
      topNotice = {
        tone: 'run',
        icon: 'arrow-down',
        spinning: true,
        title: preparing ? `电脑正在准备 ${version}` : `正在下载 ${version}`,
        subtitle: percent !== null ? `${percent}% · ${bytesText}` : bytesText,
        monoSubtitle: true,
      }
    } else if (snapshot.status === 'verifying') {
      topNotice = {
        tone: 'run',
        icon: 'arrow-down',
        spinning: true,
        title: `正在校验 ${version}`,
        subtitle: '正在核对安装包完整性',
      }
    } else if (snapshot.status === 'downloaded') {
      topNotice = {
        tone: 'ok',
        icon: 'circle-check',
        title: `新版本 ${version} 已准备好`,
        subtitle: '安装包已校验通过，点击安装',
      }
    } else if (snapshot.status === 'permission-needed') {
      topNotice = {
        tone: 'attn',
        icon: 'circle-alert',
        title: '需要允许安装更新',
        subtitle: '请先在系统设置里允许安装未知应用',
      }
    }
  }

  switch (snapshot.status) {
    case 'idle':
      return {
        rowValue: '',
        rowTone: 'muted',
        rowChecking: false,
        rowPressable: true,
        expanded: false,
        homeDot: null,
        topNotice: null,
        headline: '',
        sizeBadge: null,
        progressPercent: null,
        progressMeta: null,
        calloutTone: null,
        calloutText: null,
        description: null,
        note: null,
        actions: [],
        showExternalLinks: false,
        browserUrl,
        copyUrl,
      }

    case 'checking':
      return {
        rowValue: snapshot.checkingVia === 'desktop' ? '正在通过电脑检查…' : '正在检查…',
        rowTone: 'muted',
        rowChecking: true,
        rowPressable: false,
        expanded: false,
        homeDot: null,
        topNotice: null,
        headline: '',
        sizeBadge: null,
        progressPercent: null,
        progressMeta: null,
        calloutTone: null,
        calloutText: null,
        description: null,
        note: null,
        actions: [],
        showExternalLinks: false,
        browserUrl,
        copyUrl,
      }

    case 'up-to-date':
      return {
        rowValue: '已是最新',
        rowTone: 'muted',
        rowChecking: false,
        rowPressable: true,
        expanded: false,
        homeDot: null,
        topNotice: null,
        headline: '',
        sizeBadge: null,
        progressPercent: null,
        progressMeta: null,
        calloutTone: null,
        calloutText: null,
        description: null,
        note: null,
        actions: [],
        showExternalLinks: false,
        browserUrl,
        copyUrl,
      }

    case 'available': {
      const preferDesktop = release?.discoveredVia === 'desktop' && canRelay
      const hasPartial = snapshot.partialBytes > 0
      const actions: UpdateAction[] = []
      if (preferDesktop) {
        actions.push({
          kind: 'downloadDesktop',
          label: hasPartial ? '继续通过电脑下载' : '通过电脑下载',
          look: 'primary',
        })
        actions.push({ kind: 'downloadDirect', label: '尝试直连下载', look: 'secondary' })
      } else {
        actions.push({
          kind: 'downloadDirect',
          label: hasPartial ? '继续下载' : '下载更新',
          look: 'primary',
        })
        if (canRelay) {
          actions.push({ kind: 'downloadDesktop', label: '通过电脑下载', look: 'secondary' })
        }
      }
      if (release && snapshot.dismissedVersion !== release.version) {
        actions.push({ kind: 'dismiss', label: '暂不更新', look: 'plain' })
      }

      const notes: string[] = []
      if (preferDesktop) {
        notes.push(`当前网络直连 GitHub 受限，将通过 ${hostLabel} 下载。`)
      }
      if (hasPartial) {
        notes.push(`已下载 ${formatBytes(snapshot.partialBytes)}，可从断点继续。`)
      }
      const description = release
        ? `桌面发布版本 ${release.tag} 包含新版安卓客户端（当前 ${snapshot.currentVersion || '未知'} → ${release.version}）。下载后会在本机校验签名和完整性。`
        : null

      return {
        rowValue: `新版本 ${version}`,
        rowTone: 'run',
        rowChecking: false,
        rowPressable: true,
        expanded: true,
        homeDot,
        topNotice,
        headline: `新版本 ${version}`,
        sizeBadge,
        progressPercent: null,
        progressMeta: null,
        calloutTone: null,
        calloutText: null,
        description,
        note: notes.length ? notes.join(' ') : null,
        actions,
        showExternalLinks: true,
        browserUrl,
        copyUrl,
      }
    }

    case 'downloading': {
      const preparing = snapshot.downloadingStage === 'desktop_preparing'
      const viaSuffix = snapshot.downloadingVia === 'desktop' ? ` · 经由 ${hostLabel}` : ''
      const bytesText = sizeBytes
        ? `${formatBytes(snapshot.downloadedBytes)} / ${formatBytes(sizeBytes)}`
        : snapshot.downloadedBytes > 0
          ? `已下载 ${formatBytes(snapshot.downloadedBytes)}`
          : '正在准备…'
      return {
        rowValue: percent !== null ? `${percent}%` : preparing ? '电脑准备中…' : '下载中…',
        rowTone: 'run',
        rowChecking: false,
        rowPressable: false,
        expanded: true,
        homeDot,
        topNotice,
        headline: preparing ? `${hostLabel} 正在拉取 ${version}` : `正在下载 ${version}`,
        sizeBadge: percent !== null ? `${percent}%` : null,
        progressPercent: percent,
        progressMeta: `${bytesText}${viaSuffix}`,
        calloutTone: null,
        calloutText: null,
        description: null,
        note: preparing
          ? '电脑正在从 GitHub 下载安装包，完成后将自动传到手机。切换回任务页也会继续。'
          : '切换回任务页也会继续下载。',
        actions: [{ kind: 'cancelDownload', label: '取消下载', look: 'secondary' }],
        showExternalLinks: false,
        browserUrl,
        copyUrl,
      }
    }

    case 'verifying':
      return {
        rowValue: '校验中…',
        rowTone: 'run',
        rowChecking: true,
        rowPressable: false,
        expanded: true,
        homeDot,
        topNotice,
        headline: '正在校验安装包…',
        sizeBadge: null,
        progressPercent: 100,
        progressMeta: null,
        calloutTone: null,
        calloutText: null,
        description: '正在核对安装包完整性和签名，请稍候。',
        note: null,
        actions: [],
        showExternalLinks: false,
        browserUrl,
        copyUrl,
      }

    case 'downloaded':
      return {
        rowValue: '待安装',
        rowTone: 'ok',
        rowChecking: false,
        rowPressable: false,
        expanded: true,
        homeDot,
        topNotice,
        headline: `新版本 ${version} 已准备好`,
        sizeBadge,
        progressPercent: null,
        progressMeta: null,
        calloutTone: null,
        calloutText: null,
        description: sizeBadge
          ? `安装包已校验通过（${sizeBadge}），点击后会打开系统安装界面。`
          : '安装包已校验通过，点击后会打开系统安装界面。',
        note: snapshot.installCancelledHint
          ? '上次未完成安装，可随时重新安装。小米、华为等手机可能会提示安全检查，按系统提示确认即可。'
          : '小米、华为等手机可能会弹出安全检查或倒计时提示，按系统提示确认即可。',
        actions: [
          { kind: 'install', label: '立即安装', look: 'primary' },
          { kind: 'deleteApk', label: '删除安装包', look: 'plain' },
        ],
        showExternalLinks: false,
        browserUrl,
        copyUrl,
      }

    case 'permission-needed':
      return {
        rowValue: '需允许安装',
        rowTone: 'attn',
        rowChecking: false,
        rowPressable: false,
        expanded: true,
        homeDot,
        topNotice,
        headline: `安装 ${version} 前需开启权限`,
        sizeBadge: null,
        progressPercent: null,
        progressMeta: null,
        calloutTone: 'attention',
        calloutText:
          '安卓系统需要单独开启「允许安装未知应用」权限，才能完成应用内更新。开启后返回 cc-haha 即可继续安装。',
        description: null,
        note: snapshot.permissionStillDenied
          ? '还未开启「允许安装未知应用」权限，开启后即可继续安装。'
          : null,
        actions: [
          { kind: 'openUnknownSources', label: '去系统设置开启', look: 'primary' },
          { kind: 'retryInstallAfterPermission', label: '我已开启，继续安装', look: 'secondary' },
        ],
        showExternalLinks: true,
        browserUrl,
        copyUrl,
      }

    case 'installing':
      return {
        rowValue: '安装中…',
        rowTone: 'run',
        rowChecking: true,
        rowPressable: false,
        expanded: true,
        homeDot,
        topNotice,
        headline: '正在打开系统安装程序…',
        sizeBadge: null,
        progressPercent: null,
        progressMeta: null,
        calloutTone: null,
        calloutText: null,
        description: `请在系统弹出的界面中确认安装。安装完成后重新打开 cc-haha 即可使用 ${version}。`,
        note: null,
        actions: [{ kind: 'install', label: '重新打开安装界面', look: 'secondary' }],
        showExternalLinks: false,
        browserUrl,
        copyUrl,
      }

    case 'error': {
      const { message, actions } = buildErrorCopyAndActions(snapshot)
      const rowValue =
        snapshot.errorPhase === 'download'
          ? '下载失败'
          : snapshot.errorPhase === 'install'
            ? '安装失败'
            : '检查失败'
      return {
        rowValue,
        rowTone: 'err',
        rowChecking: false,
        rowPressable: true,
        expanded: true,
        homeDot: null,
        topNotice: null,
        headline: release ? `新版本 ${version}` : '检查更新',
        sizeBadge,
        progressPercent: null,
        progressMeta: null,
        calloutTone: 'error',
        calloutText: message,
        description: null,
        note: null,
        actions,
        showExternalLinks: true,
        browserUrl,
        copyUrl,
      }
    }
  }
}
