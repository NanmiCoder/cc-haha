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
 *
 * CJK letters are the one place the two entry points disagree on purpose. The
 * prose scanner excludes them (`修改了lib/foo.ts` must match from `lib`, not
 * from `修`), while {@link parseFilePathRef} — an href we generated ourselves,
 * a backtick-quoted span — accepts them, because `README-拍摄大纲.md` is a real
 * file the turn really wrote and its delimiter is the span, not the sentence.
 * When the ASCII match is recognisably the tail of a CJK name (`测试文档1.docx`),
 * the prose scanner widens it to the whole token — see
 * {@link widenAcrossUnicodeLetters}. A name with no ASCII part at all
 * (`开题报告.docx`) reads exactly like prose about formats, so it is never linked
 * here; {@link findUnicodeExtensionNames} offers it to callers that check the disk.
 * CJK *punctuation* is excluded in both — it is sentence material either way.
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
 * Characters allowed inside one path segment *while scanning prose*.
 *
 * Deliberately absent: whitespace, quotes, brackets, `:`/`#` (they open the line
 * suffix), `,`/`;`, and every full-width mark — those are the sentence, not the
 * path.
 *
 * CJK is absent here on purpose: allowing it would mean `修改了lib/foo.ts` —
 * Chinese runs into a path with no space, constantly — matches from `修` and
 * drags the verb into the path. That is #1145's failure mode pointed the other
 * way, and in *prose* a CJK filename is far rarer than CJK sitting flush
 * against an ASCII path. Whole-string references use FULLREF_SEGMENT instead.
 */
const SEGMENT_CHARS = String.raw`\w.\-@+`
const SEGMENT = `[${SEGMENT_CHARS}]+`
/** A path cannot begin mid-token: `ftp://x.com/a/b.ts` must not yield `x.com/a/b.ts`. */
const CONTINUES_PATH_RE = new RegExp(`[${SEGMENT_CHARS}/\\\\:]`)
const SEPARATOR = String.raw`[\/\\]`
const PREFIX = String.raw`(?:~${SEPARATOR}|\.{1,2}${SEPARATOR}|${SEPARATOR}|[A-Za-z]:${SEPARATOR})`

/**
 * Segment characters for a reference that is *already known to be one* — an
 * href the app itself generated, or a backtick-quoted code span. The delimiter
 * is the markdown, not the sentence, so the prose-bleed concern above does not
 * apply and Unicode letters/digits are allowed: `README-拍摄大纲.md` and
 * `文档/说明.md` are real files a turn really writes, and rejecting them made
 * their output cards and "Open with" menus silently dead.
 */
const FULLREF_SEGMENT = String.raw`[\p{L}\p{N}_.\-@+]+`

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

const FULLREF_PATH_SOURCE =
  `(?:${PREFIX})?(?:${FULLREF_SEGMENT}${SEPARATOR})*${FULLREF_SEGMENT}(?:${LINE_SUFFIX})?`

const ANCHORED_FULLREF_PATH_RE = new RegExp(`^${FULLREF_PATH_SOURCE}`, 'u')

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
function matchPath(src: string, anchoredRe: RegExp): FilePathRef | null {
  const match = anchoredRe.exec(src)
  if (!match) return null

  const trimmed = trimTrailingPunctuation(match[0])
  if (!trimmed) return null

  // Re-run against the trimmed text so the captured line suffix belongs to what
  // we actually return (`foo.ts:42.` must not report a line of `42.`).
  const reMatch = anchoredRe.exec(trimmed)
  if (!reMatch || reMatch[0] !== trimmed) return null

  return buildRef(trimmed, reMatch)
}

export function matchFilePath(src: string): FilePathRef | null {
  return matchPath(src, ANCHORED_FILE_PATH_RE)
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

    const widened = 'url' in found ? null : widenAcrossUnicodeLetters(text, start, found, cursor)
    const pathStart = widened?.start ?? start
    const ref = widened?.ref ?? found

    if (pathStart > cursor) {
      segments.push({ type: 'text', value: text.slice(cursor, pathStart) })
    }
    segments.push(
      'url' in ref
        ? { type: 'github', value: ref.raw, ref }
        : { type: 'path', value: ref.raw, ref },
    )
    cursor = pathStart + ref.raw.length
    FILE_PATH_SCAN_RE.lastIndex = cursor
  }

  if (cursor < text.length) {
    segments.push({ type: 'text', value: text.slice(cursor) })
  }

  return segments
}

const UNICODE_LETTER_RE = /[^\x00-\x7F]/
const IS_UNICODE_WORD_RE = /[\p{L}\p{N}]/u
const TOKEN_CHAR_RE = /[\p{L}\p{N}_.\-@+/\\~]/u

/**
 * The ASCII scan stops at the first CJK letter, so a match flush against one is
 * either a path glued to a CJK verb (`修改了lib/foo.ts`, keep it) or the ASCII
 * tail of a CJK name (`测试文档1.docx` → `1.docx`, #1423). A tail is recognisable:
 * it opens with a digit or symbol, sits in a later segment of the token
 * (`资料/测试文档v1.docx`), or is a lone `/name` cut from a relative path
 * (`资料/report.docx`). Then the whole whitespace/punctuation-bounded token is
 * read with the Unicode segment set, and used only if it is one linkable path
 * ending exactly where the ASCII match did.
 *
 * A verb glued to a name that opens with an ASCII letter (`报告v2.docx`) stays
 * ambiguous with `修改了foo.ts`, and is left as the ASCII match.
 */
