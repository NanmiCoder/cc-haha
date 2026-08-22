import { isLoopbackHostname } from './desktopRuntime'
import { parseFilePathRef } from './filePathBoundary'
import { isWorkspacePreviewableFile } from './fileCapabilities'

export type PreviewLinkKind =
  | 'browser-localhost'
  | 'browser-file'
  | 'file-preview'
  | 'system-file'
  | 'remote'
  | 'ignored'

export type PreviewLinkClass = {
  kind: PreviewLinkKind
  path?: string
  url?: string
  /** 1-based line to reveal, parsed from a `:42` / `#L42` suffix. */
  line?: number
  column?: number
}

/** POSIX absolute (`/…`) or Windows drive (`X:\` / `X:/`). */
const DRIVE_PATH_RE = /^[a-zA-Z]:[\\/]/

function extOf(p: string): string {
  const m = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(p)
  const g = m?.[1]
  return g ? g.toLowerCase() : ''
}

function classifyFileRef(raw: string): PreviewLinkClass {
  // The extension gate lives in filePathBoundary so that whatever the prose
  // renders as a link is guaranteed to have a route here. Before #1146 this
  // module kept its own shorter list, which is why `.yml` and `.ps1` links
  // resolved to `ignored` and clicking them did nothing at all.
  const ref = parseFilePathRef(raw)
  if (!ref) return { kind: 'ignored' }

  const position = {
    ...(ref.line ? { line: ref.line } : {}),
    ...(ref.column ? { column: ref.column } : {}),
  }
  const ext = extOf(ref.path)

  // HTML renders, so it belongs in a browser surface. Everything else opens in
  // the workspace code view — the only surface that can scroll to a line, which
  // is the whole point of the `file_path:line_number` reference format.
  if (ext === 'html' || ext === 'htm') return { kind: 'browser-file', path: ref.path, ...position }

  return isWorkspacePreviewableFile(ref.path)
    ? { kind: 'file-preview', path: ref.path, ...position }
    : { kind: 'system-file', path: ref.path, ...position }
}

export function classifyPreviewLink(href: string): PreviewLinkClass {
  const raw = href.trim()
  if (!raw || raw.startsWith('#')) return { kind: 'ignored' }

  // Before `new URL`: a Windows path parses as a URL whose protocol is the drive
  // letter (`C:\src\app.ts` → `c:`), so it used to fall through to `ignored` and
  // every path link was dead on Windows — the platform #1146 was filed from.
  if (DRIVE_PATH_RE.test(raw)) return classifyFileRef(raw)

  try {
    const u = new URL(raw)
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      return isLoopbackHostname(u.hostname)
        ? { kind: 'browser-localhost', url: u.toString() }
        : { kind: 'remote', url: u.toString() }
    }
    if (u.protocol === 'file:') {
      return classifyFileRef(decodeURIComponent(u.pathname))
    }
    return { kind: 'ignored' }
  } catch {
    // not an absolute URL → treat as a path
  }

  return classifyFileRef(raw)
}
