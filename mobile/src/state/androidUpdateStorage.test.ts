import { describe, expect, test } from 'bun:test'
import {
  AndroidUpdateStore,
  EMPTY_ANDROID_UPDATE_RECORD,
  parseAndroidUpdateRecord,
} from './androidUpdateStorage'
import {
  isAndroidOtaSupported,
  STORE_CLIENT_EXECUTION_ENVIRONMENT,
} from './androidUpdateSupport'
import type { Storage } from './storage'

function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    getItem: async (key) => map.get(key) ?? null,
    setItem: async (key, value) => {
      map.set(key, value)
    },
    removeItem: async (key) => {
      map.delete(key)
    },
  }
}

describe('androidUpdateStorage & support gate', () => {
  test('gating allows only Android native non-H5 non-StoreClient builds with native module', () => {
    expect(
      isAndroidOtaSupported({
        platform: 'android',
        isH5: false,
        executionEnvironment: 'standalone',
        hasNativeModule: true,
      })
    ).toBe(true)
    expect(
      isAndroidOtaSupported({
        platform: 'ios',
        isH5: false,
        executionEnvironment: 'standalone',
        hasNativeModule: true,
      })
    ).toBe(false)
    expect(
      isAndroidOtaSupported({
        platform: 'android',
        isH5: true,
        executionEnvironment: 'standalone',
        hasNativeModule: true,
      })
    ).toBe(false)
    expect(
      isAndroidOtaSupported({
        platform: 'android',
        isH5: false,
        executionEnvironment: STORE_CLIENT_EXECUTION_ENVIRONMENT,
        hasNativeModule: true,
      })
    ).toBe(false)
    expect(
      isAndroidOtaSupported({
        platform: 'android',
        isH5: false,
        executionEnvironment: 'standalone',
        hasNativeModule: false,
      })
    ).toBe(false)
  })

  test('handles missing, corrupt, and future schema versions gracefully', () => {
    expect(parseAndroidUpdateRecord(null)).toEqual(EMPTY_ANDROID_UPDATE_RECORD)
    expect(parseAndroidUpdateRecord('{broken-json')).toEqual(EMPTY_ANDROID_UPDATE_RECORD)
    expect(parseAndroidUpdateRecord(JSON.stringify({ version: 99, lastCheckedAt: 123 }))).toEqual(
      EMPTY_ANDROID_UPDATE_RECORD
    )
  })

  test('round-trips valid records and drops malformed sub-records', async () => {
    const sha = 'a'.repeat(64)
    const store = new AndroidUpdateStore(memoryStorage())
    const saved = await store.update((cur) => ({
      ...cur,
      lastCheckedAt: 1_700_000_000_000,
      dismissedVersion: '0.1.7',
      downloaded: {
        version: '0.1.7',
        tag: 'v0.8.1',
        asset: 'cc-haha-mobile-0.1.7-abc.apk',
        sha256: sha,
        sizeBytes: 70_000_000,
        releaseUrl: 'https://github.com/NanmiCoder/cc-haha/releases/tag/v0.8.1',
        downloadUrl: 'https://github.com/NanmiCoder/cc-haha/releases/download/v0.8.1/cc-haha-mobile-0.1.7-abc.apk',
        verifiedAt: 1_700_000_005_000,
      },
      pendingInstall: {
        version: '0.1.7',
        sha256: sha,
        requestedAt: 1_700_000_010_000,
      },
    }))

    expect(await store.load()).toEqual(saved)

    const partialCorrupt = parseAndroidUpdateRecord(
      JSON.stringify({
        version: 1,
        lastCheckedAt: 1234,
        dismissedVersion: 'not-semver',
        downloaded: { version: '0.1.7', sha256: 'bad' },
        partial: null,
        pendingInstall: { version: '0.1.7', sha256: sha, requestedAt: 5000 },
      })
    )
    expect(partialCorrupt.lastCheckedAt).toBe(1234)
    expect(partialCorrupt.dismissedVersion).toBeNull()
    expect(partialCorrupt.downloaded).toBeNull()
    expect(partialCorrupt.pendingInstall).toEqual({ version: '0.1.7', sha256: sha, requestedAt: 5000 })
  })
})
