/**
 * Where a file path ends when it sits in prose, and what its line suffix means.
 *
 * This exists because we already promised it. `src/constants/prompts.ts` tells
 * the model:
 *
 *   > include the pattern `file_path:line_number` to allow the user to easily
 *   > navigate to the source code location
 *
 * The model has been holding up its end all along — the desktop app just
 * rendered those references as inert text (#1146).
 *
 * Boundaries work the opposite way from {@link ./urlBoundary}: a URL is matched
 * permissively and then trimmed, while a path segment is an *allow* list. Prose
 * punctuation, brackets and whitespace simply are not path characters, so a
 * sentence can never leak into a path the way it leaked into an href in #1145.
 * CJK letters ARE allowed — `文档/说明.md` is a real file — while CJK
 * punctuation is not.
 */

import { trimTrailingPunctuation } from './urlBoundary'

/**
 * Extensions we are willing to turn into links.
 *
 * This is the single source of truth: `previewLinkRouter` classifies against the
 * same set, so anything we underline in the prose is guaranteed to have a route
 * that can open it. Letting the two drift is how you get a link that looks live
 * and does nothing when clicked.
 */
export const LINKABLE_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  // web / js
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte', 'astro',
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'styl',
  // data / config
  'json', 'jsonc', 'json5', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf',
  'xml', 'plist', 'entitlements', 'properties', 'lock', 'csv', 'tsv',
  // docs
  'md', 'markdown', 'mdx', 'txt', 'rst', 'adoc', 'tex', 'log', 'pdf',
  'doc', 'docx', 'docm', 'odt', 'rtf', 'pages',
  'xls', 'xlsx', 'xlsm', 'ods', 'numbers',
  'ppt', 'pptx', 'pptm', 'odp', 'key',
  // scripts
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd',
  // languages
  'py', 'pyi', 'rb', 'php', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'groovy',
  'gradle', 'swift', 'dart', 'lua', 'pl', 'r', 'jl', 'ex', 'exs', 'erl', 'hs',
  'clj', 'cljs', 'cs', 'fs', 'vb', 'zig', 'nim', 'sol', 'sql', 'graphql', 'gql',
  'proto', 'prisma', 'asm',
  'c', 'cc', 'cpp', 'cxx', 'h', 'hh', 'hpp', 'm', 'mm', 's',
  // assets
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico',
  'mp3', 'wav', 'm4a', 'flac', 'aac', 'ogg', 'opus',
  'mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi',
  // archives
  'zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz',
  // vcs / build artifacts worth opening
  'patch', 'diff', 'snap', 'map',
])

/**
 * Extensions from the set above that only earn a link once a `/` (or a `./`,
 * `~/`, drive prefix) proves the reference really is a path.
 *
 * `console.log`, `array.map` and `logger.conf` are why: as a bare `foo.bar` they
 * read as property access far more often than as filenames. Note this list is a
 * SUBSET of the linkable set — an entry that is not linkable in the first place
 * would be dead config, which `filePathBoundary.test.ts` asserts against.
 *
 * `process.env` / `regex.test` need no entry here: `env` and `test` are not
 * linkable extensions at all (`.env` is matched as a dotfile instead).
 */
export const AMBIGUOUS_STANDALONE_EXTENSIONS: ReadonlySet<string> = new Set([
  'log', 'map', 'conf', 'cfg', 'properties',
  // single letters read as method names far more often than as filenames
  'c', 'h', 'm', 's', 'r',
])

/** Extension-less filenames that are unambiguously files. */
const LINKABLE_BARE_FILENAMES: ReadonlySet<string> = new Set([
  'Dockerfile', 'Makefile', 'Gemfile', 'Rakefile', 'Procfile', 'Vagrantfile',
  'Brewfile', 'Justfile', 'CODEOWNERS', 'LICENSE', 'NOTICE',
])

/** Leading-dot config files, matched by their first segment (`.env.local` → `.env`). */
const LINKABLE_DOTFILES: ReadonlySet<string> = new Set([
  '.env', '.gitignore', '.gitattributes', '.dockerignore', '.editorconfig',
  '.npmrc', '.nvmrc', '.prettierrc', '.eslintrc', '.babelrc', '.zshrc', '.bashrc',
])

