import { filesystemImageUrl, isAbsoluteLocalPath, localFileUrl, previewFsUrl } from './handlePreviewLink'

/**
 * In-memory image sources are origin-bound or inline, so they are safe to keep
 * even in untrusted assistant Markdown. Everything else (relative paths,
 * http(s) URLs) is only allowed on trusted surfaces via
 * {@link createWorkspaceMarkdownImageResolver}.
 */
export function isSafeMarkdownImageSource(value: string | null): boolean {
  if (!value) return false
  if (/^blob:/i.test(value)) return true
  return /^data:image\/(?:avif|gif|jpe?g|png|webp);base64,[a-z0-9+/=\r\n]+$/i.test(value)
}

export type WorkspaceMarkdownImageContext = {
  /** Base URL of the local server (see `getServerBaseUrl`). */
  baseUrl: string
  sessionId: string
  /** Workspace-relative path of the Markdown file being previewed. */
  filePath: string
  /** Absolute session workspace root, when known. */
  workDir?: string | null
}

export type AssistantMarkdownImageContext = {
  aliases?: ReadonlyMap<string, string>
  /** Base URL of the local server (see `getServerBaseUrl`). */
  baseUrl: string
  sessionId: string
  /**
   * Absolute session workspace root, when known. It splits absolute paths in two:
   * inside it a picture is served by the session's own sandbox route; outside it,
   * by the filesystem route, which serves pictures from `$HOME` and the temp
   * directories. Unknown, every absolute path is tried on the session route.
   */
  workDir?: string | null
}

function splitPathSegments(value: string): string[] {
  return value.replace(/\\/g, '/').split('/')
}

/** What the filesystem route serves; it answers 400 to the rest, so asking is pointless. */
const LOCAL_IMAGE_NAME_RE = /^.+\.(?:png|jpe?g|gif|webp|avif|bmp|svg|ico)$/i

function isLocalImageName(path: string): boolean {
  return LOCAL_IMAGE_NAME_RE.test(path.slice(path.lastIndexOf('/') + 1))
}

/**
 * A local image path in the shapes an assistant writes one, collapsed: `.` and `..`
 * resolved lexically, separators forward. `drive` is `C:` as it was written.
 */
type LocalImagePath =
  | { root: 'relative'; segments: string[] }
  | { root: 'posix'; segments: string[] }
  | { root: 'home'; segments: string[] }
  | { root: 'drive'; drive: string; segments: string[] }

/**
 * `null` when a workspace-relative path climbs out of where it starts. The home
 * alias is expanded on the server, so leading parents must survive until then;
 * the server authorizes the resulting canonical path. Above an absolute root,
 * `..` stays at the root, as it does on disk.
 */
function parseLocalImagePath(value: string): LocalImagePath | null {
  const slashed = value.replace(/\\/g, '/')
  // The renderer writes `file:///C:/x` and `C:\x` as `/C:/x` (see
  // `normalizeMarkdownImageDestination`); a bare `C:/x` means the same.
  const drive = /^\/?([A-Za-z]:)(?:\/|$)/.exec(slashed)
  const home = slashed === '~' || slashed.startsWith('~/')
  const root = drive ? 'drive' : home ? 'home' : slashed.startsWith('/') ? 'posix' : 'relative'
  const body = drive ? slashed.slice(drive[0].length) : home ? slashed.slice(2) : slashed

  const segments: string[] = []
  for (const segment of body.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (segments.length > 0 && segments.at(-1) !== '..') segments.pop()
      else if (root === 'relative') return null
      // HOME is an alias, not an authorization root. ~/../../tmp can be allowed,
      // while an expanded path outside the server's roots is still rejected.
      else if (root === 'home') segments.push('..')
      continue
    }
    segments.push(segment)
  }
  if (segments.length === 0) return null

  return root === 'drive' ? { root, drive: drive![1]!, segments } : { root, segments }
}

function localImagePathString(path: LocalImagePath): string {
  const body = path.segments.join('/')
  switch (path.root) {
    case 'drive': return `${path.drive}/${body}`
    case 'posix': return `/${body}`
    case 'home': return `~/${body}`
    default: return body
  }
}

