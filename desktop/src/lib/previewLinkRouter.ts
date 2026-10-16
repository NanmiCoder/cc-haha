import { isLoopbackHostname } from './desktopRuntime'
import { isLinkableFilePath, parseFileHref, type FilePathRef } from './filePathBoundary'
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

/** A parsed filesystem path is literal; only an href string is URL-decoded. */
export type PreviewFileRef = Pick<FilePathRef, 'path' | 'line' | 'column'>
export type PreviewLinkTarget = string | PreviewFileRef

/** POSIX absolute (`/…`) or Windows drive (`X:\` / `X:/`). */
const DRIVE_PATH_RE = /^[a-zA-Z]:[\\/]/

function extOf(p: string): string {
  const m = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(p)
  const g = m?.[1]
  return g ? g.toLowerCase() : ''
}

/**
 * A link destination is URL-encoded: `[笔记](docs/My%20Notes.md)` is how
 * CommonMark spells a space, and the file on disk is `My Notes.md` (#1556).
 * Malformed escapes (`100%.md`) can only be the name as written.
 */
function decodeHrefPath(path: string): string {
  if (!path.includes('%')) return path
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

function classifyParsedFileRef(ref: PreviewFileRef): PreviewLinkClass {
  // Recognition and routing share the extension gate, so a rendered file link
  // always has a route (the missing .yml/.ps1 routes caused #1146).
  if (!isLinkableFilePath(ref.path)) return { kind: 'ignored' }
  // Data attributes must never turn an unsafe URL scheme into a local file.
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref.path) && !DRIVE_PATH_RE.test(ref.path)) return { kind: 'ignored' }
  const path = ref.path
  const position = {
    ...(ref.line ? { line: ref.line } : {}),
    ...(ref.column ? { column: ref.column } : {}),
  }
  const ext = extOf(path)

  // HTML renders, so it belongs in a browser surface. Everything else opens in
  // the workspace code view — the only surface that can scroll to a line, which
  // is the whole point of the `file_path:line_number` reference format.
  if (ext === 'html' || ext === 'htm') return { kind: 'browser-file', path, ...position }

  return isWorkspacePreviewableFile(path)
    ? { kind: 'file-preview', path, ...position }
    : { kind: 'system-file', path, ...position }
}

function classifyFileHref(raw: string): PreviewLinkClass {
  const ref = parseFileHref(raw)
  return ref ? classifyParsedFileRef({ ...ref, path: decodeHrefPath(ref.path) }) : { kind: 'ignored' }
}

export function classifyPreviewLink(href: PreviewLinkTarget): PreviewLinkClass {
  if (typeof href !== 'string') return classifyParsedFileRef(href)
  const raw = href.trim()
  if (!raw || raw.startsWith('#')) return { kind: 'ignored' }

  // Before `new URL`: a Windows path parses as a URL whose protocol is the drive
  // letter (`C:\src\app.ts` → `c:`), so it used to fall through to `ignored` and
  // every path link was dead on Windows — the platform #1146 was filed from.
  if (DRIVE_PATH_RE.test(raw)) return classifyFileHref(raw)

  try {
    const u = new URL(raw)
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      return isLoopbackHostname(u.hostname)
        ? { kind: 'browser-localhost', url: u.toString() }
        : { kind: 'remote', url: u.toString() }
    }
    if (u.protocol === 'file:') {
      // Keep the line suffix separate before decoding, so an encoded # in a
      // filename cannot be mistaken for the suffix. Windows file URLs include
      // an extra leading slash before the drive letter.
      const pathname = u.pathname.replace(/^\/(?=[A-Za-z]:[\\/])/, '')
      const lineSuffix = /^#L\d+(?:-L?\d+)?$/.test(u.hash) ? u.hash : ''
      return classifyFileHref(`${pathname}${lineSuffix}`)
    }
    return { kind: 'ignored' }
  } catch {
    // not an absolute URL → treat as a path
  }

  return classifyFileHref(raw)
}
