import * as path from 'node:path'
import { expandTilde } from '../../utils/permissions/pathValidation.js'
import { isAllowedFilesystemPath } from './filesystem.js'
import { serveFileWithRange } from './previewFs.js'
import { canonicalizeExistingFilesystemPath } from '../services/filesystemPathSecurity.js'
import { normalizeDriveRootPathForPlatform } from '../services/windowsDrivePath.js'

const PREFIX = '/local-file/'

/**
 * Reconstruct the absolute filesystem path encoded in a `/local-file/...`
 * request pathname.
 *
 * The request path *after* the `/local-file/` prefix IS the target's absolute
 * path with its leading separator dropped by the prefix slice. We URL-decode
 * each segment (so spaces / unicode names survive) and re-add the root:
 *
 *   - Home-relative: `~/Desktop/page.html` → `$HOME/Desktop/page.html`
 *   - POSIX: `Users/me/page.html`     → `/Users/me/page.html`
 *   - Windows drive: `C:/me/page.html` → `C:/me/page.html` (already rooted)
 *   - Windows drive (with leading `/`, e.g. from `file:///C:/...`):
 *       `C:/me/page.html` arrives the same way once the prefix is sliced.
 *
 * The WHATWG URL parser collapses `..` segments before this handler runs, so a
 * traversal such as `/local-file/../../etc/passwd` arrives with its pathname
 * normalized to `/etc/passwd` — i.e. the `/local-file/` prefix is gone. We
 * treat any request that lost the prefix as a sandbox escape (handled by the
 * caller returning 403); here we only reconstruct, the sandbox check is the
 * `isAllowedFilesystemPath` gate in {@link handleLocalFile}.
 *
 * Returns `null` when the remainder is empty.
 */
export function reconstructAbsolutePath(rest: string): string | null {
  if (!rest) return null

  const decoded = rest
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment)
      } catch {
        return segment
      }
    })
    .join('/')

  if (!decoded) return null

  if (decoded === '~' || decoded.startsWith('~/')) {
    return expandTilde(decoded)
  }

  // Windows drive form: `C:/...` or `C:\...` is already absolute.
  if (/^[a-zA-Z]:[\\/]/.test(decoded) || /^[a-zA-Z]:$/.test(decoded)) {
    return decoded
  }

  // POSIX: the leading `/` was consumed by the `/local-file/` prefix slice.
  return `/${decoded}`
}

/**
 * Serve a single ABSOLUTE local file by path so `file://` links and AI-emitted
 * absolute paths can open in the in-app browser.
 *
 * URL shape: `/local-file/<absolute-path>` where the path after the prefix is
 * the on-disk absolute path (its leading separator dropped by the prefix, or a
 * `C:/...` drive form on Windows, or `~/...` relative to the user home). This
 * is PATH-based, not query-param based,
 * so relative asset URLs (`./app.css`, `img/logo.png`) inside served HTML
 * resolve against the same `/local-file/...` directory.
 *
 * Security: the resolved path is gated by {@link isAllowedFilesystemPath} — the
 * same `$HOME` / `/tmp` / `/private/tmp` / registered-roots allow-list used by
 * the filesystem image endpoint. Anything outside is rejected with 403, so
 * `/etc/passwd` and friends stay denied. Streaming + byte-range handling is
 * shared with `/preview-fs` via {@link serveFileWithRange}, so HTML, CSS, JS,
 * images, fonts, video, and text all serve with the correct `Content-Type`,
 * `Accept-Ranges`, and 206 partial responses.
 */
export async function handleLocalFile(
  url: URL,
  reqHeaders?: Headers,
): Promise<Response> {
  if (!url.pathname.startsWith(PREFIX)) {
    return new Response('forbidden', { status: 403 })
  }

  const rest = url.pathname.slice(PREFIX.length)
  const absPath = reconstructAbsolutePath(rest)
  if (!absPath) return new Response('bad request', { status: 400 })

  const resolved = path.resolve(normalizeDriveRootPathForPlatform(absPath))
  const canonicalPath = await canonicalizeExistingFilesystemPath(resolved)
  if (!canonicalPath) {
    if (!isAllowedFilesystemPath(resolved)) {
      return new Response('forbidden', { status: 403 })
    }
    return new Response('not found', { status: 404 })
  }
  if (!isAllowedFilesystemPath(canonicalPath)) {
    return new Response('forbidden', { status: 403 })
  }

  return serveFileWithRange(canonicalPath, reqHeaders)
}
