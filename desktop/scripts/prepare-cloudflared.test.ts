// @vitest-environment node
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { inspect } from 'node:util'
import {
  CLOUDFLARED_LICENSE_FILES,
  CLOUDFLARED_VERSION,
  assertPreparedCloudflared,
  getBundledCloudflaredName,
  getCloudflaredAsset,
  getCloudflaredDownloadUrl,
  prepareCloudflared,
  stageCloudflaredLicenses,
} from './prepare-cloudflared'

const temporaryDirectories: string[] = []
const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.clearAllTimers()
  vi.useRealTimers()
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function fixture(targetTriple = 'x86_64-unknown-linux-gnu') {
  const desktopRoot = await mkdtemp(path.join(tmpdir(), 'prepare-cloudflared-test-'))
  temporaryDirectories.push(desktopRoot)
  const bytes = Buffer.from('an isolated fake executable for the fixture')
  const asset = { ...getCloudflaredAsset(targetTriple), sha256: sha256(bytes) }
  const options = { desktopRoot, targetTriple }
  const download = vi.fn(async () => bytes)
  return { bytes, asset, options, download, desktopRoot }
}

function observe<T>(promise: Promise<T>) {
  return promise.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))
}

function isolatePreparationTemporaryDirectory(directory: string) {
  for (const variable of ['TMPDIR', 'TEMP', 'TMP']) vi.stubEnv(variable, directory)
}

function pacedResponse(bytes: Uint8Array, signal?: AbortSignal | null, parts = 5): Response {
  let timer: ReturnType<typeof setInterval> | undefined
  let onAbort: (() => void) | undefined
  let finished = false
  const cleanup = () => {
    if (timer) clearInterval(timer)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
    finished = true
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let offset = 0
      const chunkSize = Math.ceil(bytes.byteLength / parts)
      onAbort = () => {
        if (finished) return
        cleanup()
        controller.error(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) {
        onAbort()
        return
      }
      timer = setInterval(() => {
        const end = Math.min(offset + chunkSize, bytes.byteLength)
        controller.enqueue(bytes.subarray(offset, end))
        offset = end
        if (offset === bytes.byteLength) {
          cleanup()
          controller.close()
        }
      }, 30_000)
    },
    cancel() { cleanup() },
  })
  return new Response(body, { headers: { 'Content-Length': String(bytes.byteLength) } })
}

