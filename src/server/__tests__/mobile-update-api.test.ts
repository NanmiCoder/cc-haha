import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { handleMobileUpdateApi } from '../api/mobileUpdate.js'
import {
  isTrustedGitHubReleaseUrl,
  MOBILE_UPDATE_HEADER,
  MobileUpdateService,
  resolveDesktopUpdateProxyFetchOptions,
  type AndroidReleaseManifest,
} from '../services/mobileUpdateService.js'

const tempDirs: string[] = []
const servers: Array<{ stop: (closeActive?: boolean) => void }> = []

afterEach(() => {
  while (servers.length > 0) {
    servers.pop()!.stop(true)
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-haha-mobile-update-test-'))
  tempDirs.push(dir)
  return dir
}

function makeFakeApk(label: string) {
  // Valid ZIP magic bytes ("PK\x03\x04") + distinct payload bytes.
  const body = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(label.repeat(2048))])
  const sha256 = createHash('sha256').update(body).digest('hex')
  return { body, sha256 }
}

function makeManifest(sha256: string, overrides: Partial<AndroidReleaseManifest> = {}): AndroidReleaseManifest {
  return {
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
    sha256,
    ...overrides,
  }
}

function startMockUpstream(handler: (req: Request, url: URL) => Response | Promise<Response>) {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      return handler(req, new URL(req.url))
    },
  })
  servers.push(server)
  return `http://127.0.0.1:${server.port}`
}

async function callApi(service: MobileUpdateService, rawPath: string, init: RequestInit = {}) {
  const url = new URL(rawPath, 'http://localhost')
  const segments = url.pathname.split('/').filter(Boolean)
  const req = new Request(url.toString(), init)
  return handleMobileUpdateApi(req, url, segments, service)
}

