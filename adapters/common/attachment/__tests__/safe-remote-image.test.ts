import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadSafeRemoteImage,
  materializePendingUploadImage,
  requestPinnedRemoteImageHop,
  type RemoteImageDependencies,
  type RemoteImageHopResponse,
} from '../safe-remote-image.js'
import { IMAGE_MAX_BYTES } from '../attachment-limits.js'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve) => server.close(() => resolve()))
  ))
})

function response(
  chunks: Buffer[],
  options: Partial<Omit<RemoteImageHopResponse, 'body' | 'destroy'>> = {},
): RemoteImageHopResponse {
  return {
    status: options.status ?? 200,
    headers: options.headers ?? {
      'content-type': 'image/png',
    },
    body: (async function* () {
      yield* chunks
    })(),
    destroy: () => {},
  }
}

describe('loadSafeRemoteImage', () => {
  it('rejects non-http URLs and credential-bearing URLs before resolution', async () => {
    let resolutionCalls = 0
    const dependencies: RemoteImageDependencies = {
      resolveHostname: async () => {
        resolutionCalls += 1
        return [{ address: '93.184.216.34', family: 4 }]
      },
    }

    expect(await loadSafeRemoteImage('file:///etc/passwd', dependencies)).toEqual({
      ok: false,
      reason: 'remote image URL must use http or https',
    })
    expect(await loadSafeRemoteImage(
      'https://user:secret@example.com/image.png',
      dependencies,
    )).toEqual({
      ok: false,
      reason: 'remote image URL must not contain credentials',
    })
    expect(resolutionCalls).toBe(0)
  })

  it.each([
    ['loopback', '127.0.0.1', 4],
    ['private', '10.0.0.2', 4],
    ['link-local metadata', '169.254.169.254', 4],
    ['carrier-grade NAT', '100.64.0.1', 4],
    ['IPv6 loopback', '::1', 6],
    ['IPv6 unique-local', 'fd00::1', 6],
    ['IPv6 link-local', 'fe80::1', 6],
    ['IPv4-mapped private IPv6', '::ffff:192.168.1.1', 6],
  ])('blocks %s DNS answers before making a request', async (
    _label,
    address,
    family,
  ) => {
    let requestCalls = 0
    const result = await loadSafeRemoteImage('https://images.example/image.png', {
      resolveHostname: async () => [{ address, family: family as 4 | 6 }],
      requestHop: async () => {
        requestCalls += 1
        return response([Buffer.from('unsafe')])
      },
    })

    expect(result).toEqual({
      ok: false,
      reason: 'remote image host resolved to a non-public address',
    })
    expect(requestCalls).toBe(0)
  })

  it('rejects a host when any DNS answer is non-public', async () => {
    let requestCalls = 0
    const result = await loadSafeRemoteImage('https://images.example/image.png', {
      resolveHostname: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
      requestHop: async () => {
        requestCalls += 1
        return response([Buffer.from('unsafe')])
      },
    })

    expect(result.ok).toBe(false)
    expect(requestCalls).toBe(0)
  })

  it('pins each redirect hop to a separately vetted DNS result', async () => {
    const resolutions: string[] = []
    const requests: Array<{ url: string; address: string }> = []
    const dependencies: RemoteImageDependencies = {
      resolveHostname: async (hostname) => {
        resolutions.push(hostname)
        return [{
          address: hostname === 'one.example' ? '93.184.216.34' : '142.250.72.14',
          family: 4,
        }]
      },
      requestHop: async (url, address) => {
        requests.push({ url: url.href, address: address.address })
        if (url.hostname === 'one.example') {
          return response([], {
            status: 302,
            headers: { location: 'https://two.example/final.png' },
          })
        }
        return response([Buffer.from('png')])
      },
    }

    const result = await loadSafeRemoteImage(
      'https://one.example/start.png',
      dependencies,
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.buffer.toString()).toBe('png')
      expect(result.mime).toBe('image/png')
    }
    expect(resolutions).toEqual(['one.example', 'two.example'])
    expect(requests).toEqual([
      {
        url: 'https://one.example/start.png',
        address: '93.184.216.34',
      },
      {
        url: 'https://two.example/final.png',
        address: '142.250.72.14',
      },
    ])
  })

  it('revalidates redirect destinations and blocks redirects to metadata', async () => {
    let requestCalls = 0
    const result = await loadSafeRemoteImage('https://one.example/start.png', {
      resolveHostname: async (hostname) => [{
        address: hostname === 'one.example' ? '93.184.216.34' : '169.254.169.254',
        family: 4,
      }],
      requestHop: async () => {
        requestCalls += 1
        return response([], {
          status: 302,
          headers: { location: 'http://metadata.example/latest/meta-data/' },
        })
      },
    })

    expect(result.ok).toBe(false)
    expect(requestCalls).toBe(1)
  })

  it('enforces image MIME and declared or streamed byte limits', async () => {
    const publicResolver = async () => [{
      address: '93.184.216.34',
      family: 4 as const,
    }]
    const unsupported = await loadSafeRemoteImage('https://example.com/a.svg', {
      resolveHostname: publicResolver,
      requestHop: async () => response([Buffer.from('svg')], {
        headers: { 'content-type': 'image/svg+xml' },
      }),
    })
    const declaredLarge = await loadSafeRemoteImage('https://example.com/a.png', {
      resolveHostname: publicResolver,
      requestHop: async () => response([], {
        headers: {
          'content-type': 'image/png',
          'content-length': String(IMAGE_MAX_BYTES + 1),
        },
      }),
    })
    const streamedLarge = await loadSafeRemoteImage('https://example.com/a.png', {
      resolveHostname: publicResolver,
      requestHop: async () => response([
        Buffer.alloc(IMAGE_MAX_BYTES),
        Buffer.alloc(1),
      ]),
    })
    const encoded = await loadSafeRemoteImage('https://example.com/a.png', {
      resolveHostname: publicResolver,
      requestHop: async () => response([Buffer.from('compressed')], {
        headers: {
          'content-type': 'image/png',
          'content-encoding': 'gzip',
        },
      }),
    })

    expect(unsupported.ok).toBe(false)
    expect(declaredLarge.ok).toBe(false)
    expect(streamedLarge.ok).toBe(false)
    expect(encoded.ok).toBe(false)
  })

  it('applies one total deadline across DNS and the request', async () => {
    let requestCalls = 0
    const startedAt = Date.now()
    const result = await loadSafeRemoteImage('https://slow.example/image.png', {
      timeoutMs: 30,
      resolveHostname: async () => await new Promise<never>(() => {}),
      requestHop: async () => {
        requestCalls += 1
        return response([Buffer.from('unexpected')])
      },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('timed out')
    expect(Date.now() - startedAt).toBeLessThan(500)
    expect(requestCalls).toBe(0)
  })

  it('does not send credentials or resolve DNS again in the pinned transport', async () => {
    let receivedHost = ''
    let receivedAuthorization: string | undefined
    let receivedCookie: string | undefined
    const server = createServer((request, reply) => {
      receivedHost = request.headers.host ?? ''
      receivedAuthorization = request.headers.authorization
      receivedCookie = request.headers.cookie
      reply.writeHead(200, { 'content-type': 'image/png' })
      reply.end('pinned')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing test port')

    const hop = await requestPinnedRemoteImageHop(
      new URL(`http://images.example:${address.port}/image.png`),
      { address: '127.0.0.1', family: 4 },
      1_000,
    )
    const chunks: Buffer[] = []
    for await (const chunk of hop.body) chunks.push(Buffer.from(chunk))

    expect(Buffer.concat(chunks).toString()).toBe('pinned')
    expect(receivedHost).toBe(`images.example:${address.port}`)
    expect(receivedAuthorization).toBeUndefined()
    expect(receivedCookie).toBeUndefined()
  })

  it('terminates a slow-drip pinned response at the total deadline', async () => {
    const server = createServer((_request, reply) => {
      reply.writeHead(200, { 'content-type': 'image/png' })
      const drip = setInterval(() => reply.write('x'), 10)
      reply.on('close', () => clearInterval(drip))
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing test port')

    const startedAt = Date.now()
    await expect((async () => {
      // The total deadline also covers connection setup and response headers.
      // Under instrumentation it can expire before the body iterator exists.
      const hop = await requestPinnedRemoteImageHop(
        new URL(`http://images.example:${address.port}/slow.png`),
        { address: '127.0.0.1', family: 4 },
        50,
      )
      for await (const _chunk of hop.body) {
        // Consume until the total request deadline aborts the stream.
      }
    })()).rejects.toThrow()
    expect(Date.now() - startedAt).toBeLessThan(500)
  })
})

describe('materializePendingUploadImage', () => {
  it('materializes base64 and path sources without changing their MIME', async () => {
    const root = await mkdtemp(join(tmpdir(), 'adapter-outbound-image-'))
    const imagePath = join(root, 'image.webp')
    await writeFile(imagePath, 'path-image')

    try {
      const base64 = await materializePendingUploadImage({
        kind: 'base64',
        data: Buffer.from('base64-image').toString('base64'),
        mime: 'image/jpeg',
      })
      const path = await materializePendingUploadImage({
        kind: 'path',
        path: imagePath,
        mime: 'image/webp',
      })

      expect(base64.buffer.toString()).toBe('base64-image')
      expect(base64.mime).toBe('image/jpeg')
      expect(path.buffer.toString()).toBe('path-image')
      expect(path.mime).toBe('image/webp')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('surfaces a policy rejection for unsafe remote URLs', async () => {
    await expect(materializePendingUploadImage({
      kind: 'url',
      url: 'http://127.0.0.1/private.png',
    })).rejects.toThrow('non-public address')
  })
})
