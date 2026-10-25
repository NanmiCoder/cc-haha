import { describe, expect, test } from 'bun:test'
import { gzipSync } from 'node:zlib'
import { buildProviderMediaFetch, MediaFileCache } from './fetch.js'
import { resolveDeepSeekMediaEndpoint } from './deepseek.js'
import type { MediaEndpointResolver } from './types.js'

const origin = 'https://api.deepseek.com'
const url = `${origin}/anthropic/v1/messages`
const image = (bytes = 900) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.alloc(bytes, 1).toString('base64') } })
const body = (blocks: unknown[] = [image()]) => JSON.stringify({ model: 'deepseek-flash', messages: [{ role: 'user', content: blocks }] })
const init = (raw = body(), key = 'test-key') => ({ method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body: raw })
const resolveSmall: MediaEndpointResolver = url => {
  const endpoint = resolveDeepSeekMediaEndpoint(url)
  return endpoint ? { ...endpoint, triggerBytes: 1000, targetBytes: 600 } : undefined
}

type Seen = { url: string; init: RequestInit | undefined }
function harness(options: { resolveEndpoint?: MediaEndpointResolver; now?: () => number; upload?: (index: number, init: RequestInit) => Response | Promise<Response>; message?: (index: number, init: RequestInit) => Response } = {}) {
  const seen: Seen[] = []
  let uploads = 0
  let messages = 0
  const inner = (async (input: RequestInfo | URL, request?: RequestInit) => {
    const target = input instanceof Request ? input.url : String(input)
    seen.push({ url: target, init: request })
    if (target.endsWith('/files')) {
      uploads++
      return options.upload?.(uploads, request!) ?? Response.json({ id: `file-${uploads}` })
    }
    messages++
    return options.message?.(messages, request!) ?? Response.json({ ok: true })
  }) as typeof fetch
  const wrapped = buildProviderMediaFetch(inner, { resolveEndpoint: options.resolveEndpoint ?? resolveSmall, cache: new MediaFileCache(), now: options.now })
  return { wrapped, seen, uploads: () => uploads, messages: () => messages }
}

function sent(h: ReturnType<typeof harness>) {
  return JSON.parse(String(h.seen.filter(r => !r.url.endsWith('/files')).at(-1)!.init!.body))
}