describe('build-time release downloads', () => {
  it('recovers from a transient timeout through the default downloader', async () => {
    const f = await fixture()
    vi.useFakeTimers()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new DOMException('The operation timed out.', 'TimeoutError'))
      .mockResolvedValue(new Response(f.bytes))
    const outcome = observe(prepareCloudflared(f.options, { asset: f.asset }))

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled())
    await vi.advanceTimersByTimeAsync(10_000)
    const result = await outcome

    expect(result.error).toBeUndefined()
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(await readFile(result.value!)).toEqual(f.bytes)
  })

  it('finishes a slow download that continues making progress beyond two minutes', async () => {
    const f = await fixture()
    vi.useFakeTimers()
    // Native AbortSignal.timeout does not use Vitest's clock. Preserve its
    // cancellation behavior here so the former two-minute deadline fails.
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')), milliseconds)
      return controller.signal
    })
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockImplementation(async (_input, init) => pacedResponse(f.bytes, init?.signal))
    const outcome = observe(prepareCloudflared(f.options, { asset: f.asset }))

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled())
    await vi.advanceTimersByTimeAsync(151_000)
    const result = await outcome

    expect(result.error).toBeUndefined()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(await readFile(result.value!)).toEqual(f.bytes)
  })

  it('retries an interrupted response body before staging a verified executable', async () => {
    const f = await fixture()
    vi.useFakeTimers()
    const failedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(f.bytes.subarray(0, 5))
        setTimeout(() => controller.error(new TypeError('Connection reset while downloading')), 100)
      },
    })
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(failedBody))
      .mockResolvedValue(new Response(f.bytes))
    const outcome = observe(prepareCloudflared(f.options, { asset: f.asset }))

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled())
    await vi.advanceTimersByTimeAsync(10_000)
    const result = await outcome

    expect(result.error).toBeUndefined()
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(await readFile(result.value!)).toEqual(f.bytes)
    expect(await assertPreparedCloudflared(f.options, f.asset)).toBe(result.value)
  })

  it.each(['headers', 'body'] as const)('cancels stalled %s and retries with a fresh request', async phase => {
    const f = await fixture()
    vi.useFakeTimers()
    const signals: AbortSignal[] = []
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const signal = init!.signal!
      signals.push(signal)
      if (signals.length > 1) return new Response(f.bytes)
      if (phase === 'headers') {
        return await new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(f.bytes.subarray(0, 5))
          signal.addEventListener('abort', () => controller.error(signal.reason), { once: true })
        },
      }))
    })
    const outcome = observe(prepareCloudflared(f.options, { asset: f.asset }))

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled())
    await vi.advanceTimersByTimeAsync(90_000)
    const attemptsAfterStall = fetchSpy.mock.calls.length
    // Let a broken idle cutoff settle through its overall bound as well, so
    // failure reports the missed stall cancellation instead of a test timeout.
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    const result = await outcome

    expect(attemptsAfterStall).toBe(2)
    expect(signals[0].aborted).toBe(true)
    expect(signals[1]).not.toBe(signals[0])
    expect(result.error).toBeUndefined()
    expect(await readFile(result.value!)).toEqual(f.bytes)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds a transfer that keeps making progress without finishing', async () => {
    const f = await fixture()
    vi.useFakeTimers()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockImplementation(async (_input, init) => pacedResponse(f.bytes, init?.signal, 100))
    const outcome = observe(prepareCloudflared(f.options, { asset: f.asset }))

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled())
    await vi.advanceTimersByTimeAsync(31 * 60_000)
    const result = await outcome

    expect(result.error).toBeInstanceOf(Error)
    expect(String(result.error)).toMatch(/timed out|timeout/i)
    expect(fetchSpy).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([408, 429, 503])('recovers after an HTTP %s response', async status => {
    const f = await fixture()
    vi.useFakeTimers()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('temporary upstream failure', { status }))
      .mockResolvedValue(new Response(f.bytes))
    const outcome = observe(prepareCloudflared(f.options, { asset: f.asset }))

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled())
    await vi.advanceTimersByTimeAsync(10_000)
    const result = await outcome

    expect(result.error).toBeUndefined()
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(await readFile(result.value!)).toEqual(f.bytes)
  })

  it('bounds repeated timeouts and reports safe recovery context without proxy credentials', async () => {
    const f = await fixture()
    isolatePreparationTemporaryDirectory(f.desktopRoot)
    vi.stubEnv('HTTPS_PROXY', 'http://build-user:build-secret@proxy.invalid:8080')
    vi.useFakeTimers()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException(
      'The operation timed out through http://build-user:build-secret@proxy.invalid:8080; upstream-secret',
      'TimeoutError',
    ))
    const outcome = observe(prepareCloudflared(f.options, { asset: f.asset }))

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled())
    await vi.advanceTimersByTimeAsync(10_000)
    const result = await outcome

    expect(fetchSpy).toHaveBeenCalledTimes(3)
    expect(result.error).toBeInstanceOf(Error)
    expect(String(result.error)).toContain(getCloudflaredDownloadUrl(f.options.targetTriple))
    expect(String(result.error)).toContain('HTTPS_PROXY')
    expect(String(result.error)).toContain('CC_HAHA_CLOUDFLARED_ARCHIVE')
    const diagnostics = [inspect(result.error), ...log.mock.calls.flat(), ...warn.mock.calls.flat()].join('\n')
    for (const secret of ['build-user', 'build-secret', 'proxy.invalid', 'upstream-secret']) {
      expect(diagnostics).not.toContain(secret)
    }
    expect(await readdir(f.desktopRoot)).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('fails a missing release immediately and cleans temporary downloads', async () => {
    const f = await fixture()
    isolatePreparationTemporaryDirectory(f.desktopRoot)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not found', { status: 404 }))

    await expect(prepareCloudflared(f.options, { asset: f.asset })).rejects.toThrow('404')

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(await readdir(f.desktopRoot)).toEqual([])
  })

  it('does not retry downloaded bytes that fail the pinned checksum', async () => {
    const f = await fixture()
    isolatePreparationTemporaryDirectory(f.desktopRoot)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('unverified bytes'))

    await expect(prepareCloudflared(f.options, { asset: f.asset })).rejects.toThrow('SHA256 mismatch')

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(await readdir(f.desktopRoot)).toEqual([])
  })

  it('keeps a verified cache usable when the default network transport is unavailable', async () => {
    const f = await fixture()
    const binary = await prepareCloudflared(f.options, { asset: f.asset, download: f.download })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('public network forbidden'))

    expect(await prepareCloudflared(f.options, { asset: f.asset })).toBe(binary)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(await readFile(binary)).toEqual(f.bytes)
  })

  it('prepares a checksummed local archive without invoking the default downloader', async () => {
    const f = await fixture()
    const archivePath = path.join(f.desktopRoot, 'local-release')
    await writeFile(archivePath, f.bytes)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('public network forbidden'))

    const binary = await prepareCloudflared({ ...f.options, archivePath }, { asset: f.asset })

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(await readFile(binary)).toEqual(f.bytes)
    expect(await assertPreparedCloudflared(f.options, f.asset)).toBe(binary)
  })
})

