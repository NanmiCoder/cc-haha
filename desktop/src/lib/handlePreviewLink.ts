import { getServerBaseUrl } from './desktopRuntime'
import { classifyPreviewLink } from './previewLinkRouter'
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
 * Absolute file paths (leading slash) are preserved as-is, so the resulting URL
 * carries a `//` between `<sessionId>` and the path. That double slash is
 * intentional: the server slices everything after the `<sessionId>` segment and
 * runs `path.resolve(workDir, relPath)`, so an absolute path is resolved as an
 * absolute-within-workspace path and sandbox-checked against the work dir root.
 */
export function previewFsUrl(base: string, sessionId: string, filePath: string): string {
  return `${base.replace(/\/$/, '')}/preview-fs/${encodeURIComponent(sessionId)}/${filePath.replace(/^\/+/, '/')}`
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
 * Save a file by pointing an anchor at the local server's
 * `/local-file/<abs-path>?download=1` route.
 *
 * A click on an anchor is a navigation, not a fetch. The browser sends no Origin
 * header with it, so the request reaches the server on the no-Origin path every
 * other navigation uses and the file is served with its Content-Disposition
 * intact. This is the only shape that works from the packaged renderer, whose
 * page is `file://`: an opaque origin can neither pass a CORS check (the fetch
 * path attaches `Origin: null`, which the server refuses) nor download a `blob:`
 * URL it minted itself. Routing the bytes through `apiGetBlob` — and later through
 * a main-process copy — is what reduced a working download to a click that did
 * nothing.
 *
 * @returns whether the download was initiated.
 */
export function downloadLocalFile(absolutePath: string): boolean {
  const url = `${localFileUrl(getServerBaseUrl(), absolutePath)}?download=1`
  const anchor = document.createElement('a')
  anchor.href = url
  // The server's Content-Disposition names a cross-origin save; this names it for
  // the same-origin case (the in-app browser) too.
  anchor.download = fileNameFromPath(absolutePath)
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  return true
}

/** Last path segment, for the download's suggested save name. */
export function fileNameFromPath(filePath: string): string {
  const segments = filePath.split(/[\\/]/).filter((segment) => segment.length > 0)
  return segments[segments.length - 1] ?? ''
}

/** Returns true if handled (caller should preventDefault). */
export function handlePreviewLink(href: string, deps: PreviewLinkDeps): boolean {

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
