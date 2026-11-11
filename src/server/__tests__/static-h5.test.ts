import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { handleStaticH5Request } from '../staticH5.js'

let distDir: string
const savedEnv = {
  CLAUDE_H5_DIST_DIR: process.env.CLAUDE_H5_DIST_DIR,
  CLAUDE_APP_ROOT: process.env.CLAUDE_APP_ROOT,
}

beforeEach(async () => {
  distDir = await fs.mkdtemp(path.join(os.tmpdir(), 'static-h5-'))
  await fs.mkdir(path.join(distDir, 'assets', 'pdfjs-0.0.0', 'cmaps'), { recursive: true })
  await fs.writeFile(path.join(distDir, 'index.html'), '<!doctype html><title>app</title>')
  await fs.writeFile(path.join(distDir, 'assets', 'worker.mjs'), 'export {}')
  await fs.writeFile(path.join(distDir, 'assets', 'decoder.wasm'), Buffer.from([0x00, 0x61, 0x73, 0x6d]))
  await fs.writeFile(path.join(distDir, 'assets', 'pdfjs-0.0.0', 'cmaps', 'UniGB-UCS2-H.bcmap'), Buffer.from([0x01]))
  process.env.CLAUDE_H5_DIST_DIR = distDir
  delete process.env.CLAUDE_APP_ROOT
})

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await fs.rm(distDir, { recursive: true, force: true })
})

async function get(pathname: string, init?: RequestInit): Promise<Response | null> {
  const url = new URL(`http://127.0.0.1${pathname}`)
  return handleStaticH5Request(new Request(url, init), url)
}

describe('handleStaticH5Request remote transfer compression', () => {
  const source = 'export const message = "mobile remote session"\n'.repeat(2000)

  beforeEach(async () => {
    await fs.writeFile(path.join(distDir, 'assets', 'app-abcdefgh.js'), source)
  })

  it('streams a smaller gzip representation that decodes to the complete JavaScript', async () => {
    const res = await get('/assets/app-abcdefgh.js', { headers: { 'Accept-Encoding': 'gzip, deflate, br' } })
    expect(res?.headers.get('content-encoding')).toBe('gzip')
    expect(res?.headers.get('vary')).toBe('Accept-Encoding')
    expect(res?.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(res?.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    const bytes = new Uint8Array(await res!.arrayBuffer())
    expect(bytes.length).toBeLessThan(source.length / 4)
    expect(new TextDecoder().decode(Bun.gunzipSync(bytes))).toBe(source)
  })

  it('honors gzip quality and wildcard negotiation without overriding an explicit refusal', async () => {
    for (const encoding of ['gzip;q=0.5', 'gzip ;q=0.5', 'br, *;q=0.8', 'GZip; q=1']) {
      const res = await get('/assets/app-abcdefgh.js', { headers: { 'Accept-Encoding': encoding } })
      expect(res?.headers.get('content-encoding')).toBe('gzip')
      await res!.body!.cancel()
    }
    for (const encoding of ['gzip;q=0, *;q=1', 'gzip ;q=0, *;q=1', 'br', '*;q=0', 'gzip;q=bogus']) {
      const res = await get('/assets/app-abcdefgh.js', { headers: { 'Accept-Encoding': encoding } })
      expect(res?.headers.get('content-encoding')).toBeNull()
      expect(res?.headers.get('vary')).toBe('Accept-Encoding')
      expect(await res!.text()).toBe(source)
    }
  })

  it('serves identity when compression was not requested, and skips small or already compressed files', async () => {
    expect(await (await get('/assets/app-abcdefgh.js'))!.text()).toBe(source)
    await fs.writeFile(path.join(distDir, 'assets', 'photo.png'), new Uint8Array(4096))
    for (const pathname of ['/assets/photo.png', '/assets/worker.mjs']) {
      const res = await get(pathname, { headers: { 'Accept-Encoding': 'gzip' } })
      expect(res?.headers.get('content-encoding')).toBeNull()
      await res!.arrayBuffer()
    }
  })

  it('keeps HEAD representation headers consistent without sending a compressed body', async () => {
    const res = await get('/assets/app-abcdefgh.js', { method: 'HEAD', headers: { 'Accept-Encoding': 'gzip' } })
    expect(res?.headers.get('content-encoding')).toBe('gzip')
    expect(res?.headers.get('vary')).toBe('Accept-Encoding')
    expect(Number(res?.headers.get('content-length'))).toBeGreaterThan(0)
    expect(await res!.text()).toBe('')
    const identity = await get('/assets/app-abcdefgh.js', { method: 'HEAD' })
    expect(identity?.headers.get('content-length')).toBe(String(Buffer.byteLength(source)))
  })

  it('sends accurate gzip HEAD metadata over real Bun HTTP without changing the GET stream', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        return await handleStaticH5Request(request, new URL(request.url))
          ?? new Response('Not found', { status: 404 })
      },
    })
    // node:http preserves the encoded bytes; fetch can silently decompress
    // them and hide a disagreement between Content-Length and the wire body.
    const readWire = (method: 'GET' | 'HEAD') => new Promise<{
      status: number | undefined
      headers: http.IncomingHttpHeaders
      body: Buffer
    }>((resolve, reject) => {
      const request = http.request({
        hostname: '127.0.0.1',
        port: server.port,
        path: '/assets/app-abcdefgh.js',
        method,
        headers: { 'Accept-Encoding': 'gzip' },
      }, (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('error', reject)
        response.on('end', () => resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks),
        }))
      })
      request.setTimeout(3000, () => request.destroy(new Error('Static fixture request timed out')))
      request.on('error', reject)
      request.end()
    })
    try {
      const getResponse = await readWire('GET')
      const headResponse = await readWire('HEAD')
      expect(getResponse.status).toBe(200)
      expect(headResponse.status).toBe(200)
      expect(getResponse.headers['content-encoding']).toBe('gzip')
      expect(headResponse.headers['content-encoding']).toBe('gzip')
      expect(headResponse.headers.vary).toBe('Accept-Encoding')
      expect(headResponse.headers['content-type']).toBe(getResponse.headers['content-type'])
      expect(headResponse.headers['content-length']).toBe(String(getResponse.body.length))
      expect(headResponse.body.length).toBe(0)
      expect(getResponse.body.length).toBeLessThan(Buffer.byteLength(source) / 4)
      expect(new TextDecoder().decode(Bun.gunzipSync(getResponse.body))).toBe(source)
    } finally {
      server.stop(true)
    }
  })

  it('compresses entry HTML without caching it and reads a replaced build on the next request', async () => {
    const html = '<!doctype html><title>remote app</title>'.repeat(100)
    await fs.writeFile(path.join(distDir, 'index.html'), html)
    const first = await get('/remote', { headers: { 'Accept-Encoding': 'gzip' } })
    expect(first?.headers.get('cache-control')).toBe('no-store')
    expect(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await first!.arrayBuffer())))).toBe(html)
    await fs.writeFile(path.join(distDir, 'index.html'), html + '<p>new build</p>')
    const second = await get('/remote', { headers: { 'Accept-Encoding': 'gzip' } })
    expect(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await second!.arrayBuffer())))).toBe(html + '<p>new build</p>')
  })
})

