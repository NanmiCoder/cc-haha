import { classifyPreviewLink, type PreviewLinkTarget } from './previewLinkRouter'
import { shouldOfferStaticHtmlPreview } from './htmlPreviewPolicy'

export type PreviewLinkReveal = { line: number; column?: number }

export type PreviewLinkDeps = {
  sessionId: string
  serverBaseUrl: string
  openBrowser: (sessionId: string, url: string) => void
  /** `reveal` carries the `:42` suffix through to the code view's scroll target. */
  openFilePreview: (sessionId: string, path: string, reveal?: PreviewLinkReveal) => void
  openSystemFile: (path: string) => void
  openExternal: (url: string) => void
}

/**
 * Build a `/preview-fs/<sessionId>/<path>` URL for the local server.
 *
 * Absolute file paths (leading slash) keep it, so the resulting URL carries a `//`
 * between `<sessionId>` and the path. That double slash is intentional: the server
 * slices everything after the `<sessionId>` segment and runs
 * `path.resolve(workDir, relPath)`, so an absolute path is resolved as an
 * absolute-within-workspace path and sandbox-checked against the work dir root.
 *
 * Each segment is escaped, as {@link localFileUrl} does, so the server decodes
 * exactly the name it was given. Left raw, a `%` or `#` in a name would be read as
 * URL syntax, and a name that spells a dot segment (`%2e%2e`) would be collapsed by
 * the URL parser before the request is sent — a request for `/api/status`, not a
 * file. A Windows path's backslashes are separators, as the browser already made
 * them.
 */
export function previewFsUrl(base: string, sessionId: string, filePath: string): string {
  const rooted = filePath.replace(/\\/g, '/').replace(/^\/+/, '/')
  const escaped = rooted.split('/').map((segment) => encodeURIComponent(segment)).join('/')
  return `${base.replace(/\/$/, '')}/preview-fs/${encodeURIComponent(sessionId)}/${escaped}`
}

/** True for POSIX absolute (`/...`) or Windows drive (`X:\` / `X:/`) paths. */
export function isAbsoluteLocalPath(p: string): boolean {
  return p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p)
}

/** Paths rooted outside the workspace, including the server-expanded home alias. */
export function isRootedLocalPath(p: string): boolean {
  return isAbsoluteLocalPath(p) || /^~(?:[\\/]|$)/.test(p)
}

/**
 * Build a `/local-file/<absolute-path>` URL for the local server so an absolute
 * file outside the session workspace can open in the in-app browser. Home aliases
 * (`~/...`) are expanded by the server before the same filesystem checks.
 *
 * The path is appended PATH-style (not as a query param) so relative asset URLs
 * inside served HTML resolve against the same directory. Each path segment is
 * `encodeURIComponent`-escaped (so spaces / unicode survive) while the `/`
 * separators are preserved. A Windows drive path (`C:\proj\page.html`) has its
 * backslashes normalized to `/`; the leading separator is always present so the
 * server can re-root the path.
 */
export function localFileUrl(base: string, absPath: string): string {
  const withForwardSlashes = absPath.replace(/\\/g, '/')
  const withLeadingSlash = withForwardSlashes.startsWith('/')
    ? withForwardSlashes
    : `/${withForwardSlashes}`
  const encoded = withLeadingSlash
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  return `${base.replace(/\/$/, '')}/local-file${encoded}`
}

/**
 * Build the `/api/filesystem/file` URL that serves one local image by absolute
 * (or `~/`) path. The server serves images only, and only from `$HOME`, the
 * temporary directories and the roots it has registered; anything else is a 403.
 */
export function filesystemImageUrl(base: string, filePath: string): string {
  return `${base.replace(/\/$/, '')}/api/filesystem/file?path=${encodeURIComponent(filePath)}`
}

/** Returns true if handled (caller should preventDefault). */
export function handlePreviewLink(href: PreviewLinkTarget, deps: PreviewLinkDeps): boolean {
  const cls = classifyPreviewLink(href)
  const reveal: PreviewLinkReveal | undefined = cls.line
    ? { line: cls.line, ...(cls.column ? { column: cls.column } : {}) }
    : undefined
  switch (cls.kind) {
    case 'browser-localhost':
      deps.openBrowser(deps.sessionId, cls.url!)
      return true
    case 'browser-file': {
      const filePath = cls.path!
      // Absolute and home-relative paths may live OUTSIDE the session
      // workspace, so serve them via the $HOME-sandboxed /local-file route.
      // Relative paths stay workspace-scoped via /preview-fs.
      if (!isRootedLocalPath(filePath) && !shouldOfferStaticHtmlPreview(filePath)) {
        deps.openFilePreview(deps.sessionId, filePath, reveal)
        return true
      }
      const url = isRootedLocalPath(filePath)
        ? localFileUrl(deps.serverBaseUrl, filePath)
        : previewFsUrl(deps.serverBaseUrl, deps.sessionId, filePath)
      deps.openBrowser(deps.sessionId, url)
      return true
    }
    case 'file-preview':
      deps.openFilePreview(deps.sessionId, cls.path!, reveal)
      return true
    case 'system-file':
      deps.openSystemFile(cls.path!)
      return true
    case 'remote':
      deps.openExternal(cls.url!)
      return true
    default:
      return false
  }
}