function widenAcrossUnicodeLetters(
  text: string,
  start: number,
  found: FilePathRef,
  floor: number,
): { start: number; ref: FilePathRef } | null {
  const previous = start > 0 ? text.charAt(start - 1) : ''
  if (!UNICODE_LETTER_RE.test(previous) || !IS_UNICODE_WORD_RE.test(previous)) return null

  let tokenStart = start
  while (tokenStart > floor && TOKEN_CHAR_RE.test(text.charAt(tokenStart - 1))) tokenStart -= 1
  // A drive root: `:` is not a token character, but `D:` opens the path.
  if (
    tokenStart - 2 >= floor
    && text.charAt(tokenStart - 1) === ':'
    && /[A-Za-z]/.test(text.charAt(tokenStart - 2))
    && (tokenStart - 2 === floor || !TOKEN_CHAR_RE.test(text.charAt(tokenStart - 3)))
  ) {
    tokenStart -= 2
  }

  const leading = text.slice(tokenStart, start)
  const rooted = /^(?:~|\.{1,2})?[\\/]|^[A-Za-z]:[\\/]/.test(leading)
  const startsAtSeparator = /^[\\/]/.test(found.raw)
  const isTail = rooted
    || /[\\/]/.test(leading)
    || /^[\d_.\-@+]/.test(found.raw)
    || (startsAtSeparator && (found.path.match(/[\\/]/g)?.length ?? 0) === 1)
  if (!isTail) return null

  const end = start + found.raw.length
  const ref = parseFilePathRef(text.slice(tokenStart, end))
  return ref && ref.raw.length === end - tokenStart ? { start: tokenStart, ref } : null
}

export type UnicodeExtensionName = { start: number; end: number; ref: FilePathRef }

/**
 * Names made only of non-ASCII letters and an extension: `开题报告.docx`.
 *
 * The prose scan never links these, because their text is the same as prose
 * about formats — `只支持后缀为.docx的文件`, `另存为.pdf格式`. They are returned
 * for a caller that can confirm them against the disk before showing anything.
 * A name with an ASCII part in front of the dot (`测试文档1.docx`) is the prose
 * scan's to read.
 */
export function findUnicodeExtensionNames(text: string): UnicodeExtensionName[] {
  const names: UnicodeExtensionName[] = []
  let floor = 0

  for (const match of text.matchAll(/\.[A-Za-z0-9]+(?![A-Za-z0-9_])/g)) {
    const start = match.index ?? 0
    if (start < floor) continue
    const previous = start > 0 ? text.charAt(start - 1) : ''
    if (!UNICODE_LETTER_RE.test(previous) || !IS_UNICODE_WORD_RE.test(previous)) continue

    const widened = widenAcrossUnicodeLetters(text, start, { raw: match[0], path: match[0] }, floor)
    if (!widened || 'url' in widened.ref) continue
    const end = widened.start + widened.ref.raw.length
    names.push({ start: widened.start, end, ref: widened.ref })
    floor = end
  }

  return names
}

const CANDIDATE_STOP_RE = /[\n\r|`*"'<>:：,，.。;；、!！?？“”‘’「」『』《》\[\]\\/]/
const CANDIDATE_REACH = 60

/**
 * Every name a bare file mention in prose may really be, longest first, for a
 * caller that can check them against the disk.
 *
 * Text alone cannot settle `报告v2.docx` (verb glued to `v2.docx`, or one CJK
 * name?), `测试文档1.docx和测试文档2.docx` (where does the second start?) or
 * `毕业设计（论文）任务书 张三.docx` (spaces and full-width brackets are sentence
 * material in the scan). So this widens leftwards across spaces and brackets up
 * to a sentence mark, a line, `floor` or {@link CANDIDATE_REACH} characters, and
 * trims rightwards at each CJK boundary inside the name. The extension never
 * moves, and the mention itself (`start`..`end`) is not listed.
 */
export function bareNameCandidates(text: string, start: number, end: number, floor: number): string[] {
  const name = text.slice(start, end)
  const dot = name.lastIndexOf('.')
  if (dot <= 0 && !name.startsWith('.')) return []

  let left = start
  const reach = Math.max(floor, start - CANDIDATE_REACH)
  while (left > reach && !CANDIDATE_STOP_RE.test(text.charAt(left - 1))) left -= 1

  const candidates: string[] = []
  for (let i = left; i < start; i += 1) {
    if (!/\s/.test(text.charAt(i))) candidates.push(text.slice(i, end))
  }
  for (let i = start + 1; i < start + Math.max(dot, 0); i += 1) {
    if (UNICODE_LETTER_RE.test(text.charAt(i - 1)) && !/\s/.test(text.charAt(i))) {
      candidates.push(text.slice(i, end))
    }
  }
  return candidates
}

/**
 * Parse a reference that is already known to be one — the href/data attribute
 * round-trip, and inline code spans.
 *
 * Unlike {@link matchFilePath} this requires the WHOLE value to be the path, so
 * `` `curl foo.ts` `` stays a command instead of becoming a link. And because
 * the boundary is the markdown span rather than the sentence, it runs on the
 * Unicode-tolerant FULLREF segment set: `` `README-拍摄大纲.md` `` is a file.
 */
export function parseFilePathRef(value: string): FilePathRef | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const ref = matchPath(trimmed, ANCHORED_FULLREF_PATH_RE)
  return ref && ref.raw === trimmed ? ref : null
}

/** True when `value` is nothing but a single file reference (used for inline code). */
export function isFilePathOnly(value: string): boolean {
  return parseFilePathRef(value) !== null
}
