import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { DesktopDynamicWallpaperPreferences } from '../../src/lib/desktopHost/types'
import { hasWebWallpaperEntry, isVideoWallpaperFile, WEB_WALLPAPER_ENTRY } from './dynamicWallpaper'

export const WALLPAPER_SCHEME = 'cc-wallpaper'
export const WALLPAPER_VIDEO_HOST = 'video'
export const WALLPAPER_PACK_HOST = 'pack'

/**
 * A wallpaper pack is arbitrary local HTML. It runs in a sandboxed iframe with
 * no same-origin access, and this policy keeps it from reaching the network or
 * loading plugins. Assets resolve through the same `cc-wallpaper:` scheme, so
 * `'self'` is the whole pack folder.
 */
export const WALLPAPER_PACK_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

const VIDEO_MIME_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.ogv': 'video/ogg',
  '.ogg': 'video/ogg',
}

const PACK_MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
}

function notFound(): Response {
  return new Response('Not found', { status: 404 })
}

function forbidden(): Response {
  return new Response('Forbidden', { status: 403 })
}

function methodNotAllowed(): Response {
  return new Response('Method not allowed', { status: 405 })
}

function contentTypeForPath(filePath: string, table: Record<string, string>): string {
  return table[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

function streamFile(
  filePath: string,
  method: string,
  headers: HeadersInit,
  range?: { start: number, end: number },
): Response {
  const status = range ? 206 : 200
  if (method === 'HEAD') return new Response(null, { status, headers })
  const stream = range
    ? fs.createReadStream(filePath, { start: range.start, end: range.end })
    : fs.createReadStream(filePath)
  return new Response(
    Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>,
    { status, headers },
  )
}

function parseRange(header: string | null, size: number): { start: number, end: number } | 'invalid' | null {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return 'invalid'
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return 'invalid'
  let start: number
  let end: number
  if (rawStart === '') {
    // Suffix range: the last N bytes.
    const length = Number(rawEnd)
    if (!Number.isSafeInteger(length) || length <= 0) return 'invalid'
    start = Math.max(0, size - length)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return 'invalid'
  }
  if (start < 0 || end < start || start >= size) return 'invalid'
  return { start, end: Math.min(end, size - 1) }
}

function serveVideo(request: Request, videoPath: string | null): Response {
  if (!videoPath || !isVideoWallpaperFile(videoPath)) return notFound()
  let stat: fs.Stats
  try {
    stat = fs.statSync(videoPath)
  } catch {
    return notFound()
  }
  if (!stat.isFile()) return notFound()

  const headers = new Headers({
    'Content-Type': contentTypeForPath(videoPath, VIDEO_MIME_TYPES),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  const range = parseRange(request.headers.get('range'), stat.size)
  if (range === 'invalid') {
    headers.set('Content-Range', `bytes */${stat.size}`)
    return new Response(null, { status: 416, headers })
  }
  if (range) {
    headers.set('Content-Length', String(range.end - range.start + 1))
    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`)
  } else {
    headers.set('Content-Length', String(stat.size))
  }
  return streamFile(videoPath, request.method, headers, range ?? undefined)
}

function isWithinRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function servePack(request: Request, webDir: string | null, pathname: string): Response {
  if (!webDir || !hasWebWallpaperEntry(webDir)) return notFound()
  let root: string
  try {
    root = fs.realpathSync(webDir)
    if (!fs.statSync(root).isDirectory()) return notFound()
  } catch {
    return notFound()
  }

  let relative: string
  try {
    relative = decodeURIComponent(pathname)
  } catch {
    return new Response('Bad request', { status: 400 })
  }
  if (relative.includes('\0')) return new Response('Bad request', { status: 400 })
  relative = relative.replace(/^[/\\]+/, '')
  if (relative === '' || relative.endsWith('/') || relative.endsWith('\\')) {
    relative = `${relative}${WEB_WALLPAPER_ENTRY}`
  }

  let target = path.resolve(root, relative)
  if (!isWithinRoot(root, target)) return forbidden()

  let stat: fs.Stats
  try {
    stat = fs.statSync(target)
    if (stat.isDirectory()) {
      target = path.resolve(target, WEB_WALLPAPER_ENTRY)
      if (!isWithinRoot(root, target)) return forbidden()
      stat = fs.statSync(target)
    }
  } catch {
    return notFound()
  }
  if (!stat.isFile()) return notFound()

  // A symlink inside the pack could point outside it; compare real paths.
  try {
    const realTarget = fs.realpathSync(target)
    if (!isWithinRoot(root, realTarget)) return forbidden()
    target = realTarget
    stat = fs.statSync(target)
  } catch {
    return notFound()
  }

  const headers = new Headers({
    'Content-Type': contentTypeForPath(target, PACK_MIME_TYPES),
    'Content-Length': String(stat.size),
    'Content-Security-Policy': WALLPAPER_PACK_CSP,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  return streamFile(target, request.method, headers)
}

/**
 * Serves only the two sources the renderer can name. Anything else — another
 * host, a path outside the chosen pack, a non-video file — resolves to 404/403.
 */
export function handleWallpaperRequest(
  request: Request,
  getPreferences: () => DesktopDynamicWallpaperPreferences,
): Response {
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return notFound()
  }
  if (url.protocol !== `${WALLPAPER_SCHEME}:`) return notFound()
  if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed()

  const preferences = getPreferences()
  if (url.hostname === WALLPAPER_VIDEO_HOST) {
    return serveVideo(request, preferences.videoPath)
  }
  if (url.hostname === WALLPAPER_PACK_HOST) {
    return servePack(request, preferences.webDir, url.pathname)
  }
  return notFound()
}