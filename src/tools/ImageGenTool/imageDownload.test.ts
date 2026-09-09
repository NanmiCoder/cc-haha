import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'events'
import type { ClientRequest, IncomingMessage } from 'http'
import type { RequestOptions } from 'https'
import { PassThrough } from 'stream'

import { downloadGeneratedImage } from './imageDownload.js'

type Dependencies = NonNullable<Parameters<typeof downloadGeneratedImage>[2]>
const publicAddress = { address: '93.184.216.34', family: 4 }
const url = 'https://images.example.test/generated.png?signature=fixture'
const freshSignal = () => new AbortController().signal

// Emulate the socket's lookup boundary and a real readable HTTP body. No DNS,
// network, user config, provider account or request credentials are used.
function transportFixture(options: {
  addresses?: { address: string, family: number }[]
  status?: number
  headers?: Record<string, string>
  chunks?: Buffer[]
  stall?: boolean
} = {}) {
  const response = new PassThrough() as unknown as IncomingMessage
  const stream = response as unknown as PassThrough
  response.statusCode = options.status ?? 200
  response.headers = options.headers ?? {}
  const captured: { options?: RequestOptions, connected?: string, calls: number } = { calls: 0 }
  const req = new EventEmitter() as ClientRequest
  req.destroy = ((error?: Error) => {
    if (error) queueMicrotask(() => req.emit('error', error))
    queueMicrotask(() => req.emit('close'))
    return req
  }) as ClientRequest['destroy']
  const dependencies: Dependencies = {
    resolve: (_host, callback) => callback(null, options.addresses ?? [publicAddress]),
    request: (target, requestOptions, callback) => {
      captured.calls++
      captured.options = requestOptions
      req.end = (() => {
        queueMicrotask(() => {
          requestOptions.lookup!(target.hostname, { all: false }, (error, address) => {
            if (error) {
              req.emit('error', error)
              return
            }
            captured.connected = address as string
            if (options.stall) return
            callback(response)
            if (response.destroyed) return
            for (const chunk of options.chunks ?? [Buffer.from('image bytes')]) {
              if (response.destroyed) break
              stream.write(chunk)
            }
            stream.end()
          })
        })
        return req
      }) as ClientRequest['end']
      return req
    },
  }
  return { dependencies, captured, response }
}

describe('provider image URL downloader', () => {
  test('the real HTTPS socket invokes guarded lookup and blocks DNS before connecting', async () => {
    let lookedUp = false
    await expect(downloadGeneratedImage(
      'https://image-download-hermetic.invalid/image.png',
      freshSignal(),
      {
        resolve: (_host, callback) => {
          lookedUp = true
          callback(null, [publicAddress, { address: '127.0.0.1', family: 4 }])
        },
      },
    )).rejects.toThrow('non-public')
    expect(lookedUp).toBe(true)
  })

  test('pins the validated address, streams bytes and sends no credentials or global agent', async () => {
    const fixture = transportFixture({ chunks: [Buffer.from('PNG'), Buffer.from(' bytes')] })
    const bytes = await downloadGeneratedImage(url, freshSignal(), fixture.dependencies)
    expect(bytes.toString()).toBe('PNG bytes')
    expect(fixture.captured.connected).toBe(publicAddress.address)
    expect(fixture.captured.options).toMatchObject({
      method: 'GET', agent: false, headers: { Accept: 'image/*' },
    })
    expect(Object.keys(fixture.captured.options!.headers!)).toEqual(['Accept'])
    expect(fixture.captured.options!.auth).toBeUndefined()
  })

  test.each([
    'http://images.example.test/image.png',
    'file:///tmp/image.png',
    'https://key:secret@images.example.test/image.png',
    'https://127.0.0.1/image.png',
    'https://2130706433/image.png',
    'https://169.254.169.254/image.png',
    'https://[::1]/image.png',
    'https://[::ffff:127.0.0.1]/image.png',
    'https://[fc00::1]/image.png',
  ])('rejects unsafe URL before connecting: %s', async (sourceUrl) => {
    const fixture = transportFixture()
    await expect(downloadGeneratedImage(sourceUrl, freshSignal(), fixture.dependencies)).rejects.toThrow()
    expect(fixture.captured.calls).toBe(0)
  })

  test.each([
    '127.1.2.3', '10.0.0.1', '172.16.0.1', '192.168.0.1', '169.254.169.254',
    '100.100.100.200', '0.0.0.0', '224.0.0.1', '::1', '0:0:0:0:0:0:0:1',
    '::ffff:7f00:1', '::ffff:a9fe:a9fe', 'fc00::1', 'fe80::1', 'ff02::1',
    '2002:7f00:1::', '2001:0:4136:e378::1',
  ])('rejects non-public DNS answers even alongside a public answer: %s', async (address) => {
    const fixture = transportFixture({ addresses: [publicAddress, { address, family: address.includes(':') ? 6 : 4 }] })
    await expect(downloadGeneratedImage(url, freshSignal(), fixture.dependencies)).rejects.toThrow('non-public')
    expect(fixture.captured.connected).toBeUndefined()
  })

  test('accepts a global IPv6 CDN answer', async () => {
    const fixture = transportFixture({ addresses: [{ address: '2606:4700::1111', family: 6 }] })
    await expect(downloadGeneratedImage(url, freshSignal(), fixture.dependencies)).resolves.toBeInstanceOf(Buffer)
    expect(fixture.captured.connected).toBe('2606:4700::1111')
  })

  test('does not follow redirects or forward credentials to their target', async () => {
    const fixture = transportFixture({ status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } })
    await expect(downloadGeneratedImage(url, freshSignal(), fixture.dependencies)).rejects.toThrow('redirects are not allowed')
    expect(fixture.captured.calls).toBe(1)
    expect(fixture.response.destroyed).toBe(true)
  })

  test('rejects an oversized declared body before reading it', async () => {
    const fixture = transportFixture({ headers: { 'content-length': String(31 * 1024 * 1024) } })
    await expect(downloadGeneratedImage(url, freshSignal(), fixture.dependencies)).rejects.toThrow('30 MB')
    expect(fixture.response.destroyed).toBe(true)
  })

  test('stops a chunked response as soon as the streaming size exceeds 30 MB', async () => {
    const chunk = Buffer.alloc(1024 * 1024)
    const fixture = transportFixture({ chunks: Array.from({ length: 40 }, () => chunk) })
    await expect(downloadGeneratedImage(url, freshSignal(), fixture.dependencies)).rejects.toThrow('30 MB')
    expect(fixture.response.destroyed).toBe(true)
  })

  test('rejects empty body', async () => {
    const fixture = transportFixture({ chunks: [] })
    await expect(downloadGeneratedImage(url, freshSignal(), fixture.dependencies)).rejects.toThrow('empty')
  })

  test('aborts an in-flight request', async () => {
    const fixture = transportFixture({ stall: true })
    const controller = new AbortController()
    const pending = downloadGeneratedImage(url, controller.signal, fixture.dependencies)
    queueMicrotask(() => controller.abort())
    await expect(pending).rejects.toThrow('aborted')
  })

  test('does not start a request with an aborted signal', async () => {
    const fixture = transportFixture()
    await expect(downloadGeneratedImage(url, AbortSignal.abort(), fixture.dependencies)).rejects.toThrow()
    expect(fixture.captured.calls).toBe(0)
  })

  test('bounds a stalled request including DNS by a deadline', async () => {
    const fixture = transportFixture({ stall: true })
    await expect(downloadGeneratedImage(url, freshSignal(), { ...fixture.dependencies, timeoutMs: 5 })).rejects.toThrow('timed out')
  })
})
