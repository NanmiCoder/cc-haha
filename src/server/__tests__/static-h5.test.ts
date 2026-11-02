import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
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

async function get(pathname: string): Promise<Response | null> {
  const url = new URL(`http://127.0.0.1${pathname}`)
  return handleStaticH5Request(new Request(url), url)
}

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