/** Whether `path` is `workDir` or below it. Windows paths compare without regard to case. */
function isInsideWorkDir(path: LocalImagePath, workDir: string): boolean {
  const root = parseLocalImagePath(workDir)
  if (!root || root.root !== path.root || root.segments.length > path.segments.length) return false
  const windows = root.root === 'drive' && path.root === 'drive'
  const same = windows
    ? (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
    : (a: string, b: string) => a === b
  if (root.root === 'drive' && path.root === 'drive' && !same(root.drive, path.drive)) return false
  return root.segments.every((segment, index) => same(segment, path.segments[index]!))
}

/** What the Markdown parser takes out of `\x`: a backslash before punctuation or a symbol. */
const MARKDOWN_ESCAPE = /\\([\p{P}\p{S}])/gu

/**
 * A Windows path as the author wrote it, where the parser has changed it. Markdown
 * lets a backslash escape the punctuation after it, so `C:\Users\me\.claude\a.png`
 * reaches the renderer as `C:\Users\me.claude\a.png`: right for a URL, wrong for a
 * path whose separator is that backslash. The text the author wrote is still in the
 * token's `raw`; it replaces the parsed destination only when un-escaping it gives
 * exactly that destination, so it can explain what the parser did but never invent
 * a path of its own.
 */
function windowsDestinationAsWritten(href: string, raw: string): string {
  const open = raw.indexOf('](')
  if (open < 0) return href
  const inner = raw.slice(open + 2, raw.endsWith(')') ? -1 : undefined)
  const written = /^\s*(?:<([^<>]*)>|(\S+))/.exec(inner)
  const candidate = written?.[1] ?? written?.[2]
  if (!candidate || !/^[A-Za-z]:\\/.test(candidate)) return href
  return candidate.replace(MARKDOWN_ESCAPE, '$1') === href ? candidate : href
}

/**
 * Rewrite the destinations of an image that cannot survive sanitization as written.
 *
 * DOMPurify drops a `src` that looks like it has a scheme it does not allow, and
 * `file:///C:/x.png` and `C:\x.png` both do (`file:`, and `C:` reads as a scheme).
 * Left alone, the image loses its source before any resolver sees it. Written as
 * `/C:/x.png` it is an ordinary rooted path, which the resolver reads as a Windows
 * drive path. Everything else is returned unchanged.
 *
 * Runs on the Markdown destination, before sanitization, so it is only ever handed
 * what the author wrote — never a value the renderer produced. `raw` is the whole
 * `![alt](destination)` the destination came from, for a Windows path the parser
 * altered (see {@link windowsDestinationAsWritten}).
 */
export function normalizeMarkdownImageDestination(parsedHref: string, raw = ''): string {
  const href = windowsDestinationAsWritten(parsedHref, raw)
  const fileUrl = /^file:\/\/(?:localhost)?(\/.*)$/i.exec(href)
  if (fileUrl) return fileUrl[1]!
  if (/^[A-Za-z]:[\\/]/.test(href)) return `/${href.replace(/\\/g, '/')}`
  return href
}

/**
 * Create an image resolver for finalized assistant prose.
 *
 * Unlike the trusted workspace-document resolver below, this accepts no network
 * URL at all — only local files, by three routes:
 *
 * - a relative path goes through the session-scoped `/preview-fs` route, which
 *   canonicalizes the target and rejects anything outside that session's workdir;
 * - an absolute path inside the workdir goes the same way, and needs no registered
 *   root to be readable;
 * - an absolute path outside it (`~/Pictures/chart.png`, `C:\Users\me\a.png`, a
 *   path in `/tmp`) goes through `/api/filesystem/file`, which serves images only
 *   and only from `$HOME`, the temp directories and registered roots. Anything
 *   else that is not a picture is not asked for.
 *
 * The caller must only attach this resolver after streaming finishes so an
 * unfinished path cannot trigger a request.
 */
export function createAssistantMarkdownImageResolver(
  context: AssistantMarkdownImageContext,
): (src: string) => string | null {
  return (src: string): string | null => {
    const trimmed = src.trim()
    if (!trimmed) return null
    if (isSafeMarkdownImageSource(trimmed)) return trimmed
    if (trimmed.startsWith('#') || trimmed.startsWith('//')) return null
    // A drive letter looks like a scheme; it is the one that is not.
    if (!/^[A-Za-z]:[\\/]/.test(trimmed) && /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null

    const withoutSuffix = trimmed.split('#')[0]!.split('?')[0]!
    let decoded = withoutSuffix
    try {
      decoded = decodeURIComponent(withoutSuffix)
    } catch {
      // A malformed escape cannot name a stable local file.
      return null
    }

    const path = parseLocalImagePath(context.aliases?.get(decoded) ?? decoded)
    if (!path) return null
    const local = localImagePathString(path)

    if (path.root === 'relative') return previewFsUrl(context.baseUrl, context.sessionId, local)
    // The session route reads paths under the workdir. A home path is never one it
    // could place, and one outside the workdir is not its to serve.
    const inSession = path.root !== 'home'
      && (context.workDir ? isInsideWorkDir(path, context.workDir) : true)
    if (inSession) return previewFsUrl(context.baseUrl, context.sessionId, local)
    return isLocalImageName(local) ? filesystemImageUrl(context.baseUrl, local) : null
  }
}

/**
 * The file on disk behind an image `src` that one of the resolvers produced, for
 * "open the original". Read back from the URL rather than from an attribute on the
 * element: an attribute would be a claim the page's own content can make.
 *
 * `null` for anything that is not a local file this app served — an inline
 * picture, another origin, or a workdir-relative URL when the workdir is unknown —
 * and for anything that is not a picture. The original is handed to the system's
 * default application, so a launcher or a document written as an image must not
 * get that far: a link to the same file would not be opened either. Nor does a path
 * that climbs (`a/../../b.png`, which a decoded `%2F` can spell); the file the URL
 * names is the one under the picture, never one above it.
 */
export function localPathFromMarkdownImageUrl(
  url: string,
  context: { baseUrl: string; workDir?: string | null },
): string | null {
  const path = localPathBehindUrl(url, context)
  if (path === null || !isLocalImageName(path)) return null
  if (splitPathSegments(path).some((segment) => segment === '.' || segment === '..')) return null
  return path
}

function localPathBehindUrl(
  url: string,
  context: { baseUrl: string; workDir?: string | null },
): string | null {
  let parsed: URL
  let base: URL
  try {
    parsed = new URL(url)
    base = new URL(context.baseUrl)
  } catch {
    return null
  }
  if (!/^https?:$/.test(parsed.protocol) || parsed.origin !== base.origin) return null

  const decode = (value: string): string | null => {
    try {
      return decodeURIComponent(value)
    } catch {
      return null
    }
  }

  const session = /^\/preview-fs\/[^/]+\/(.*)$/s.exec(parsed.pathname)
  if (session) {
    const rest = decode(session[1]!)
    if (rest === null || !rest) return null
    if (rest.startsWith('/') || /^[A-Za-z]:\//.test(rest)) return rest
    return context.workDir ? `${context.workDir.replace(/[\\/]+$/, '')}/${rest}` : null
  }

  if (parsed.pathname === '/api/filesystem/file') {
    return parsed.searchParams.get('path') || null
  }

  const local = /^\/local-file\/(.*)$/s.exec(parsed.pathname)
  if (local) {
    const rest = decode(local[1]!)
    if (rest === null || !rest) return null
    return rest === '~' || rest.startsWith('~/') || /^[A-Za-z]:\//.test(rest) ? rest : `/${rest}`
  }

  return null
}

/**
 * Create an `img src` resolver for trusted, user-owned Markdown documents (the
 * workspace file preview). Untrusted assistant output must NOT get a resolver —
 * the renderer then keeps only blob:/data: sources, which blocks tracking
 * pixels and loopback probes in model-generated text.
 *
 * Resolution rules, in order:
 *   1. `http(s)://` URLs pass through untouched (CSP `img-src` decides what
 *      actually loads: `https:` plus loopback `http:`).
 *   2. Safe inline sources (`blob:`, base64 `data:image/...`) pass through.
 *   3. Any other scheme (`javascript:`, `file:`, ...) is rejected, and bare
 *      fragments (`#...`) have no image to load.
 *   4. Absolute local paths (`/Users/x.png`, `C:/x.png`) go through the
 *      `$HOME`-sandboxed `/local-file/` route.
 *   5. Relative paths resolve against the Markdown file's directory and are
 *      served workspace-scoped via `/preview-fs/<sessionId>/...`. Paths that
 *      escape the workspace root (`../..`) fall back to `/local-file/` against
 *      the session `workDir` when it is known; without it they are rejected.
 */
export function createWorkspaceMarkdownImageResolver(
  context: WorkspaceMarkdownImageContext,
): (src: string) => string | null {
  return (src: string): string | null => {
    const trimmed = src.trim()
    if (!trimmed) return null
    if (/^https?:\/\//i.test(trimmed)) return trimmed
    if (isSafeMarkdownImageSource(trimmed)) return trimmed
    // Fragments-only refs and any remaining scheme (DOMPurify already strips
    // the dangerous ones; this is defense in depth) cannot be local files.
    if (trimmed.startsWith('#')) return null
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null

    // A query string or fragment on a local path is meaningless to the file
    // server — and would otherwise land inside the last encoded path segment.
    const withoutSuffix = trimmed.split('#')[0]!.split('?')[0]!
    let localPath = withoutSuffix
    try {
      localPath = decodeURIComponent(withoutSuffix)
    } catch {
      // Keep the raw path; a malformed escape simply 404s on the server.
    }

    if (isAbsoluteLocalPath(localPath)) {
      return localFileUrl(context.baseUrl, localPath)
    }

    const mdDir = splitPathSegments(context.filePath).slice(0, -1)
    const stack: string[] = []
    let escapes = 0
    for (const segment of [...mdDir, ...splitPathSegments(localPath)]) {
      if (!segment || segment === '.') continue
      if (segment === '..') {
        if (stack.length > 0) stack.pop()
        else escapes += 1
        continue
      }
      stack.push(segment)
    }

    if (escapes === 0) {
      return previewFsUrl(context.baseUrl, context.sessionId, stack.join('/'))
    }

    if (!context.workDir) return null
    const workDirSegments = splitPathSegments(context.workDir).filter(Boolean)
    const absolute = workDirSegments.slice(0, Math.max(0, workDirSegments.length - escapes))
    absolute.push(...stack)
    const isWindowsDrive = /^[a-zA-Z]:$/.test(absolute[0] ?? '')
    return localFileUrl(context.baseUrl, isWindowsDrive ? absolute.join('/') : `/${absolute.join('/')}`)
  }
}
