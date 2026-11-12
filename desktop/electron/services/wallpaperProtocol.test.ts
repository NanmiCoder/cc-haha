import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DesktopDynamicWallpaperPreferences } from '../../src/lib/desktopHost/types'
import { DEFAULT_DYNAMIC_WALLPAPER } from './dynamicWallpaper'
import {
  WALLPAPER_PACK_CSP,
  handleWallpaperRequest,
} from './wallpaperProtocol'

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-haha-wallpaper-protocol-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function preferences(patch: Partial<DesktopDynamicWallpaperPreferences>): DesktopDynamicWallpaperPreferences {
  return { ...DEFAULT_DYNAMIC_WALLPAPER, ...patch }
}

function request(url: string, init?: RequestInit): Request {
  return new Request(url, init)
}

describe('cc-wallpaper protocol', () => {
  it('serves the configured video with byte-range support', async () => {
    const video = path.join(root, 'loop.mp4')
    fs.writeFileSync(video, '0123456789')
    const get = () => preferences({ kind: 'video', videoPath: video })

    const full = handleWallpaperRequest(request('cc-wallpaper://video/stream'), get)
    expect(full.status).toBe(200)
    expect(full.headers.get('content-type')).toBe('video/mp4')
    expect(full.headers.get('accept-ranges')).toBe('bytes')
    expect(full.headers.get('content-length')).toBe('10')
    expect(await full.text()).toBe('0123456789')

    const ranged = handleWallpaperRequest(
      request('cc-wallpaper://video/stream', { headers: { Range: 'bytes=2-5' } }),
      get,
    )
    expect(ranged.status).toBe(206)
    expect(ranged.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(ranged.headers.get('content-length')).toBe('4')
    expect(await ranged.text()).toBe('2345')

    const suffix = handleWallpaperRequest(
      request('cc-wallpaper://video/stream', { headers: { Range: 'bytes=-3' } }),
      get,
    )
    expect(await suffix.text()).toBe('789')
  })

  it('rejects unsatisfiable ranges and unsupported methods', async () => {
    const video = path.join(root, 'loop.webm')
    fs.writeFileSync(video, '1234')
    const get = () => preferences({ kind: 'video', videoPath: video })

    const invalid = handleWallpaperRequest(
      request('cc-wallpaper://video/stream', { headers: { Range: 'bytes=9-' } }),
      get,
    )
    expect(invalid.status).toBe(416)
    expect(invalid.headers.get('content-range')).toBe('bytes */4')

    const post = handleWallpaperRequest(
      request('cc-wallpaper://video/stream', { method: 'POST' }),
      get,
    )
    expect(post.status).toBe(405)

    const head = handleWallpaperRequest(
      request('cc-wallpaper://video/stream', { method: 'HEAD' }),
      get,
    )
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
  })

  it('serves the pack index and nested assets behind a sandbox CSP', async () => {
    const pack = path.join(root, 'pack')
    fs.mkdirSync(path.join(pack, 'assets'), { recursive: true })
    fs.writeFileSync(path.join(pack, 'index.html'), '<html><body>hello</body></html>')
    fs.writeFileSync(path.join(pack, 'assets', 'app.js'), 'console.log(1)')
    const get = () => preferences({ kind: 'web', webDir: pack })

    const index = handleWallpaperRequest(request('cc-wallpaper://pack/'), get)
    expect(index.status).toBe(200)
    expect(index.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(index.headers.get('content-security-policy')).toBe(WALLPAPER_PACK_CSP)
    expect(WALLPAPER_PACK_CSP).toContain("connect-src 'none'")
    expect(await index.text()).toContain('hello')

    const asset = handleWallpaperRequest(request('cc-wallpaper://pack/assets/app.js'), get)
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(await asset.text()).toBe('console.log(1)')
  })

  it('keeps the pack inside its folder', async () => {
    const pack = path.join(root, 'pack')
    fs.mkdirSync(pack)
    fs.writeFileSync(path.join(pack, 'index.html'), '<html></html>')
    fs.writeFileSync(path.join(root, 'secret.txt'), 'private')
    const get = () => preferences({ kind: 'web', webDir: pack })

    const escaped = handleWallpaperRequest(
      request('cc-wallpaper://pack/%2e%2e%2fsecret.txt'),
      get,
    )
    expect(escaped.status).toBe(403)

    const missing = handleWallpaperRequest(request('cc-wallpaper://pack/nope.html'), get)
    expect(missing.status).toBe(404)
  })

  it('serves nothing without a configured source or for unknown hosts', async () => {
    const get = () => DEFAULT_DYNAMIC_WALLPAPER
    expect(handleWallpaperRequest(request('cc-wallpaper://video/stream'), get).status).toBe(404)
    expect(handleWallpaperRequest(request('cc-wallpaper://pack/index.html'), get).status).toBe(404)
    expect(handleWallpaperRequest(request('cc-wallpaper://other/index.html'), get).status).toBe(404)
  })

  it('does not serve arbitrary local files through the video host', async () => {
    const text = path.join(root, 'private.txt')
    fs.writeFileSync(text, 'secret')
    const get = () => preferences({ kind: 'video', videoPath: text })
    expect(handleWallpaperRequest(request('cc-wallpaper://video/stream'), get).status).toBe(404)
  })
})