describe('pinned Cloudflare release assets', () => {
  it.each([
    'aarch64-apple-darwin', 'x86_64-apple-darwin',
    'aarch64-unknown-linux-gnu', 'x86_64-unknown-linux-gnu',
    'x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc',
  ])('maps %s to an official checksummed asset and the runtime filename', target => {
    const asset = getCloudflaredAsset(target)
    expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(getCloudflaredDownloadUrl(target)).toBe(`https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${asset.name}`)
    expect(getBundledCloudflaredName(target)).toBe(`cloudflared-${target}${target.includes('windows') ? '.exe' : ''}`)
  })

  it('records x64 emulation for Windows ARM64 rather than inventing an upstream asset', () => {
    expect(getCloudflaredAsset('aarch64-pc-windows-msvc')).toEqual({
      ...getCloudflaredAsset('x86_64-pc-windows-msvc'), compatibility: 'windows-x64-emulation',
    })
    expect(getCloudflaredDownloadUrl('aarch64-pc-windows-msvc')).toContain('cloudflared-windows-amd64.exe')
  })

  it.each(['armv7-unknown-linux-gnu', '../../outside-workspace'])('rejects unsupported or unsafe target names: %s', target => {
    expect(() => getCloudflaredAsset(target)).toThrow('Unsupported target triple')
    expect(() => getBundledCloudflaredName(target)).toThrow('Unsupported target triple')
  })

  it('stages the complete upstream license and distribution notice', async () => {
    const f = await fixture()
    const directory = await stageCloudflaredLicenses(f.desktopRoot)
    for (const file of CLOUDFLARED_LICENSE_FILES) expect((await readFile(path.join(directory, file), 'utf8')).length).toBeGreaterThan(100)
    expect(await readFile(path.join(directory, 'LICENSE'), 'utf8')).toContain('Apache License')
    expect(await readFile(path.join(directory, 'NOTICE'), 'utf8')).toContain(CLOUDFLARED_VERSION)
  })
})

