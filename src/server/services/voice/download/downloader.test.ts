import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VoiceDownloadError, downloadAsset, partPathFor, type DownloadProgress } from './index.js'
import { writeFully } from './downloader.js'
import { assetFor, bypassProxyForLoopback, makeContent, startFixture, type Fixture } from './httpFixture.testUtil.js'

const content = makeContent(300_000)
const noSleep = async () => {}

let dir: string
let fixtures: Fixture[]
let restoreProxyEnv: () => void

beforeAll(() => { restoreProxyEnv = bypassProxyForLoopback() })
afterAll(() => { restoreProxyEnv() })

async function serve(behavior = {}, body = content): Promise<Fixture> {
  const fixture = await startFixture(body, behavior)
  fixtures.push(fixture)
  return fixture
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false)
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'voice-download-'))
  fixtures = []
})

afterEach(async () => {
  await Promise.all(fixtures.map(fixture => fixture.close()))
  await rm(dir, { recursive: true, force: true })
})

describe('downloadAsset', () => {
  it('downloads a pinned file, verifies it and reports progress up to the total', async () => {
    const server = await serve()
    const destination = join(dir, 'out', 'file.bin')
    const events: DownloadProgress[] = []

    const result = await downloadAsset(assetFor(content, [`${server.origin}/file`]), destination, {
      onProgress: event => events.push(event),
      progressIntervalMs: 0,
    })

    expect(Buffer.compare(await readFile(destination), content)).toBe(0)
    expect(await exists(partPathFor(destination))).toBe(false)
    expect(result).toEqual({ source: server.origin })
    expect(events.at(-1)).toEqual({ completedBytes: content.length, totalBytes: content.length, source: server.origin })
    const completed = events.map(event => event.completedBytes)
    expect([...completed].sort((a, b) => a - b)).toEqual(completed)
    expect(server.gets()[0]?.range).toBeUndefined()
  })

  it('throttles progress callbacks to the configured interval', async () => {
    const server = await serve({ chunkDelayMs: 1 })
    const events: DownloadProgress[] = []
    await downloadAsset(assetFor(content, [`${server.origin}/file`]), join(dir, 'file.bin'), {
      onProgress: event => events.push(event),
      progressIntervalMs: 60_000,
    })
    // First event on connect, final event on completion; nothing in between.
    expect(events.map(event => event.completedBytes)).toEqual([0, content.length])
  })

  it('resumes with a Range request after the connection drops mid-download', async () => {
    const server = await serve({ breakAfter: 100_000, breakRequests: 1, chunkDelayMs: 2 })
    const destination = join(dir, 'file.bin')
    const events: DownloadProgress[] = []
    const sleeps: number[] = []

    const result = await downloadAsset(assetFor(content, [`${server.origin}/file`]), destination, {
      onProgress: event => events.push(event),
      progressIntervalMs: 0,
      sleep: async ms => { sleeps.push(ms) },
    })

    expect(Buffer.compare(await readFile(destination), content)).toBe(0)
    const gets = server.gets()
    expect(gets).toHaveLength(2)
    expect(gets[0]?.range).toBeUndefined()
    const resumeOffset = Number(/^bytes=(\d+)-$/.exec(gets[1]?.range ?? '')?.[1])
    expect(resumeOffset).toBeGreaterThan(0)
    expect(resumeOffset).toBeLessThan(content.length)
    expect(result.resumedFromBytes).toBe(resumeOffset)
    expect(events.at(-1)?.resumedFromBytes).toBe(resumeOffset)
    expect(sleeps).toHaveLength(1)
  })

  it('drops the last chunk of an interrupted transfer so stray trailing bytes never enter the resumed prefix', async () => {
    const server = await serve()
    const destination = join(dir, 'file.bin')
    let calls = 0
    const flaky = (input: string, init?: RequestInit & Record<string, unknown>): Promise<Response> => {
      if (calls++ > 0) return fetch(input, init as RequestInit)
      // Real bytes, then a small junk chunk, then a reset: the shape of the Bun client glitch.
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(content.subarray(0, 50_000))
          controller.enqueue(new TextEncoder().encode('Connection: close\r\n\r\n'))
        },
        pull(controller) { controller.error(new Error('The socket connection was closed unexpectedly')) },
      })
      return Promise.resolve(new Response(body, { status: 200, headers: { 'content-length': String(content.length) } }))
    }

    const result = await downloadAsset(assetFor(content, [`${server.origin}/file`]), destination, { fetch: flaky, sleep: noSleep })

    expect(Buffer.compare(await readFile(destination), content)).toBe(0)
    expect(server.gets()).toHaveLength(1)
    expect(server.gets()[0]?.range).toBe('bytes=50000-')
    expect(result.resumedFromBytes).toBe(50_000)
  })

  it('backs off exponentially between retries', async () => {
    const server = await serve({ breakAfter: 20_000, breakRequests: 3 })
    const sleeps: number[] = []
    await downloadAsset(assetFor(content, [`${server.origin}/file`]), join(dir, 'file.bin'), {
      backoffMs: 100,
      sleep: async ms => { sleeps.push(ms) },
    })
    expect(sleeps).toEqual([100, 200, 400])
  })

  it('resumes from a .part left by an earlier run, feeding the prefix into the digest', async () => {
    const server = await serve()
    const destination = join(dir, 'file.bin')
    await writeFile(partPathFor(destination), content.subarray(0, 123_456))

    const result = await downloadAsset(assetFor(content, [`${server.origin}/file`]), destination)

    expect(Buffer.compare(await readFile(destination), content)).toBe(0)
    expect(server.gets()).toHaveLength(1)
    expect(server.gets()[0]?.range).toBe('bytes=123456-')
    expect(result.resumedFromBytes).toBe(123_456)
  })

  it('restarts from zero when the server ignores Range and answers 200', async () => {
    const server = await serve({ ignoreRange: true })
    const destination = join(dir, 'file.bin')
    await writeFile(partPathFor(destination), content.subarray(0, 50_000))

    const result = await downloadAsset(assetFor(content, [`${server.origin}/file`]), destination)

    expect(Buffer.compare(await readFile(destination), content)).toBe(0)
    expect(server.gets()).toHaveLength(1)
    expect(result.resumedFromBytes).toBeUndefined()
  })

  it('discards the .part and starts over on 416', async () => {
    const server = await serve({ rangeNotSatisfiable: true })
    const destination = join(dir, 'file.bin')
    await writeFile(partPathFor(destination), content.subarray(0, 50_000))

    await downloadAsset(assetFor(content, [`${server.origin}/file`]), destination)

    expect(Buffer.compare(await readFile(destination), content)).toBe(0)
    expect(server.gets().map(request => request.range)).toEqual(['bytes=50000-', undefined])
  })

  it('drops a corrupt resumed prefix and refetches from zero', async () => {
    const server = await serve()
    const destination = join(dir, 'file.bin')
    await writeFile(partPathFor(destination), Buffer.alloc(40_000, 1))

    await downloadAsset(assetFor(content, [`${server.origin}/file`]), destination)

    expect(Buffer.compare(await readFile(destination), content)).toBe(0)
    expect(server.gets().map(request => request.range)).toEqual(['bytes=40000-', undefined])
  })

  it('deletes the .part and fails with integrity when a fresh download does not match', async () => {
    const tampered = Buffer.from(content)
    tampered[1000] ^= 0xff
    const server = await serve({}, tampered)
    const destination = join(dir, 'file.bin')

    const error = await downloadAsset(assetFor(content, [`${server.origin}/file`]), destination).catch(e => e)

    expect(error).toBeInstanceOf(VoiceDownloadError)
    expect(error.failure.reason).toBe('integrity')
    expect(await exists(partPathFor(destination))).toBe(false)
    expect(await exists(destination)).toBe(false)
  })

  it('verifies a complete .part without touching the network', async () => {
    const server = await serve()
    const destination = join(dir, 'file.bin')
    await writeFile(partPathFor(destination), content)

    await downloadAsset(assetFor(content, [`${server.origin}/file`]), destination)

    expect(Buffer.compare(await readFile(destination), content)).toBe(0)
    expect(server.gets()).toHaveLength(0)
  })

  it('keeps the .part when cancelled and continues from it next time', async () => {
    const server = await serve({ chunkDelayMs: 3 })
    const destination = join(dir, 'file.bin')
    const asset = assetFor(content, [`${server.origin}/file`])
    const controller = new AbortController()

    const cancelled = await downloadAsset(asset, destination, {
      signal: controller.signal,
      progressIntervalMs: 0,
      onProgress: event => { if (event.completedBytes >= 100_000) controller.abort() },
    }).catch(error => error)

    expect(controller.signal.aborted).toBe(true)
    expect(cancelled).not.toBeInstanceOf(VoiceDownloadError)
    const kept = (await stat(partPathFor(destination))).size
    expect(kept).toBeGreaterThanOrEqual(100_000)
    expect(await exists(destination)).toBe(false)

    const result = await downloadAsset(asset, destination)
    expect(Buffer.compare(await readFile(destination), content)).toBe(0)
    expect(result.resumedFromBytes).toBe(kept)
    expect(server.gets().at(-1)?.range).toBe(`bytes=${kept}-`)
  })

  it('gives up on a source after the retry budget and reports a network failure', async () => {
    const server = await serve({ breakAfter: 40_000, chunkDelayMs: 2 })
    const destination = join(dir, 'file.bin')

    const error = await downloadAsset(assetFor(content, [`${server.origin}/file`]), destination, {
      maxRetries: 2,
      sleep: noSleep,
    }).catch(e => e)

    expect(error).toBeInstanceOf(VoiceDownloadError)
    expect(error.failure.reason).toBe('network')
    expect(error.failure.source).toBe(server.origin)
    expect(server.gets()).toHaveLength(3)
    // Progress is kept for the next prepare.
    expect((await stat(partPathFor(destination))).size).toBeGreaterThan(0)
  })

  it('falls back to the next source only after retries on the first are exhausted', async () => {
    const flaky = await serve({ breakAfter: 10_000 })
    const good = await serve()
    const destination = join(dir, 'file.bin')

    const result = await downloadAsset(
      assetFor(content, [`${flaky.origin}/file`, `${good.origin}/file`]),
      destination,
      { maxRetries: 1, sleep: noSleep, probeTimeoutMs: 1000 },
    )

    expect(result.source).toBe(good.origin)
    expect(Buffer.compare(await readFile(destination), content)).toBe(0)
    expect(flaky.gets()).toHaveLength(2)
    expect(good.gets().length).toBeGreaterThanOrEqual(1)
  })

  it('falls back on HTTP errors immediately', async () => {
    const broken = await serve({ status: 503 })
    const good = await serve()
    const result = await downloadAsset(
      assetFor(content, [`${broken.origin}/file`, `${good.origin}/file`]),
      join(dir, 'file.bin'),
      { sleep: noSleep },
    )
    expect(result.source).toBe(good.origin)
    expect(broken.gets()).toHaveLength(1)
  })

  it('reports the HTTP status when every source fails', async () => {
    const broken = await serve({ status: 404 })
    const error = await downloadAsset(assetFor(content, [`${broken.origin}/file`]), join(dir, 'file.bin'), {
      sleep: noSleep,
    }).catch(e => e)
    expect(error.failure).toMatchObject({ reason: 'http', status: 404, source: broken.origin })
  })

  it('tries the fastest mirror first according to a HEAD probe', async () => {
    const slow = await serve({ headDelayMs: 500 })
    const fast = await serve()
    const result = await downloadAsset(
      assetFor(content, [`${slow.origin}/file`, `${fast.origin}/file`]),
      join(dir, 'file.bin'),
      { probeTimeoutMs: 3000 },
    )
    expect(result.source).toBe(fast.origin)
    expect(slow.gets()).toHaveLength(0)
  })

  it('does not switch source on a storage failure', async () => {
    const first = await serve()
    const second = await serve()
    const blocker = join(dir, 'blocker')
    await writeFile(blocker, 'a file where a directory is needed')

    const error = await downloadAsset(
      assetFor(content, [`${first.origin}/file`, `${second.origin}/file`]),
      join(blocker, 'nested', 'file.bin'),
    ).catch(e => e)

    expect(error.failure.reason).toBe('storage')
    expect(first.gets()).toHaveLength(0)
    expect(second.gets()).toHaveLength(0)
  })

  it('classifies a stalled transfer as a timeout and keeps what arrived', async () => {
    const destination = join(dir, 'file.bin')
    const idleTimeoutMs = 150
    const prefixBytes = 40_000
    const progress: number[] = []
    const nativeSetTimeout = globalThis.setTimeout
    const nativeClearTimeout = globalThis.clearTimeout
    const idleTimers = new Map<ReturnType<typeof setTimeout>, () => void>()
    const controlledTimers = new Set<ReturnType<typeof setTimeout>>()
    let sequence = 0
    const timerSpy = spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
      if (delay !== idleTimeoutMs) return nativeSetTimeout(callback, delay, ...args)
      const timer = ++sequence as unknown as ReturnType<typeof setTimeout>
      controlledTimers.add(timer)
      idleTimers.set(timer, () => callback(...args))
      return timer
    })
    const clearSpy = spyOn(globalThis, 'clearTimeout').mockImplementation(timer => {
      if (controlledTimers.has(timer as ReturnType<typeof setTimeout>)) idleTimers.delete(timer as ReturnType<typeof setTimeout>)
      else nativeClearTimeout(timer)
    })

    try {
      const error = await downloadAsset(assetFor(content, ['http://stalled.test/file']), destination, {
        idleTimeoutMs,
        maxRetries: 0,
        progressIntervalMs: 0,
        fetch: async (_input, init) => {
          const signal = init!.signal!
          // HTTP may coalesce the old fixture's writes into one reader chunk.
          // Since interruptions deliberately discard the last chunk, require
          // two distinct chunks before testing that the earlier prefix survives.
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(content.subarray(0, prefixBytes))
              controller.enqueue(content.subarray(prefixBytes, prefixBytes * 2))
              signal.addEventListener('abort', () => controller.error(signal.reason), { once: true })
            },
          })
          return new Response(body, { status: 200, headers: { 'content-length': String(content.length) } })
        },
        onProgress: event => {
          progress.push(event.completedBytes)
          if (event.completedBytes !== prefixBytes * 2) return
          // Progress follows writeFully: expire the real idle callback only
          // once both writes finished, without racing CI scheduling or disk I/O.
          expect(idleTimers.size).toBe(1)
          const [timer, expire] = idleTimers.entries().next().value!
          idleTimers.delete(timer)
          expire()
        },
      }).catch(e => e)

      expect(error).toBeInstanceOf(VoiceDownloadError)
      expect(error.failure.reason).toBe('timeout')
      expect(progress).toEqual([0, prefixBytes, prefixBytes * 2])
      expect((await stat(partPathFor(destination))).size).toBeGreaterThan(0)
      expect(Buffer.compare(await readFile(partPathFor(destination)), content.subarray(0, prefixBytes))).toBe(0)
      expect(await exists(destination)).toBe(false)
    } finally {
      timerSpy.mockRestore()
      clearSpy.mockRestore()
    }
  })

  it('classifies certificate and DNS failures and never leaks URL credentials', async () => {
    const asset = assetFor(content, ['https://user:secret@files.example.test/a/file.bin?token=abc'])
    const failWith = (message: string, code?: string) => async () => {
      throw Object.assign(new Error(message), code ? { code } : {})
    }

    const cert = await downloadAsset(asset, join(dir, 'a.bin'), {
      fetch: failWith('unable to verify the first certificate', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'),
    }).catch(e => e)
    expect(cert.failure.reason).toBe('certificate')

    const dns = await downloadAsset(asset, join(dir, 'b.bin'), {
      fetch: failWith('getaddrinfo ENOTFOUND files.example.test https://user:secret@files.example.test/a?token=abc', 'ENOTFOUND'),
    }).catch(e => e)
    expect(dns.failure.reason).toBe('dns')
    for (const error of [cert, dns]) {
      const serialized = JSON.stringify(error.failure)
      expect(serialized).not.toContain('secret')
      expect(serialized).not.toContain('token=abc')
      expect(error.failure.source).toBe('https://files.example.test')
    }
  })

  it('creates the destination directory and applies fetch options such as a proxy', async () => {
    const server = await serve()
    const seen: unknown[] = []
    await downloadAsset(assetFor(content, [`${server.origin}/file`]), join(dir, 'a', 'b', 'file.bin'), {
      fetchOptions: () => ({ proxy: 'http://proxy.invalid:1' }),
      fetch: async (input, init) => {
        seen.push((init as { proxy?: string }).proxy)
        const { proxy: _proxy, ...rest } = init as Record<string, unknown>
        return fetch(input, rest as RequestInit)
      },
    })
    expect(seen).toEqual(['http://proxy.invalid:1'])
    await mkdir(join(dir, 'a', 'b'), { recursive: true })
  })
})

describe('writeFully', () => {
  it('keeps writing until a handle that accepts only part of each call has taken every byte', async () => {
    const stored: number[] = []
    const handle = {
      async write(buffer: Uint8Array, offset: number, length: number) {
        const accepted = Math.min(3, length)
        stored.push(...buffer.subarray(offset, offset + accepted))
        return { bytesWritten: accepted }
      },
    }

    await writeFully(handle, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]))

    expect(stored).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('fails instead of looping when the file system makes no progress', async () => {
    const handle = { write: async () => ({ bytesWritten: 0 }) }

    await expect(writeFully(handle, Uint8Array.from([1, 2, 3]))).rejects.toThrow('Short write')
  })
})