describe('mobile-update API & service', () => {
  test('trusted GitHub redirect allowlist accepts release asset hosts and rejects others', () => {
    expect(isTrustedGitHubReleaseUrl(new URL('https://github.com/NanmiCoder/cc-haha/releases/latest'))).toBe(true)
    expect(isTrustedGitHubReleaseUrl(new URL('https://objects.githubusercontent.com/github-production-release-asset/1'))).toBe(true)
    expect(isTrustedGitHubReleaseUrl(new URL('https://release-assets.githubusercontent.com/1'))).toBe(true)
    expect(isTrustedGitHubReleaseUrl(new URL('http://objects.githubusercontent.com/1'))).toBe(false)
    expect(isTrustedGitHubReleaseUrl(new URL('https://raw.githubusercontent.com/NanmiCoder/cc-haha/main/a.apk'))).toBe(false)
    expect(isTrustedGitHubReleaseUrl(new URL('https://avatars.githubusercontent.com/u/1'))).toBe(false)
    expect(isTrustedGitHubReleaseUrl(new URL('https://evil.example.com/a.apk'))).toBe(false)
    expect(isTrustedGitHubReleaseUrl(new URL('https://user:pass@github.com/a'))).toBe(false)
    expect(isTrustedGitHubReleaseUrl(new URL('https://github.com:8443/a'))).toBe(false)
  })

  test('fetches manifest via validated redirect, caches 60s, and serves Range/If-Range APK from disk cache', async () => {
    const apk = makeFakeApk('release-0.1.7-')
    const manifest = makeManifest(apk.sha256)
    let manifestHits = 0
    let apkHits = 0

    const origin = startMockUpstream((_req, url) => {
      if (url.pathname === '/manifest') {
        manifestHits++
        return new Response(null, { status: 302, headers: { Location: `${origin}/cdn/mobile-release-android.json` } })
      }
      if (url.pathname === '/cdn/mobile-release-android.json') {
        return Response.json(manifest)
      }
      if (url.pathname === '/apk') {
        apkHits++
        return new Response(null, { status: 302, headers: { Location: `${origin}/cdn/${manifest.asset}` } })
      }
      if (url.pathname === `/cdn/${manifest.asset}`) {
        return new Response(apk.body, {
          status: 200,
          headers: { 'Content-Length': String(apk.body.length) },
        })
      }
      return new Response('not found', { status: 404 })
    })

    const cacheDir = makeTempDir()
    const service = new MobileUpdateService({
      cacheDir,
      manifestUrl: `${origin}/manifest`,
      apkUrlBuilder: () => `${origin}/apk`,
      isAllowedRedirectUrl: (url) => url.origin === origin,
      resolveProxyOptions: async () => ({}),
    })

    // First /latest hits upstream.
    const r1 = await callApi(service, '/api/mobile-update/android/latest')
    expect(r1.status).toBe(200)
    expect(r1.headers.get(MOBILE_UPDATE_HEADER)).toBe('1')
    const body1 = await r1.json() as { available: boolean; manifest: AndroidReleaseManifest; cachedSizeBytes: number | null; releaseUrl: string }
    expect(body1.available).toBe(true)
    expect(body1.manifest.version).toBe('0.1.7')
    expect(body1.cachedSizeBytes).toBeNull()
    expect(body1.releaseUrl).toBe('https://github.com/NanmiCoder/cc-haha/releases/tag/v0.8.1')
    expect(manifestHits).toBe(1)

    // Second /latest uses 60s cache.
    const r2 = await callApi(service, '/api/mobile-update/android/latest')
    expect(r2.status).toBe(200)
    expect(manifestHits).toBe(1)

    // ?refresh=1 bypasses cache.
    const r3 = await callApi(service, '/api/mobile-update/android/latest?refresh=1')
    expect(r3.status).toBe(200)
    expect(manifestHits).toBe(2)

    // Concurrent /apk downloads coalesce via singleflight into 1 upstream fetch.
    const [dl1, dl2] = await Promise.all([
      callApi(service, `/api/mobile-update/android/apk?sha256=${apk.sha256}`),
      callApi(service, `/api/mobile-update/android/apk?sha256=${apk.sha256}`),
    ])
    expect(dl1.status).toBe(200)
    expect(dl2.status).toBe(200)
    expect(apkHits).toBe(1)
    expect(dl1.headers.get('content-type')).toBe('application/vnd.android.package-archive')
    expect(dl1.headers.get('etag')).toBe(`"${apk.sha256}"`)
    expect(dl1.headers.get(MOBILE_UPDATE_HEADER)).toBe('1')
    expect(Buffer.from(await dl1.arrayBuffer()).equals(apk.body)).toBe(true)
    expect(Buffer.from(await dl2.arrayBuffer()).equals(apk.body)).toBe(true)

    // Range request with matching If-Range serves 206 from disk cache without upstream fetch.
    const partial = await callApi(service, `/api/mobile-update/android/apk?sha256=${apk.sha256}`, {
      headers: {
        Range: 'bytes=100-199',
        'If-Range': `"${apk.sha256}"`,
      },
    })
    expect(partial.status).toBe(206)
    expect(partial.headers.get('content-range')).toBe(`bytes 100-199/${apk.body.length}`)
    expect(Buffer.from(await partial.arrayBuffer()).equals(apk.body.subarray(100, 200))).toBe(true)
    expect(apkHits).toBe(1)

    // If-Range mismatch falls back to full 200.
    const mismatchIfRange = await callApi(service, `/api/mobile-update/android/apk?sha256=${apk.sha256}`, {
      headers: {
        Range: 'bytes=100-199',
        'If-Range': '"stale-etag"',
      },
    })
    expect(mismatchIfRange.status).toBe(200)
    expect((await mismatchIfRange.arrayBuffer()).byteLength).toBe(apk.body.length)

    // Unsatisfiable range returns 416.
    const badRange = await callApi(service, `/api/mobile-update/android/apk?sha256=${apk.sha256}`, {
      headers: { Range: `bytes=${apk.body.length + 50}-` },
    })
    expect(badRange.status).toBe(416)

    // Subsequent /latest reports cachedSizeBytes.
    const r4 = await callApi(service, '/api/mobile-update/android/latest')
    const body4 = await r4.json() as { cachedSizeBytes: number | null }
    expect(body4.cachedSizeBytes).toBe(apk.body.length)
  })

  test('returns available:false on GitHub 404 and 409 RELEASE_CHANGED when requested sha256 is stale', async () => {
    const apk = makeFakeApk('newer-apk-')
    const manifest = makeManifest(apk.sha256, { version: '0.1.8', tag: 'v0.8.2' })
    let published = false

    const origin = startMockUpstream((_req, url) => {
      if (url.pathname === '/manifest') {
        if (!published) return new Response('Not Found', { status: 404 })
        return Response.json(manifest)
      }
      return new Response('not found', { status: 404 })
    })

    const service = new MobileUpdateService({
      cacheDir: makeTempDir(),
      manifestUrl: `${origin}/manifest`,
      apkUrlBuilder: () => `${origin}/apk`,
      isAllowedRedirectUrl: (url) => url.origin === origin,
      resolveProxyOptions: async () => ({}),
    })

    const notYet = await callApi(service, '/api/mobile-update/android/latest')
    expect(notYet.status).toBe(200)
    expect(await notYet.json()).toEqual({
      supported: true,
      available: false,
      reason: 'not_published',
      manifest: null,
    })

    published = true
    const staleSha = 'f'.repeat(64)
    const conflict = await callApi(service, `/api/mobile-update/android/apk?sha256=${staleSha}`)
    expect(conflict.status).toBe(409)
    expect(conflict.headers.get(MOBILE_UPDATE_HEADER)).toBe('1')
    const body = await conflict.json() as { code: string; manifest: AndroidReleaseManifest }
    expect(body.code).toBe('RELEASE_CHANGED')
    expect(body.manifest.sha256).toBe(apk.sha256)
  })

  test('blocks untrusted redirects and deletes temp files on SHA-256 mismatch or non-APK magic', async () => {
    const goodApk = makeFakeApk('good-')
    const manifest = makeManifest(goodApk.sha256)
    let mode: 'redirect' | 'bad-sha' | 'bad-magic' = 'redirect'

    const origin = startMockUpstream((_req, url) => {
      if (url.pathname === '/manifest') {
        if (mode === 'redirect') {
          return new Response(null, { status: 302, headers: { Location: 'https://evil.example.com/manifest.json' } })
        }
        return Response.json(manifest)
      }
      if (url.pathname === '/apk') {
        if (mode === 'bad-sha') {
          return new Response(Buffer.concat([Buffer.from([0x50, 0x4b]), Buffer.from('corrupt')]))
        }
        return new Response(Buffer.from('<html>not an apk</html>'))
      }
      return new Response('not found', { status: 404 })
    })

    const cacheDir = makeTempDir()
    const service = new MobileUpdateService({
      cacheDir,
      manifestUrl: `${origin}/manifest`,
      apkUrlBuilder: () => `${origin}/apk`,
      isAllowedRedirectUrl: (url) => url.origin === origin,
      resolveProxyOptions: async () => ({}),
    })

    const rRedirect = await callApi(service, '/api/mobile-update/android/latest')
    expect(rRedirect.status).toBe(502)
    expect((await rRedirect.json() as { code: string }).code).toBe('UPSTREAM_REDIRECT_BLOCKED')

    mode = 'bad-sha'
    const rBadSha = await callApi(service, `/api/mobile-update/android/apk?sha256=${goodApk.sha256}`)
    expect(rBadSha.status).toBe(502)
    expect((await rBadSha.json() as { code: string }).code).toBe('UPSTREAM_SHA256_MISMATCH')
    expect(fs.readdirSync(cacheDir)).toEqual([])

    mode = 'bad-magic'
    const rBadMagic = await callApi(service, `/api/mobile-update/android/apk?sha256=${goodApk.sha256}`)
    expect(rBadMagic.status).toBe(502)
    expect((await rBadMagic.json() as { code: string }).code).toBe('UPSTREAM_SHA256_MISMATCH')
    expect(fs.readdirSync(cacheDir)).toEqual([])
  })

  test('prunes older cached APK when a newer release is promoted and enforces query/method validation', async () => {
    const apk1 = makeFakeApk('v1-')
    const apk2 = makeFakeApk('v2-')
    let current = { manifest: makeManifest(apk1.sha256, { version: '0.1.7', tag: 'v0.8.1' }), body: apk1.body }

    const origin = startMockUpstream((_req, url) => {
      if (url.pathname === '/manifest') return Response.json(current.manifest)
      if (url.pathname === '/apk') return new Response(current.body)
      return new Response('not found', { status: 404 })
    })

    const cacheDir = makeTempDir()
    const service = new MobileUpdateService({
      cacheDir,
      manifestUrl: `${origin}/manifest`,
      apkUrlBuilder: () => `${origin}/apk`,
      isAllowedRedirectUrl: (url) => url.origin === origin,
      resolveProxyOptions: async () => ({}),
    })

    expect((await callApi(service, '/api/mobile-update/android/latest', { method: 'POST' })).status).toBe(405)
    expect((await callApi(service, '/api/mobile-update/android/apk?sha256=bad')).status).toBe(400)

    expect((await callApi(service, `/api/mobile-update/android/apk?sha256=${apk1.sha256}`)).status).toBe(200)
    expect(fs.existsSync(path.join(cacheDir, `${apk1.sha256}.apk`))).toBe(true)

    current = { manifest: makeManifest(apk2.sha256, { version: '0.1.8', tag: 'v0.8.2' }), body: apk2.body }
    expect((await callApi(service, `/api/mobile-update/android/apk?sha256=${apk2.sha256}`)).status).toBe(200)
    expect(fs.existsSync(path.join(cacheDir, `${apk2.sha256}.apk`))).toBe(true)
    expect(fs.existsSync(path.join(cacheDir, `${apk1.sha256}.apk`))).toBe(false)
  })

  test('resolves proxy precedence: updateProxy.manual > network.proxy.manual > system bridge', () => {
    const prevBridge = process.env.CC_HAHA_SYSTEM_PROXY_URL
    const prevError = process.env.CC_HAHA_SYSTEM_PROXY_ERROR
    try {
      process.env.CC_HAHA_SYSTEM_PROXY_URL = 'http://127.0.0.1:19999'
      delete process.env.CC_HAHA_SYSTEM_PROXY_ERROR

      const fromUpdateProxy = resolveDesktopUpdateProxyFetchOptions(
        {
          updateProxy: { mode: 'manual', url: 'http://127.0.0.1:7890' },
          network: { proxy: { mode: 'manual', url: 'http://127.0.0.1:8888' } },
        },
        'https://github.com/NanmiCoder/cc-haha/releases/latest',
      )
      expect(fromUpdateProxy.proxy).toBe('http://127.0.0.1:7890')

      const fromNetworkProxy = resolveDesktopUpdateProxyFetchOptions(
        {
          updateProxy: { mode: 'system', url: '' },
          network: { proxy: { mode: 'manual', url: 'http://127.0.0.1:8888' } },
        },
        'https://github.com/NanmiCoder/cc-haha/releases/latest',
      )
      expect(fromNetworkProxy.proxy).toBe('http://127.0.0.1:8888')

      // Even when network.proxy is direct for domestic AI models, GitHub updates fall back to system bridge.
      const fromSystemBridge = resolveDesktopUpdateProxyFetchOptions(
        {
          network: { proxy: { mode: 'direct', url: '' } },
        },
        'https://github.com/NanmiCoder/cc-haha/releases/latest',
      )
      expect(fromSystemBridge.proxy).toBe('http://127.0.0.1:19999')

      // System bridge error surfaces clean PROXY_UNAVAILABLE without leaking internals.
      delete process.env.CC_HAHA_SYSTEM_PROXY_URL
      process.env.CC_HAHA_SYSTEM_PROXY_ERROR = 'secret-proxy-token-leak'
      expect(() =>
        resolveDesktopUpdateProxyFetchOptions({}, 'https://github.com/NanmiCoder/cc-haha/releases/latest'),
      ).toThrow('Desktop proxy is unavailable')
    } finally {
      if (prevBridge === undefined) delete process.env.CC_HAHA_SYSTEM_PROXY_URL
      else process.env.CC_HAHA_SYSTEM_PROXY_URL = prevBridge
      if (prevError === undefined) delete process.env.CC_HAHA_SYSTEM_PROXY_ERROR
      else process.env.CC_HAHA_SYSTEM_PROXY_ERROR = prevError
    }
  })

  test('prepare endpoint decouples slow upstream pulls from /apk headers and reports live progress until ready', async () => {
    const apk = makeFakeApk('slow-prepare-')
    const manifest = makeManifest(apk.sha256)
    let releaseSecondChunk!: () => void
    const secondChunkGate = new Promise<void>(resolve => {
      releaseSecondChunk = resolve
    })
    let apkHits = 0

    // Use node:http so an explicit Content-Length header stays intact on a streaming response.
    const rawServer = http.createServer((req, res) => {
      if (req.url === '/manifest') {
        const body = JSON.stringify(manifest)
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) })
        res.end(body)
        return
      }
      if (req.url === '/apk') {
        apkHits++
        const mid = Math.floor(apk.body.length / 2)
        res.writeHead(200, { 'Content-Length': String(apk.body.length) })
        res.write(apk.body.subarray(0, mid))
        void secondChunkGate.then(() => {
          if (!res.destroyed) {
            res.end(apk.body.subarray(mid))
          }
        })
        return
      }
      res.writeHead(404)
      res.end('not found')
    })
    await new Promise<void>(resolve => rawServer.listen(0, '127.0.0.1', resolve))
    servers.push({
      stop() {
        rawServer.closeAllConnections?.()
        rawServer.close()
      },
    })
    const addr = rawServer.address()
    if (!addr || typeof addr === 'string') throw new Error('expected TCP port')
    const origin = `http://127.0.0.1:${addr.port}`

    const service = new MobileUpdateService({
      cacheDir: makeTempDir(),
      manifestUrl: `${origin}/manifest`,
      apkUrlBuilder: () => `${origin}/apk`,
      isAllowedRedirectUrl: (url) => url.origin === origin,
      resolveProxyOptions: async () => ({}),
    })

    // POST /prepare starts background pull and returns immediately without waiting for upstream EOF.
    const startRes = await callApi(service, `/api/mobile-update/android/prepare?sha256=${apk.sha256}`, {
      method: 'POST',
    })
    expect(startRes.status).toBe(200)
    expect(startRes.headers.get(MOBILE_UPDATE_HEADER)).toBe('1')
    const startBody = await startRes.json() as { status: string; sha256: string }
    expect(startBody.status).toBe('preparing')
    expect(startBody.sha256).toBe(apk.sha256)

    // Poll until first chunk is recorded with exact totalBytes from Content-Length.
    let poll1Body: { status: string; downloadedBytes: number; totalBytes: number | null } = {
      status: 'preparing',
      downloadedBytes: 0,
      totalBytes: null,
    }
    for (let i = 0; i < 30; i++) {
      await new Promise(resolve => setTimeout(resolve, 20))
      const poll1 = await callApi(service, `/api/mobile-update/android/prepare?sha256=${apk.sha256}`)
      poll1Body = await poll1.json() as { status: string; downloadedBytes: number; totalBytes: number | null }
      if (poll1Body.downloadedBytes > 0) break
    }
    expect(poll1Body.status).toBe('preparing')
    expect(poll1Body.downloadedBytes).toBeGreaterThan(0)
    expect(poll1Body.totalBytes).toBe(apk.body.length)

    // Release rest of stream and wait for ready.
    releaseSecondChunk()
    let readyBody: { status: string; sizeBytes?: number } = { status: 'preparing' }
    for (let i = 0; i < 30; i++) {
      await new Promise(resolve => setTimeout(resolve, 20))
      const poll = await callApi(service, `/api/mobile-update/android/prepare?sha256=${apk.sha256}`)
      readyBody = await poll.json() as { status: string; sizeBytes?: number }
      if (readyBody.status === 'ready') break
    }
    expect(readyBody.status).toBe('ready')
    expect(readyBody.sizeBytes).toBe(apk.body.length)

    // Subsequent /apk serves straight from cache with zero additional upstream fetches.
    const dl = await callApi(service, `/api/mobile-update/android/apk?sha256=${apk.sha256}`)
    expect(dl.status).toBe(200)
    expect(apkHits).toBe(1)
    expect(Buffer.from(await dl.arrayBuffer()).equals(apk.body)).toBe(true)
  })

  test('prepare endpoint surfaces upstream failure on GET and clears it on retry POST', async () => {
    const apk = makeFakeApk('prepare-retry-')
    const manifest = makeManifest(apk.sha256)
    let corruptFirst = true

    const origin = startMockUpstream((_req, url) => {
      if (url.pathname === '/manifest') return Response.json(manifest)
      if (url.pathname === '/apk') {
        if (corruptFirst) {
          corruptFirst = false
          return new Response(Buffer.concat([Buffer.from([0x50, 0x4b]), Buffer.from('corrupt')]))
        }
        return new Response(apk.body, { status: 200, headers: { 'Content-Length': String(apk.body.length) } })
      }
      return new Response('not found', { status: 404 })
    })

    const service = new MobileUpdateService({
      cacheDir: makeTempDir(),
      manifestUrl: `${origin}/manifest`,
      apkUrlBuilder: () => `${origin}/apk`,
      isAllowedRedirectUrl: (url) => url.origin === origin,
      resolveProxyOptions: async () => ({}),
    })

    const start1 = await callApi(service, `/api/mobile-update/android/prepare?sha256=${apk.sha256}`, { method: 'POST' })
    expect(start1.status).toBe(200)

    let failedBody: { status: string; code?: string } = { status: 'preparing' }
    for (let i = 0; i < 30; i++) {
      await new Promise(resolve => setTimeout(resolve, 20))
      const poll = await callApi(service, `/api/mobile-update/android/prepare?sha256=${apk.sha256}`)
      failedBody = await poll.json() as { status: string; code?: string }
      if (failedBody.status === 'failed') break
    }
    expect(failedBody.status).toBe('failed')
    expect(failedBody.code).toBe('UPSTREAM_SHA256_MISMATCH')

    // Retry POST clears previous failure and succeeds.
    const start2 = await callApi(service, `/api/mobile-update/android/prepare?sha256=${apk.sha256}`, { method: 'POST' })
    expect(start2.status).toBe(200)
    let readyBody: { status: string; sizeBytes?: number } = { status: 'preparing' }
    for (let i = 0; i < 30; i++) {
      await new Promise(resolve => setTimeout(resolve, 20))
      const poll = await callApi(service, `/api/mobile-update/android/prepare?sha256=${apk.sha256}`)
      readyBody = await poll.json() as { status: string; sizeBytes?: number }
      if (readyBody.status === 'ready') break
    }
    expect(readyBody.status).toBe('ready')
    expect(readyBody.sizeBytes).toBe(apk.body.length)
  })

  test('immediate retry after waiter abort starts a fresh upstream flight instead of attaching to an aborted one', async () => {
    const apk = makeFakeApk('abort-race-')
    const manifest = makeManifest(apk.sha256)
    let apkHits = 0
    let firstStarted!: () => void
    const firstStartedPromise = new Promise<void>(resolve => {
      firstStarted = resolve
    })

    const origin = startMockUpstream((req, url) => {
      if (url.pathname === '/manifest') return Response.json(manifest)
      if (url.pathname === '/apk') {
        apkHits++
        if (apkHits === 1) {
          firstStarted()
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              req.signal.addEventListener('abort', () => {
                try { controller.close() } catch {}
              })
            },
          })
          return new Response(stream, { status: 200, headers: { 'Content-Length': String(apk.body.length) } })
        }
        return new Response(apk.body, { status: 200, headers: { 'Content-Length': String(apk.body.length) } })
      }
      return new Response('not found', { status: 404 })
    })

    const service = new MobileUpdateService({
      cacheDir: makeTempDir(),
      manifestUrl: `${origin}/manifest`,
      apkUrlBuilder: () => `${origin}/apk`,
      isAllowedRedirectUrl: (url) => url.origin === origin,
      resolveProxyOptions: async () => ({}),
    })

    const abort1 = new AbortController()
    const firstPromise = service.ensureApkFile({ expectedSha256: apk.sha256, signal: abort1.signal }).catch(() => 'aborted')
    await firstStartedPromise

    // Abort caller 1 and IMMEDIATELY issue caller 2 in the same tick before async cleanup settles.
    abort1.abort(new Error('caller_cancelled'))
    const second = await service.ensureApkFile({ expectedSha256: apk.sha256 })
    expect(await firstPromise).toBe('aborted')
    expect(second.sizeBytes).toBe(apk.body.length)
    expect(apkHits).toBe(2)
  })
})