describe('verified connector preparation', () => {
  it('stages verified bytes, executable permissions, provenance, and an offline-checkable cache', async () => {
    const f = await fixture()
    const binary = await prepareCloudflared(f.options, { asset: f.asset, download: f.download })
    expect(await readFile(binary)).toEqual(f.bytes)
    expect(f.download).toHaveBeenCalledExactlyOnceWith(getCloudflaredDownloadUrl(f.options.targetTriple))
    expect(JSON.parse(await readFile(`${binary}.json`, 'utf8'))).toMatchObject({
      version: CLOUDFLARED_VERSION, targetTriple: f.options.targetTriple,
      asset: f.asset.name, assetArchitecture: f.asset.architecture,
      assetSha256: f.asset.sha256, binarySha256: sha256(f.bytes),
    })
    if (process.platform !== 'win32') expect((await stat(binary)).mode & 0o777).toBe(0o755)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('public network forbidden'))
    expect(await assertPreparedCloudflared(f.options, f.asset)).toBe(binary)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('reuses a verified cache without downloading again', async () => {
    const f = await fixture()
    const dependencies = { asset: f.asset, download: f.download }
    const binary = await prepareCloudflared(f.options, dependencies)
    expect(await prepareCloudflared(f.options, dependencies)).toBe(binary)
    expect(f.download).toHaveBeenCalledTimes(1)
  })

  it('requires explicit preparation when its binary is missing or corrupted', async () => {
    const f = await fixture()
    await expect(assertPreparedCloudflared(f.options)).rejects.toThrow('run bun run prepare:cloudflared')
    const binary = await prepareCloudflared(f.options, { asset: f.asset, download: f.download })
    await writeFile(binary, 'tampered binary')
    await expect(assertPreparedCloudflared(f.options, f.asset)).rejects.toThrow('Verified cloudflared')
  })

  it('rejects stale or altered release provenance even when the binary is still present', async () => {
    const f = await fixture()
    const binary = await prepareCloudflared(f.options, { asset: f.asset, download: f.download })
    const manifest = JSON.parse(await readFile(`${binary}.json`, 'utf8'))
    await writeFile(`${binary}.json`, JSON.stringify({ ...manifest, version: 'old-release' }))
    await expect(assertPreparedCloudflared(f.options, f.asset)).rejects.toThrow('Verified cloudflared')
  })

  it.skipIf(process.platform === 'win32')('rejects a cached connector that has lost executable permissions', async () => {
    const f = await fixture()
    const binary = await prepareCloudflared(f.options, { asset: f.asset, download: f.download })
    await chmod(binary, 0o600)
    await expect(assertPreparedCloudflared(f.options, f.asset)).rejects.toThrow('Verified cloudflared')
  })

  it('never replaces a valid executable with a download that fails the pinned checksum', async () => {
    const f = await fixture()
    const binary = await prepareCloudflared(f.options, { asset: f.asset, download: f.download })
    const archivePath = path.join(f.desktopRoot, 'bad-download')
    await writeFile(archivePath, 'not the verified asset')
    await expect(prepareCloudflared({ ...f.options, archivePath }, { asset: f.asset })).rejects.toThrow('SHA256 mismatch')
    expect(await readFile(binary)).toEqual(f.bytes)
  })

  it('extracts macOS archives only after verifying the downloaded archive', async () => {
    const f = await fixture('aarch64-apple-darwin')
    const extract = vi.fn(async (archive: string, destination: string) => {
      expect(await readFile(archive)).toEqual(f.bytes)
      await writeFile(path.join(destination, 'cloudflared'), 'extracted executable')
    })
    const binary = await prepareCloudflared(f.options, { asset: f.asset, download: f.download, extract })
    expect(extract).toHaveBeenCalledTimes(1)
    expect(await readFile(binary, 'utf8')).toBe('extracted executable')
    expect(JSON.parse(await readFile(`${binary}.json`, 'utf8')).binarySha256).toBe(sha256('extracted executable'))
  })

  it('does not extract an unverified archive', async () => {
    const f = await fixture('aarch64-apple-darwin')
    const extract = vi.fn(async () => {})
    await expect(prepareCloudflared(f.options, { asset: { ...f.asset, sha256: '0'.repeat(64) }, download: f.download, extract })).rejects.toThrow('SHA256 mismatch')
    expect(extract).not.toHaveBeenCalled()
  })

  it('rejects a caller-supplied local archive that does not match the official release', async () => {
    const f = await fixture()
    const archivePath = path.join(f.desktopRoot, 'local-cloudflared')
    await writeFile(archivePath, f.bytes)
    await expect(prepareCloudflared({ ...f.options, archivePath })).rejects.toThrow('SHA256 mismatch')
  })
})