/**
 * Characters allowed inside one path segment.
 *
 * Deliberately absent: whitespace, quotes, brackets, `:`/`#` (they open the line
 * suffix), `,`/`;`, and every full-width mark — those are the sentence, not the
 * path.
 *
 * CJK is absent on purpose too, which costs us `文档/说明.md`. Allowing it would
 * mean `修改了lib/foo.ts` — Chinese runs into a path with no space, constantly —
 * matches from `修` and drags the verb into the path. That is #1145's failure
 * mode pointed the other way, and a CJK *filename* is far rarer than CJK prose
 * sitting flush against an ASCII path.
 */
const SEGMENT_CHARS = String.raw`\w.\-@+`
const SEGMENT = `[${SEGMENT_CHARS}]+`
/** A path cannot begin mid-token: `ftp://x.com/a/b.ts` must not yield `x.com/a/b.ts`. */
const CONTINUES_PATH_RE = new RegExp(`[${SEGMENT_CHARS}/\\\\:]`)
const SEPARATOR = String.raw`[\/\\]`
const PREFIX = String.raw`(?:~${SEPARATOR}|\.{1,2}${SEPARATOR}|${SEPARATOR}|[A-Za-z]:${SEPARATOR})`

/**
 * `path:42`, `path:42:8`, `path#L42`, `path#L42-L60`, `path:L42`.
 *
 * GitHub's `#L` form is included because the model uses it when it has been
 * reading GitHub URLs, and `:L` shows up in tool output.
 */
const LINE_SUFFIX = String.raw`(?::(\d+)(?::(\d+))?|[#:]L(\d+)(?:-L?\d+)?)`

const FILE_PATH_SOURCE =
  `(?:${PREFIX})?(?:${SEGMENT}${SEPARATOR})*${SEGMENT}(?:${LINE_SUFFIX})?`

const ANCHORED_FILE_PATH_RE = new RegExp(`^${FILE_PATH_SOURCE}`)
const FILE_PATH_SCAN_RE = new RegExp(FILE_PATH_SOURCE, 'g')

export type FilePathRef = {
  /** Exactly what the prose said, line suffix included. Used for "copy path". */
  raw: string
  /** The path with the line suffix removed. */
  path: string
  line?: number
  column?: number
}

function extensionOf(path: string): string {
  const basename = path.split(/[\\/]/).pop() ?? ''
  const dot = basename.lastIndexOf('.')
  if (dot <= 0) return ''
  return basename.slice(dot + 1).toLowerCase()
}

function basenameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? ''
}

function hasPathShape(path: string): boolean {
  return /[\\/]/.test(path) || /^(?:~|\.{1,2})[\\/]/.test(path) || /^[A-Za-z]:[\\/]/.test(path)
}

/**
 * True when `path` names something we are willing to link.
 *
 * Shared with {@link ./previewLinkRouter} so recognition and routing cannot
 * disagree.
 */
export function isLinkableFilePath(path: string): boolean {
  if (!path) return false

  const basename = basenameOf(path)
  if (!basename) return false

  if (LINKABLE_BARE_FILENAMES.has(basename)) return true

  if (basename.startsWith('.')) {
    const dotName = `.${basename.slice(1).split('.')[0] ?? ''}`
    if (LINKABLE_DOTFILES.has(dotName)) return true
  }

  const ext = extensionOf(path)
  if (!ext || !LINKABLE_FILE_EXTENSIONS.has(ext)) return false

  // A bare `foo.log` is far more likely to be `logger.log` than a file.
  if (!hasPathShape(path) && AMBIGUOUS_STANDALONE_EXTENSIONS.has(ext)) return false

  return true
}

