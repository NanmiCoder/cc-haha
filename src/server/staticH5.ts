import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * The phone H5 app: the Expo web export of `mobile/`, built into `dist/m`
 * (`mobile/app.config.ts` sets this base path). It is its own single-page
 * app, so a reload anywhere under it must get its own index document.
 */
export const MOBILE_H5_BASE_PATH = '/m'

// Content-hashed file names: Vite's `/assets/`, and Expo's bundles and assets.
const CACHEABLE_ASSET_RE = /^\/(?:assets|m\/_expo\/static|m\/assets)\//

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  // Browsers refuse a module script served as octet-stream, and
  // `WebAssembly.instantiateStreaming` refuses anything but application/wasm.
  '.mjs': 'text/javascript; charset=utf-8',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

export async function handleStaticH5Request(req: Request, url: URL): Promise<Response | null> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return null
  }

  const distDir = await resolveH5DistDir()
  if (!distDir) {
    return null
  }

  if (isMobileH5Page(url.pathname) && !(await fileIfExists(mobileIndexPath(distDir)))) {
    // A phone that index.html sent here, on a server built without the phone
    // app. The desktop document cannot boot under /m/ (its asset URLs are
    // relative), so send it back to the entry: arriving straight back skips
    // the fast path, and the app keeps its own phone layout.
    return new Response(null, {
      status: 302,
      headers: { Location: '/', 'Cache-Control': 'no-store' },
    })
  }

  const filePath = await resolveStaticFilePath(distDir, url.pathname)
  if (!filePath) {
    return null
  }

  const headers = new Headers({
    'Content-Type': contentTypeForPath(filePath),
    'Cache-Control': CACHEABLE_ASSET_RE.test(url.pathname)
      ? 'public, max-age=31536000, immutable'
      : 'no-store',
  })

  if (req.method === 'HEAD') {
    const stat = await fs.stat(filePath)
    headers.set('Content-Length', String(stat.size))
    return new Response(null, { status: 200, headers })
  }

  return new Response(Bun.file(filePath), { status: 200, headers })
}

async function resolveH5DistDir(): Promise<string | null> {
  const candidates = [
    process.env.CLAUDE_H5_DIST_DIR,
    unpackedAsarDistDir(process.env.CLAUDE_H5_DIST_DIR),
    process.env.CLAUDE_APP_ROOT
      ? path.resolve(process.env.CLAUDE_APP_ROOT, '..', 'Resources', '_up_', 'dist')
      : undefined,
    process.env.CLAUDE_APP_ROOT
      ? unpackedAsarDistDir(path.resolve(process.env.CLAUDE_APP_ROOT, 'dist'))
      : undefined,
    process.env.CLAUDE_APP_ROOT
      ? path.resolve(process.env.CLAUDE_APP_ROOT, '..', 'Resources', 'dist')
      : undefined,
    process.env.CLAUDE_APP_ROOT
      ? path.resolve(process.env.CLAUDE_APP_ROOT, 'dist')
      : undefined,
    path.resolve(process.cwd(), 'desktop', 'dist'),
    path.resolve(process.cwd(), 'dist'),
  ].filter((candidate): candidate is string => !!candidate)

  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(path.join(candidate, 'index.html'))
      if (stat.isFile()) {
        return path.resolve(candidate)
      }
    } catch {
      // Try the next candidate.
    }
  }

  return null
}

function unpackedAsarDistDir(value: string | undefined): string | undefined {
  if (!value || !value.includes('.asar')) {
    return undefined
  }

  return value.replace(/\.asar(?=$|[/\\])/, '.asar.unpacked')
}

async function resolveStaticFilePath(distDir: string, pathname: string): Promise<string | null> {
  const requested = containedPath(distDir, pathname)
  if (!requested) {
    return null
  }

  const direct = await fileIfExists(requested)
  if (direct) {
    return direct
  }

  const nestedIndex = await fileIfExists(path.join(requested, 'index.html'))
  if (nestedIndex) {
    return nestedIndex
  }

  if (path.extname(requested)) {
    return null
  }

  if (isMobileH5Page(pathname)) {
    return fileIfExists(mobileIndexPath(distDir))
  }

  return fileIfExists(path.join(distDir, 'index.html'))
}

/** A page (not an asset) of the phone app: its routes are all extensionless. */
function isMobileH5Page(pathname: string): boolean {
  return (pathname === MOBILE_H5_BASE_PATH || pathname.startsWith(`${MOBILE_H5_BASE_PATH}/`)) &&
    !path.extname(pathname)
}

function mobileIndexPath(distDir: string): string {
  return path.join(distDir, MOBILE_H5_BASE_PATH.slice(1), 'index.html')
}

function containedPath(root: string, pathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }

  const relativePath = decoded.replace(/^\/+/, '') || 'index.html'
  const candidate = path.resolve(root, relativePath)
  const relativeToRoot = path.relative(root, candidate)
  if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
    return null
  }

  return candidate
}

async function fileIfExists(filePath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(filePath)
    return stat.isFile() ? filePath : null
  } catch {
    return null
  }
}

function contentTypeForPath(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}
