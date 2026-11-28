import { describe, expect, test } from 'bun:test'
import {
  buildAndroidUpdateViewModel,
  classifyUpdateError,
  compareSemver,
  isNewerVersion,
  isOlderDesktopRelayError,
  parseAndroidReleaseManifest,
  releaseFromManifest,
  type AndroidReleaseManifest,
  type AndroidUpdateSnapshot,
} from './androidUpdateModel'

const validManifest: AndroidReleaseManifest = {
  schemaVersion: 1,
  platform: 'android',
  tag: 'v0.8.1',
  commit: 'a'.repeat(40),
  fingerprint: 'b'.repeat(64),
  version: '0.1.7',
  buildId: '12345678-1234-1234-1234-123456789abc',
  deliveredAt: '2026-11-25T10:00:00Z',
  destination: 'github-release',
  asset: 'cc-haha-mobile-0.1.7-12345678-1234-1234-1234-123456789abc.apk',
  sha256: 'c'.repeat(64),
}

function baseSnapshot(overrides: Partial<AndroidUpdateSnapshot> = {}): AndroidUpdateSnapshot {
  return {
    status: 'idle',
    checkingVia: 'github',
    currentVersion: '0.1.6',
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
    desktopOnline: true,
    desktopRelaySupported: true,
    hostName: 'MacBook Pro',
    ...overrides,
  }
}

