import { requireOptionalNativeModule } from 'expo'

export type InstalledAppInfo = {
  packageName: string
  versionName: string
  versionCode: number
  signingCertSha256s: string[]
}

export type CachedApkStatus = {
  ready: boolean
  verified: boolean
  partialBytes: number
  totalBytes: number | null
  sizeBytes: number | null
  versionName: string | null
  versionCode: number | null
}

export type DownloadApkOptions = {
  downloadId: string
  source: 'github' | 'relay'
  url: string
  expectedSha256: string
  expectedVersion: string
  relayOrigin?: string
  headers?: Record<string, string>
}

export type DownloadProgressEvent = {
  downloadId: string
  phase: 'connecting' | 'downloading' | 'verifying'
  bytesWritten: number
  totalBytes: number | null
  resumedFromBytes: number
}

export type DownloadedApkResult = {
  sha256: string
  versionName: string
  versionCode: number
  sizeBytes: number
}

export type InstallApkResult = {
  launched: boolean
  needsUnknownSourcesPermission: boolean
}

export type CCHahaUpdaterModule = {
  getInstalledAppInfo(): InstalledAppInfo
  canRequestPackageInstalls(): boolean
  openUnknownSourcesSettings(): boolean
  cancelDownload(downloadId: string | null, deletePartial: boolean): boolean
  fetchGitHubManifest(): Promise<string>
  getCachedApk(expectedSha256: string, expectedVersion: string | null): Promise<CachedApkStatus>
  cleanupCachedApks(keepSha256: string | null): Promise<number>
  downloadApk(optionsJson: string): Promise<DownloadedApkResult>
  installApk(expectedSha256: string, expectedVersion: string): Promise<InstallApkResult>
  addListener(
    eventName: 'onDownloadProgress',
    listener: (event: DownloadProgressEvent) => void
  ): { remove(): void }
}

/** Android only; `null` elsewhere (iOS, web/H5, Expo Go). */
export default requireOptionalNativeModule<CCHahaUpdaterModule>('CCHahaUpdater')