describe('provider media fetch', () => {
  test('small/unknown endpoints preserve original input and headers; no upload', async () => {
    const h = harness()
    const small = init(body([image(12)]))
    await h.wrapped(url, small)
    expect(h.seen[0]!.init).toBe(small)
    const unknown = init()
    await h.wrapped('https://relay.example/anthropic/v1/messages', unknown)
    expect(h.seen[1]!.init).toBe(unknown)
    expect(h.uploads()).toBe(0)
  })

  test('real 40 MiB threshold offloads a 48.6 MiB request without altering source', async () => {
    const h = harness({ resolveEndpoint: resolveDeepSeekMediaEndpoint })
    const raw = body(Array.from({ length: 42 }, () => image(910_000)))
    expect(Buffer.byteLength(raw)).toBeGreaterThan(48 * 1024 ** 2)
    await h.wrapped(url, init(raw))
    // Identical images share one upload and all occurrences become references.
    expect(h.uploads()).toBe(1)
    const outgoing = h.seen.at(-1)!.init!
    expect(Buffer.byteLength(String(outgoing.body))).toBeLessThan(32 * 1024 ** 2)
    expect(raw).toContain('"type":"base64"')
    expect(sent(h).messages[0].content.every((b: any) => b.source.type === 'file')).toBe(true)
  })

  test('distinct 48.6 MiB history uploads only enough images to reach the target', async () => {
    const h = harness({ resolveEndpoint: resolveDeepSeekMediaEndpoint })
    const blocks = Array.from({ length: 42 }, (_, i) => ({
      type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.alloc(910_000, i).toString('base64') },
    }))
    const raw = body(blocks)
    await h.wrapped(url, init(raw))
    expect(h.uploads()).toBeGreaterThan(0)
    expect(h.uploads()).toBeLessThan(42)
    expect(Buffer.byteLength(String(h.seen.at(-1)!.init!.body))).toBeLessThan(32 * 1024 ** 2)
    const sources = sent(h).messages[0].content.map((b: any) => b.source)
    expect(sources.filter((s: any) => s.type === 'file')).toHaveLength(h.uploads())
    expect(sources.filter((s: any) => s.type === 'base64')).toHaveLength(42 - h.uploads())
    expect(blocks.every(b => b.source.type === 'base64')).toBe(true)
  })

  test('uploads largest groups only, preserves nested tool results and merges beta headers', async () => {
    const h = harness({ resolveEndpoint: u => {
      const e = resolveSmall(u)
      return e ? { ...e, targetBytes: 1000 } : e
    } })
    const raw = body([{ type: 'text', text: 'keep this' }, image(90), { type: 'tool_result', tool_use_id: 't1', content: [image(900)] }])
    await h.wrapped(url, { ...init(raw), headers: { ...init().headers, 'anthropic-beta': 'effort-test', 'content-length': String(raw.length) } })
    expect(h.uploads()).toBe(1)
    const upload = h.seen[0]!.init!
    expect(new Headers(upload.headers).get('authorization')).toBe('Bearer test-key')
    expect(new Headers(upload.headers).has('content-type')).toBe(false)
    expect(new Headers(upload.headers).has('content-length')).toBe(false)
    const form = upload.body as FormData
    expect(form.get('purpose')).toBe('user_data')
    expect(form.get('expires_after[seconds]')).toBe('86400')
    expect((form.get('file') as Blob).size).toBe(900)
    const outgoing = h.seen.at(-1)!.init!
    expect(new Headers(outgoing.headers).get('anthropic-beta')).toBe('effort-test,files-api-2025-04-14')
    expect(new Headers(outgoing.headers).has('content-length')).toBe(false)
    expect(sent(h).messages[0].content[1].source.type).toBe('base64')
    expect(sent(h).messages[0].content[2]).toEqual({ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'image', source: { type: 'file', file_id: 'file-1' } }] })
  })

  test('reuses uploads even below trigger, isolates keys and refreshes expired entries', async () => {
    let time = 1_000_000
    const h = harness({ now: () => time })
    const raw = body([image(300), { type: 'text', text: 'padding'.repeat(200) }])
    await h.wrapped(url, init(raw))
    await h.wrapped(url, init(body([image(300)])))
    expect(h.uploads()).toBe(1)
    expect(sent(h).messages[0].content[0].source.type).toBe('file')
    await h.wrapped(url, init(raw, 'another-account'))
    expect(h.uploads()).toBe(2)
    time += 24 * 60 * 60 * 1000
    await h.wrapped(url, init(raw))
    expect(h.uploads()).toBe(3)
  })

  test('413 below the preflight threshold triggers one recovery and does not loop', async () => {
    const h = harness({ resolveEndpoint: u => {
      const e = resolveSmall(u)
      return e ? { ...e, triggerBytes: 50_000 } : e
    }, message: () => new Response('still too large', { status: 413 }) })
    const response = await h.wrapped(url, init())
    expect(response.status).toBe(413)
    expect(h.messages()).toBe(2)
    expect(h.uploads()).toBe(1)
    expect(await response.text()).toBe('still too large')
  })

  test('a deleted cached file is reuploaded once; unrelated 400 is preserved', async () => {
    const h = harness({ message: n => n === 2
      ? Response.json({ error: { message: 'file-1 not found' } }, { status: 404 })
      : n === 4 ? new Response('invalid model', { status: 400 }) : Response.json({ ok: true }) })
    await h.wrapped(url, init())
    expect((await h.wrapped(url, init())).status).toBe(200)
    expect(h.uploads()).toBe(2)
    expect(sent(h).messages[0].content[0].source.file_id).toBe('file-2')
    expect(await (await h.wrapped(url, init())).text()).toBe('invalid model')
    expect(h.messages()).toBe(4)
  })

  test('an upload failure does not pin a deleted cached file until its TTL expires', async () => {
    let failed = false
    const h = harness({
      upload: n => n === 1 ? Response.json({ id: 'file-old' }) : new Response('rate limited', { status: 429 }),
      message: (_n, request) => {
        if (failed && String(request.body).includes('file-old')) return Response.json({ error: { message: 'file-old not found' } }, { status: 404 })
        return Response.json({ ok: true })
      },
    })
    await h.wrapped(url, init())
    failed = true
    const newImage = { ...image(1800), source: { ...image(1800).source, data: Buffer.alloc(1800, 2).toString('base64') } }
    const raw = body([image(), newImage])
    expect((await h.wrapped(url, init(raw))).status).toBe(200)
    expect(h.uploads()).toBe(2) // Failed upload is not immediately attempted again.
    expect(h.seen.at(-1)!.init!.body).toBe(raw)
    expect((await h.wrapped(url, init(raw))).status).toBe(200)
    expect(h.seen.at(-1)!.init!.body).toBe(raw)
  })

  test('compressed missing-file errors recover on raw Anthropic passthrough', async () => {
    const h = harness({ message: n => n === 2
      ? new Response(gzipSync(JSON.stringify({ error: { message: 'file-1 not found' } })), { status: 404, headers: { 'content-encoding': 'gzip' } })
      : Response.json({ ok: true }) })
    await h.wrapped(url, init())
    expect((await h.wrapped(url, { ...init(), decompress: false } as RequestInit)).status).toBe(200)
    expect(h.uploads()).toBe(2)
    expect(sent(h).messages[0].content[0].source.file_id).toBe('file-2')
  })

  test.each([401, 403, 404, 429, 500])('upload HTTP %i preserves visual input and original inference error', async status => {
    const h = harness({ upload: () => new Response('upload failed', { status }), message: () => new Response('original 413', { status: 413 }) })
    const raw = body()
    expect(await (await h.wrapped(url, init(raw))).text()).toBe('original 413')
    expect(h.messages()).toBe(1)
    expect(h.uploads()).toBe(1)
    expect(h.seen.at(-1)!.init!.body).toBe(raw)
  })

  test('Request inputs, proxy options and abort signal survive preparation', async () => {
    const h = harness()
    const controller = new AbortController()
    const request = new Request(url, { ...init(), signal: controller.signal })
    await h.wrapped(request, { proxy: 'http://127.0.0.1:1234' } as RequestInit)
    expect(h.uploads()).toBe(1)
    for (const call of h.seen) {
      expect((call.init as any).proxy).toBe('http://127.0.0.1:1234')
      expect(call.init!.signal).toBe(request.signal)
      expect(call.init!.redirect).toBe('error')
    }
    expect(request.bodyUsed).toBe(false)
  })

  test('init headers replace Request credentials instead of resurrecting an old account', async () => {
    const h = harness()
    const request = new Request(url, init())
    const override = { headers: { 'content-type': 'application/json' } }
    await h.wrapped(request, override)
    expect(h.uploads()).toBe(0)
    expect(h.seen[0]!.init).toBe(override)
  })

  test('compressed Files JSON is decoded even when inference passthrough disables decompression', async () => {
    const inferenceOptions: boolean[] = []
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => {
      if (new URL(request.url).pathname === '/files') return new Response(gzipSync(JSON.stringify({ id: 'file-compressed' })), {
        headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      })
      return request.json().then((data: any) => Response.json({ source: data.messages[0].content[0].source }))
    } })
    try {
      const inner = (async (input: RequestInfo | URL, request?: RequestInit) => {
        const target = new URL(String(input))
        if (!target.pathname.endsWith('/files')) inferenceOptions.push((request as any).decompress)
        return fetch(new URL(target.pathname, server.url), request)
      }) as typeof fetch
      const wrapped = buildProviderMediaFetch(inner, { resolveEndpoint: resolveSmall, cache: new MediaFileCache() })
      const response = await wrapped(url, { ...init(), decompress: false } as RequestInit)
      expect(await response.json()).toEqual({ source: { type: 'file', file_id: 'file-compressed' } })
      expect(inferenceOptions).toEqual([false])
    } finally {
      server.stop(true)
    }
  })

  test('aborting a Request with an unfinished body does not hang preprocessing', async () => {
    const h = harness()
    const controller = new AbortController()
    let source: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({ start(value) { source = value } })
    const request = new Request(url, { method: 'POST', headers: init().headers, body: stream, signal: controller.signal, duplex: 'half' } as RequestInit)
    const pending = h.wrapped(request)
    const timer = setTimeout(() => controller.abort(new DOMException('cancelled', 'AbortError')), 5)
    try {
      await expect(pending).rejects.toThrow('cancelled')
      expect(h.seen).toHaveLength(0)
    } finally {
      clearTimeout(timer)
      source!.close()
    }
  })

  test('abort during upload propagates without sending inference or retrying', async () => {
    const controller = new AbortController()
    const h = harness({ upload: () => {
      controller.abort(new DOMException('cancelled', 'AbortError'))
      throw controller.signal.reason
    } })
    await expect(h.wrapped(url, { ...init(), signal: controller.signal })).rejects.toThrow('cancelled')
    expect(h.messages()).toBe(0)
    expect(h.uploads()).toBe(1)
  })

  test.each(['not-base64!', '', 'AAAA===='])('invalid image data stays inline: %s', data => {
    const h = harness()
    const raw = body([{ ...image(), source: { ...image().source, data } }, { type: 'text', text: 'x'.repeat(2000) }])
    return h.wrapped(url, init(raw)).then(() => {
      expect(h.uploads()).toBe(0)
      expect(h.seen.at(-1)!.init!.body).toBe(raw)
    })
  })

  test('plain text, no credentials, GET and cross-origin upload policies never upload', async () => {
    const h = harness()
    await h.wrapped(url, init(body([{ type: 'text', text: 'x'.repeat(4000) }])))
    await h.wrapped(url, { ...init(), headers: {} })
    await h.wrapped(url)
    expect(h.uploads()).toBe(0)
    const cross = harness({ resolveEndpoint: u => {
      const e = resolveSmall(u)
      return e ? { ...e, uploadUrl: 'https://other.example/files' } : e
    } })
    await cross.wrapped(url, init())
    expect(cross.uploads()).toBe(0)
  })
})