describe('androidUpdateModel', () => {
  test('parses valid Android release manifests and rejects invalid shapes', () => {
    expect(parseAndroidReleaseManifest(validManifest)).toEqual(validManifest)
    expect(parseAndroidReleaseManifest({ ...validManifest, platform: 'ios' })).toBeNull()
    expect(parseAndroidReleaseManifest({ ...validManifest, schemaVersion: 2 })).toBeNull()
    expect(parseAndroidReleaseManifest({ ...validManifest, sha256: 'short' })).toBeNull()
    expect(parseAndroidReleaseManifest({ ...validManifest, asset: '../evil.apk' })).toBeNull()
    expect(parseAndroidReleaseManifest(null)).toBeNull()
  })

  test('compares mobile semver independently from desktop release tag', () => {
    expect(compareSemver('0.1.7', '0.1.6')).toBeGreaterThan(0)
    expect(compareSemver('0.1.6', '0.1.6')).toBe(0)
    expect(compareSemver('0.1.5', '0.1.6')).toBeLessThan(0)
    expect(isNewerVersion('0.1.7', '0.1.6')).toBe(true)
    expect(isNewerVersion('0.1.6', '0.1.6')).toBe(false)
    expect(isNewerVersion('0.1.6', '0.1.7')).toBe(false)
    expect(isNewerVersion('invalid', '0.1.6')).toBe(false)
  })

  test('classifies offline, GitHub unreachable, older desktop, relay errors, and interrupted downloads', () => {
    expect(
      classifyUpdateError(new Error('any'), { source: 'github', phase: 'check', online: false })
    ).toBe('offline')

    expect(
      classifyUpdateError(Object.assign(new Error('timeout'), { code: 'TIMEOUT' }), {
        source: 'github',
        phase: 'check',
        online: true,
      })
    ).toBe('github_unreachable')

    expect(
      classifyUpdateError(Object.assign(new Error('reset'), { code: 'NETWORK_ERROR' }), {
        source: 'github',
        phase: 'download',
        online: true,
        partialBytes: 1024 * 1024,
      })
    ).toBe('download_interrupted')

    expect(
      classifyUpdateError(Object.assign(new Error('sha'), { code: 'SHA256_MISMATCH' }), {
        source: 'github',
        phase: 'download',
        online: true,
      })
    ).toBe('checksum_mismatch')

    expect(
      classifyUpdateError(Object.assign(new Error('sig'), { code: 'SIGNATURE_MISMATCH' }), {
        source: 'github',
        phase: 'install',
        online: true,
      })
    ).toBe('signature_or_install_failed')

    expect(
      classifyUpdateError(Object.assign(new Error('not found'), { status: 404 }), {
        source: 'desktop',
        phase: 'check',
        online: true,
      })
    ).toBe('desktop_relay_unsupported')

    expect(
      isOlderDesktopRelayError(Object.assign(new Error('not published'), { status: 404, code: 'MANIFEST_NOT_PUBLISHED' }))
    ).toBe(false)

    expect(
      classifyUpdateError(Object.assign(new Error('proxy'), { status: 502, code: 'PROXY_UNAVAILABLE' }), {
        source: 'desktop',
        phase: 'check',
        online: true,
      })
    ).toBe('desktop_relay_failed')

    expect(
      classifyUpdateError(Object.assign(new Error('timeout'), { code: 'TIMEOUT' }), {
        source: 'desktop',
        phase: 'download',
        online: true,
      })
    ).toBe('desktop_relay_disconnected')
  })

  test('builds desktop-first actions when release was discovered via desktop relay', () => {
    const release = releaseFromManifest(validManifest, { discoveredVia: 'desktop', sizeBytes: 68_000_000 })
    const vm = buildAndroidUpdateViewModel(
      baseSnapshot({
        status: 'available',
        release,
      })
    )
    expect(vm.expanded).toBe(true)
    expect(vm.homeDot?.tone).toBe('run')
    expect(vm.topNotice?.title).toBe('发现新版本 0.1.7')
    expect(vm.actions.map((a) => a.kind)).toEqual(['downloadDesktop', 'downloadDirect', 'dismiss'])
    expect(vm.note).toContain('MacBook Pro')
    expect(vm.showExternalLinks).toBe(true)
  })

  test('hides home dot and top notice when available version is dismissed', () => {
    const release = releaseFromManifest(validManifest, { discoveredVia: 'github', sizeBytes: 68_000_000 })
    const vm = buildAndroidUpdateViewModel(
      baseSnapshot({
        status: 'available',
        release,
        dismissedVersion: '0.1.7',
      })
    )
    expect(vm.homeDot).toBeNull()
    expect(vm.topNotice).toBeNull()
    expect(vm.actions.map((a) => a.kind)).toEqual(['downloadDirect', 'downloadDesktop'])
  })

  test('shows green home dot and install action when APK is downloaded and verified', () => {
    const release = releaseFromManifest(validManifest, { discoveredVia: 'github', sizeBytes: 68_000_000 })
    const vm = buildAndroidUpdateViewModel(
      baseSnapshot({
        status: 'downloaded',
        release,
        totalBytes: 68_000_000,
        installCancelledHint: true,
      })
    )
    expect(vm.homeDot?.tone).toBe('ok')
    expect(vm.topNotice?.tone).toBe('ok')
    expect(vm.actions.map((a) => a.kind)).toEqual(['install', 'deleteApk'])
    expect(vm.note).toContain('上次未完成安装')
  })

  test('offers desktop relay primary CTA when GitHub is unreachable and desktop is online', () => {
    const vm = buildAndroidUpdateViewModel(
      baseSnapshot({
        status: 'error',
        errorKind: 'github_unreachable',
        errorSource: 'github',
        errorPhase: 'check',
        desktopOnline: true,
        desktopRelaySupported: true,
      })
    )
    expect(vm.calloutTone).toBe('error')
    expect(vm.calloutText).toContain('MacBook Pro')
    expect(vm.calloutText).toContain('排除在代理规则外')
    expect(vm.actions.map((a) => a.kind)).toEqual(['checkDesktop', 'checkDirectOnly'])
    expect(vm.showExternalLinks).toBe(true)
  })

  test('distinguishes error rowValue per phase, H5-disabled 403, apk_missing, and non-retryable signature failures', () => {
    const release = releaseFromManifest(validManifest, { discoveredVia: 'desktop', sizeBytes: 68_000_000 })

    // H5-disabled 403 on a modern desktop is NOT classified as older desktop.
    const h5Disabled = Object.assign(
      new Error('H5 access is disabled. Enable H5 access from the local desktop app first.'),
      { status: 403 }
    )
    expect(isOlderDesktopRelayError(h5Disabled)).toBe(false)
    expect(classifyUpdateError(h5Disabled, { source: 'desktop', phase: 'check', online: true })).toBe(
      'desktop_relay_disconnected'
    )

    // APK_NOT_FOUND offers re-download (remembering desktop source), not retry-install loop.
    expect(
      classifyUpdateError(Object.assign(new Error('missing'), { code: 'APK_NOT_FOUND' }), {
        source: 'desktop',
        phase: 'install',
        online: true,
      })
    ).toBe('apk_missing')
    const missingVm = buildAndroidUpdateViewModel(
      baseSnapshot({
        status: 'error',
        release,
        errorKind: 'apk_missing',
        errorSource: 'desktop',
        errorPhase: 'install',
      })
    )
    expect(missingVm.rowValue).toBe('安装失败')
    expect(missingVm.actions.map((a) => a.kind)).toEqual(['downloadDesktop', 'openBrowser'])

    // Download-phase signature failure deletes the file so must NOT offer 'install'.
    const dlSigVm = buildAndroidUpdateViewModel(
      baseSnapshot({
        status: 'error',
        release,
        errorKind: 'signature_or_install_failed',
        errorSource: 'github',
        errorPhase: 'download',
        errorCanRetryInstall: false,
      })
    )
    expect(dlSigVm.rowValue).toBe('下载失败')
    expect(dlSigVm.actions.map((a) => a.kind)).toEqual(['downloadDirect', 'openBrowser'])

    // Install-phase launch failure (verified file still present) still offers 'install'.
    const launchVm = buildAndroidUpdateViewModel(
      baseSnapshot({
        status: 'error',
        release,
        errorKind: 'signature_or_install_failed',
        errorSource: 'github',
        errorPhase: 'install',
        errorCanRetryInstall: true,
      })
    )
    expect(launchVm.actions.map((a) => a.kind)).toEqual(['install', 'openBrowser'])

    // Installing state always exposes a recovery button and desktop_preparing copy is distinct.
    const installingVm = buildAndroidUpdateViewModel(baseSnapshot({ status: 'installing', release }))
    expect(installingVm.actions.map((a) => a.kind)).toEqual(['install'])
    const prepVm = buildAndroidUpdateViewModel(
      baseSnapshot({
        status: 'downloading',
        release,
        downloadingVia: 'desktop',
        downloadingStage: 'desktop_preparing',
        downloadedBytes: 20_000_000,
        totalBytes: 60_000_000,
      })
    )
    expect(prepVm.headline).toContain('正在拉取')
    expect(prepVm.topNotice?.title).toContain('电脑正在准备')
  })
})