function buildRef(raw: string, match: RegExpExecArray): FilePathRef | null {
  const [, colonLine, colonColumn, anchorLine] = match
  const lineText = colonLine ?? anchorLine
  const suffixStart = lineText === undefined
    ? raw.length
    : raw.search(/(?::\d|[#:]L\d)/)
  const path = suffixStart >= 0 ? raw.slice(0, suffixStart) : raw

  if (!isLinkableFilePath(path)) return null

  const line = lineText ? Number.parseInt(lineText, 10) : undefined
  const column = colonColumn ? Number.parseInt(colonColumn, 10) : undefined

  return {
    raw,
    path,
    ...(line && Number.isFinite(line) ? { line } : {}),
    ...(column && Number.isFinite(column) ? { column } : {}),
  }
}

/**
 * Match a file path anchored at the start of `src`, or null when `src` does not
 * open with one.
 *
 * Trailing sentence punctuation is trimmed before the path is validated, so
 * `见 lib/foo.ts。` yields `lib/foo.ts` — but only after the trim, because
 * `foo.ts.` must not lose the `.ts` that makes it a file.
 */
export function matchFilePath(src: string): FilePathRef | null {
  const match = ANCHORED_FILE_PATH_RE.exec(src)
  if (!match) return null

  const trimmed = trimTrailingPunctuation(match[0])
  if (!trimmed) return null

  // Re-run against the trimmed text so the captured line suffix belongs to what
  // we actually return (`foo.ts:42.` must not report a line of `42.`).
  const reMatch = ANCHORED_FILE_PATH_RE.exec(trimmed)
  if (!reMatch || reMatch[0] !== trimmed) return null

  return buildRef(trimmed, reMatch)
}

/**
 * `owner/repo#123` → the GitHub issue/PR it names.
 *
 * The other half of the same promise: `src/constants/prompts.ts` tells the model
 * to use this form "so they render as clickable links", and until #1146 nothing
 * rendered them at all.
 *
 * Guarded against colliding with a path: a repo name cannot end in a linkable
 * extension, and `#L42` is not `#\d+`, so `src/app.ts#L42` stays a file.
 */
const GITHUB_REF_RE = /^([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*)#(\d{1,9})(?![\w-])/

export type GitHubRef = { raw: string; owner: string; repo: string; number: number; url: string }

export function matchGitHubRef(src: string): GitHubRef | null {
  const match = GITHUB_REF_RE.exec(src)
  if (!match) return null

  const [raw, owner, repo, number] = match as unknown as [string, string, string, string]
  // `foo/bar.ts#12` is a file with an odd anchor, not a repository reference.
  if (isLinkableFilePath(`${owner}/${repo}`)) return null

  return {
    raw,
    owner,
    repo,
    number: Number.parseInt(number, 10),
    url: `https://github.com/${owner}/${repo}/issues/${number}`,
  }
}

export type FilePathSegment =
  | { type: 'text'; value: string }
  | { type: 'path'; value: string; ref: FilePathRef }
  | { type: 'github'; value: string; ref: GitHubRef }

/**
 * Split prose into text and file-path segments.
 *
 * Runs over the text nodes of already-rendered markdown rather than through a
 * marked tokenizer, for two reasons. It can be skipped entirely while a reply is
 * still streaming — a bare path has no closing delimiter, so a partially typed
 * `desktop/src/lib/foo.ts` would light up as a link and then have to change
 * twice more as `x` and `:42` arrive. And by the time the DOM exists, URLs are
 * already anchors, so the `github.com/a/b.ts` inside an href can never be
 * re-matched as a path.
 */
export function splitTextByFilePaths(text: string): FilePathSegment[] {
  const segments: FilePathSegment[] = []
  let cursor = 0

  FILE_PATH_SCAN_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = FILE_PATH_SCAN_RE.exec(text)) !== null) {
    const start = match.index
    if (start < cursor) {
      FILE_PATH_SCAN_RE.lastIndex = cursor
      continue
    }

    const previous = start > 0 ? text.charAt(start - 1) : ''
    const rest = text.slice(start)
    // `owner/repo#123` first: it starts like a path, and the scan regex would
    // otherwise stop at `repo` and reject it for having no extension.
    const found = previous && CONTINUES_PATH_RE.test(previous)
      ? null
      : matchGitHubRef(rest) ?? matchFilePath(rest)
    if (!found) {
      FILE_PATH_SCAN_RE.lastIndex = start + Math.max(1, match[0].length)
      continue
    }

    if (start > cursor) {
      segments.push({ type: 'text', value: text.slice(cursor, start) })
    }
    segments.push(
      'url' in found
        ? { type: 'github', value: found.raw, ref: found }
        : { type: 'path', value: found.raw, ref: found },
    )
    cursor = start + found.raw.length
    FILE_PATH_SCAN_RE.lastIndex = cursor
  }

  if (cursor < text.length) {
    segments.push({ type: 'text', value: text.slice(cursor) })
  }

  return segments
}

/**
 * Parse a reference that is already known to be one — the href/data attribute
 * round-trip, and inline code spans.
 *
 * Unlike {@link matchFilePath} this requires the WHOLE value to be the path, so
 * `` `curl foo.ts` `` stays a command instead of becoming a link.
 */
export function parseFilePathRef(value: string): FilePathRef | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const ref = matchFilePath(trimmed)
  return ref && ref.raw === trimmed ? ref : null
}

/** True when `value` is nothing but a single file reference (used for inline code). */
export function isFilePathOnly(value: string): boolean {
  return parseFilePathRef(value) !== null
}