describe('handleStaticH5Request media types', () => {
  it('serves .mjs as a JavaScript module, which browsers require of module scripts and workers', async () => {
    const res = await get('/assets/worker.mjs')

    expect(res?.status).toBe(200)
    expect(res?.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
  })

  it('serves .wasm as application/wasm, which instantiateStreaming requires', async () => {
    const res = await get('/assets/decoder.wasm')

    expect(res?.status).toBe(200)
    expect(res?.headers.get('content-type')).toBe('application/wasm')
  })

  it('leaves binary data files such as cMaps as octet-stream', async () => {
    const res = await get('/assets/pdfjs-0.0.0/cmaps/UniGB-UCS2-H.bcmap')

    expect(res?.status).toBe(200)
    expect(res?.headers.get('content-type')).toBe('application/octet-stream')
  })

  it('caches hashed assets immutably and never caches the entry document', async () => {
    expect((await get('/assets/worker.mjs'))?.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect((await get('/index.html'))?.headers.get('cache-control')).toBe('no-store')
  })

  it('does not serve a path that escapes the dist directory', async () => {
    expect(await get('/..%2f..%2fetc/passwd')).toBeNull()
  })
})

describe('handleStaticH5Request phone app under /m', () => {
  beforeEach(async () => {
    await fs.mkdir(path.join(distDir, 'm', '_expo', 'static', 'js', 'web'), { recursive: true })
    await fs.mkdir(path.join(distDir, 'm', 'assets', 'assets', 'fonts'), { recursive: true })
    await fs.writeFile(path.join(distDir, 'm', 'index.html'), '<!doctype html><title>phone</title>')
    await fs.writeFile(path.join(distDir, 'm', '_expo', 'static', 'js', 'web', 'entry-abc.js'), 'void 0')
    await fs.writeFile(path.join(distDir, 'm', 'assets', 'assets', 'fonts', 'GeistMono.abc.ttf'), Buffer.from([0x00]))
  })

  it('answers a reload of any phone route with the phone app, not the desktop app', async () => {
    for (const route of ['/m', '/m/', '/m/chat/session-1', '/m/settings']) {
      const res = await get(route)
      expect(await res?.text()).toContain('phone')
    }
    // Routes outside the phone app keep the desktop document.
    expect(await (await get('/remote'))?.text()).toContain('app')
    expect(await (await get('/mobile'))?.text()).toContain('app')
  })

  it('does not turn a missing phone asset into an HTML page', async () => {
    expect(await get('/m/_expo/static/js/web/missing.js')).toBeNull()
  })

  it('caches the hashed phone bundles and fonts immutably, with real media types', async () => {
    const script = await get('/m/_expo/static/js/web/entry-abc.js')
    expect(script?.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    const font = await get('/m/assets/assets/fonts/GeistMono.abc.ttf')
    expect(font?.headers.get('content-type')).toBe('font/ttf')
    expect(font?.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect((await get('/m/'))?.headers.get('cache-control')).toBe('no-store')
  })

  it('sends a phone back to the entry when the phone app is not built, instead of a desktop page that cannot boot there', async () => {
    await fs.rm(path.join(distDir, 'm'), { recursive: true, force: true })
    for (const route of ['/m', '/m/', '/m/chat/session-1']) {
      const res = await get(route)
      expect(res?.status).toBe(302)
      expect(res?.headers.get('location')).toBe('/')
    }
    // The desktop app's own probe for the phone build still sees a plain miss.
    expect(await get('/m/h5.json')).toBeNull()
    expect(await (await get('/'))?.text()).toContain('app')
  })
})
