import { resolveAssistantFileHref } from './assistantFileContext'
import { trimTrailingPunctuation } from './urlBoundary'
import { isLinkableFilePath, parseFilePathRef, splitTextByFilePaths } from './filePathBoundary'
import { isGeneratedArtifactFile, isOutputResourceFile, isShellProducedDeliverable } from './fileCapabilities'

export type AssistantOutputTargetKind =
  | 'local-html'
  | 'localhost-url'
  | 'image'
  | 'video'
  | 'markdown'
  | 'file'

export type AssistantOutputTargetSource =
  | 'markdown-link'
  | 'plain-url'
  | 'plain-path'
  | 'changed-file'

export type AssistantOutputTarget = {
  id: string
  kind: AssistantOutputTargetKind
  title: string
  subtitle?: string
  href: string
  normalizedPath?: string
  confidence: 'high'
  source: AssistantOutputTargetSource
}

export type ExtractAssistantOutputTargetOptions = {
  workDir?: string | null
  limit?: number
  /**
   * The turn's REAL changed files (absolute paths from the turn checkpoint). When
   * provided, file chips are reconciled against this ground truth: a mentioned
   * file is corrected to the actual changed path (so `index.html` resolves to the
   * `todo-app/index.html` that was really written), and a mentioned source file
   * that the turn never changed is dropped instead of pointing at a non-existent
   * path. A mentioned *document deliverable* survives an unmatched lookup, because
   * the checkpoint cannot see files a shell command wrote.
   * Localhost URLs are unaffected. Omitted → fall back to text-only behavior;
   * an empty array provides no evidence for source-like mentions, but cannot disprove shell outputs.
   */
  changedFiles?: string[]
  /**
   * Whether generated artifacts from changedFiles may be appended when the prose
   * did not mention them. Reconciliation still runs when false. Defaults to true.
   */
  includeChangedFileFallback?: boolean
}

type FileTargetMatch = {
  kind: Exclude<AssistantOutputTargetKind, 'localhost-url'>
  normalizedPath: string
}

type LocalhostTargetMatch = {
  kind: 'localhost-url'
  href: string
}

type CandidateTarget = {
  key: string
  position: number
  order: number
  target: AssistantOutputTarget
}

type MarkdownLinkMatch = {
  title: string
  href: string
  isImage: boolean
  start: number
  end: number
}

type FencedCodeBlock = {
  start: number
  end: number
  contentStart: number
  text: string
}

type DirectoryTreeFileMatch = {
  href: string
  position: number
}

// Stays localhost-only on purpose: cards are for the dev server / local output,
// not for every remote link the assistant mentions. The tail is handed to the
// shared trimTrailingPunctuation, which knows the full CJK terminator set.
const localhostUrlPattern =
  /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/[^\s`"'<>，。；、）\])}]*)?/gi

export function extractAssistantOutputTargets(
  content: string,
  options: ExtractAssistantOutputTargetOptions = {},
): AssistantOutputTarget[] {
  const workDir = options.workDir ? resolveFilePath(options.workDir) : null
  const limit = options.limit ?? 6
  const candidates: CandidateTarget[] = []
  const results: AssistantOutputTarget[] = []
  const seen = new Set<string>()
  const markdownLinks = extractMarkdownLinks(content)
  const codeBlocks = extractFencedCodeBlocks(content)
  let order = 0

  const queueTarget = (target: AssistantOutputTarget, key: string, position: number) => {
    candidates.push({
      key,
      position,
      order,
      target,
    })
    order += 1
  }

  for (const match of markdownLinks) {
    const authoredTitle = match.title
    const href = resolveAssistantFileHref(match.href, content)
    const localhostTarget = toLocalhostTarget(href)
    const fileTarget = toWorkspaceFileTarget(href, workDir)

    if (isInCodeBlock(match.start, codeBlocks)) {
      continue
    }

    if (!authoredTitle && !(match.isImage && fileTarget?.kind === 'image')) {
      continue
    }

    if (localhostTarget) {
      queueTarget({
        id: createId(localhostTarget.kind, localhostTarget.href),
        kind: localhostTarget.kind,
        title: authoredTitle,
        href: localhostTarget.href,
        confidence: 'high',
        source: 'markdown-link',
      }, createLocalhostKey(localhostTarget.href), match.start)
      continue
    }

    if (!fileTarget) {
      continue
    }

    const title = authoredTitle || getBasename(fileTarget.normalizedPath)

    queueTarget({
      id: createId(fileTarget.kind, fileTarget.normalizedPath),
      kind: fileTarget.kind,
      title,
      subtitle: fileTarget.normalizedPath,
      href,
      normalizedPath: fileTarget.normalizedPath,
      confidence: 'high',
      source: 'markdown-link',
    }, createFileKey(fileTarget), match.start)
  }

  for (const match of content.matchAll(localhostUrlPattern)) {
    const position = match.index ?? 0

    if (isInMarkdownLink(position, markdownLinks)) {
      continue
    }

    if (isInCodeBlock(position, codeBlocks)) {
      continue
    }

    const href = trimTrailingPunctuation(match[0] ?? '')

    if (!href) {
      continue
    }

    queueTarget({
      id: createId('localhost-url', href),
      kind: 'localhost-url',
      title: href,
      href,
      confidence: 'high',
      source: 'plain-url',
    }, createLocalhostKey(href), position)
  }

  for (const treeMatch of extractDirectoryTreeFileMatches(codeBlocks)) {
    const fileTarget = toWorkspaceFileTarget(treeMatch.href, workDir)

    if (!fileTarget) {
      continue
    }

    queueTarget({
      id: createId(fileTarget.kind, fileTarget.normalizedPath),
      kind: fileTarget.kind,
      title: getBasename(fileTarget.normalizedPath),
      subtitle: fileTarget.normalizedPath,
      href: treeMatch.href,
      normalizedPath: fileTarget.normalizedPath,
      confidence: 'high',
      source: 'plain-path',
    }, createFileKey(fileTarget), treeMatch.position)
  }

  const queuePlainPath = (path: string, position: number) => {
    const href = resolveAssistantFileHref(path, content)
    const fileTarget = toWorkspaceFileTarget(href, workDir)

    if (!fileTarget) {
      return
    }

    queueTarget({
      id: createId(fileTarget.kind, fileTarget.normalizedPath),
      kind: fileTarget.kind,
      title: getBasename(fileTarget.normalizedPath),
      subtitle: fileTarget.normalizedPath,
      href,
      normalizedPath: fileTarget.normalizedPath,
      confidence: 'high',
      source: 'plain-path',
    }, createFileKey(fileTarget), position)
  }

  // A code span is bounded by its backticks, not by the sentence, so a name in
  // one is read whole — CJK included, as the rendered chip does. The prose scan
  // below leaves CJK out on purpose (`修改了lib/foo.ts` must not swallow the
  // verb), and run over `开题报告2.docx` it kept only `2.docx`.
  const codeSpans = extractInlineCodeSpans(content, codeBlocks)
  for (const span of codeSpans) {
    if (isInMarkdownLink(span.start, markdownLinks)) {
      continue
    }

    queuePlainPath(span.ref.path, span.start)
  }

  let plainTextPosition = 0
  for (const segment of splitTextByFilePaths(content)) {
    const position = plainTextPosition
    plainTextPosition += segment.value.length

    if (segment.type !== 'path') {
      continue
    }

    if (isInMarkdownLink(position, markdownLinks)) {
      continue
    }

    if (isInCodeBlock(position, codeBlocks)) {
      continue
    }

    if (codeSpans.some((span) => position >= span.start && position < span.end)) {
      continue
    }

    queuePlainPath(segment.ref.path, position)
  }

  candidates.sort((left, right) => {
    if (left.position !== right.position) {
      return left.position - right.position
    }

    return left.order - right.order
  })

  for (const candidate of candidates) {
    if (options.changedFiles === undefined && results.length >= limit) {
      break
    }
    if (seen.has(candidate.key)) {
      continue
    }

    seen.add(candidate.key)
    results.push(candidate.target)
  }

  if (options.changedFiles !== undefined) {
    return reconcileTargetsWithChangedFiles(
      results,
      options.changedFiles,
      workDir,
      limit,
      options.includeChangedFileFallback !== false,
    )
  }

  return results
}

/** Markdown-authored images already have a position inside the prose. */
export function extractMarkdownImageSources(content: string): string[] {
  const codeBlocks = extractFencedCodeBlocks(content)
  return extractMarkdownLinks(content)
    .filter((match) => match.isImage && !isInCodeBlock(match.start, codeBlocks))
    .map((match) => match.href)
}

/**
 * Place a bare filename in the directory this turn actually wrote into.
 *
 * A deliverable is usually named without one — the prose says where the batch
 * went once ("都在 /private/tmp/three_docs/") and then lists basenames in a
 * table. Resolved against the work dir instead, every one of those points at a
 * file that is not there, and the card is dead on arrival.
 *
 * The changed files are the evidence: whatever the shell command wrote, it wrote
 * next to the script the turn also created. Only used when every changed file
 * agrees on one directory — with the turn spread across several there is nothing
 * to infer, and guessing would produce the same dead card less predictably.
 */
function anchorToChangedDirectory(mentioned: string, changedFiles: string[]): string {
  if (/[\\/]/.test(mentioned)) return mentioned

  const directories = new Set(changedFiles.map((file) => {
    const posix = toPosixPath(file)
    const cut = posix.lastIndexOf('/')
    return cut === -1 ? '' : posix.slice(0, cut)
  }))
  if (directories.size !== 1) return mentioned

  const [directory] = [...directories]
  return directory ? `${directory}/${mentioned}` : mentioned
}

/** Express a changed file relative to the work dir, when it lives inside one. */
function correctedChangedFilePath(changedFile: string, workDir: string | null): string {
  const resolved = resolveFilePath(changedFile)
  return workDir && isWithinWorkDir(resolved, workDir)
    ? relativeFilePath(workDir, resolved)
    : toPosixPath(changedFile)
}

/**
 * Re-anchor file chips onto the turn's real changed files. A mentioned file that
 * matches a changed file (by exact relative-path suffix, else by basename) is
 * rewritten to that real path. Uncorroborated source-like relative mentions are
 * omitted; explicit absolute identities and document/media outputs are retained
 * because shell writes are invisible to the checkpoint.
 * Localhost URLs pass through untouched.
 */
function reconcileTargetsWithChangedFiles(
  targets: AssistantOutputTarget[],
  changedFiles: string[],
  workDir: string | null,
  limit: number,
  includeChangedFileFallback: boolean,
): AssistantOutputTarget[] {
  if (limit <= 0) return []

  const out: AssistantOutputTarget[] = []
  const seen = new Set<string>()

  for (const target of targets) {
    if (target.kind === 'localhost-url') {
      out.push(target)
      if (out.length >= limit) break
      continue
    }

    const mentioned = target.normalizedPath ?? target.href
    // An authored absolute path (including an explicit prose root) is identity,
    // not a basename hint. A checkpoint cannot disprove a shell-created output.
    const explicitPath = isAbsoluteFilePath(target.href)
    const match = explicitPath ? null : matchChangedFile(mentioned, changedFiles)
    // Checkpoints record editing tools, not arbitrary shell output. Explicit
    // identities and document/media deliverables survive absent evidence; bare
    // source-like mentions still need corroboration to avoid resource-strip noise.
    if (!match && !explicitPath && !isShellProducedDeliverable(mentioned)
      && target.kind !== 'video' && !/\.(?:mp3|wav|m4a|flac|aac|ogg|opus)$/i.test(mentioned)) {
      continue
    }

    const corrected = explicitPath
      ? resolveFilePath(target.href)
      : match
        ? correctedChangedFilePath(match, workDir)
        : correctedChangedFilePath(anchorToChangedDirectory(mentioned, changedFiles), workDir)

    const key = `${target.kind}:${resolveFilePath(corrected, workDir ?? '/')}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)

    out.push({
      ...target,
      id: createId(target.kind, corrected),
      href: corrected,
      normalizedPath: corrected,
      subtitle: corrected,
    })
    if (out.length >= limit) break
  }

  if (!includeChangedFileFallback) return out

  // A generated document is still a deliverable when the assistant forgets to
  // repeat its path in the final prose. The checkpoint is upstream identity:
  // unlike text extraction, it tells us which path this turn actually wrote.
  for (const changedFile of changedFiles) {
    if (out.length >= limit) break
    if (!isGeneratedArtifactFile(changedFile)) continue

    const corrected = correctedChangedFilePath(changedFile, workDir)
    const kind = classifyFileTarget(corrected) ?? 'file'
    const key = `${kind}:${resolveFilePath(corrected, workDir ?? '/')}`
    if (seen.has(key)) continue
    seen.add(key)

    out.push({
      id: createId(kind, corrected),
      kind,
      title: getBasename(corrected),
      subtitle: corrected,
      href: corrected,
      normalizedPath: corrected,
      confidence: 'high',
      source: 'changed-file',
    })
  }

  return out
}

/**
 * Resolve a mentioned (often relative or bare) path against the turn's absolute
 * changed-file list. Prefer an unambiguous relative-suffix match, then fall back
 * to an unambiguous basename match. Ambiguous matches return null (we'd rather
 * keep the original text path than guess wrong).
 */
function matchChangedFile(mentioned: string, changedFiles: string[]): string | null {
  const normalized = toPosixPath(mentioned).replace(/^\.?\//, '').toLowerCase()
  if (!normalized) {
    return null
  }
  const basename = normalized.split('/').pop() ?? normalized

  const suffixMatches = changedFiles.filter((file) => {
    const normalizedFile = toPosixPath(file).toLowerCase()
    return normalizedFile === normalized || normalizedFile.endsWith(`/${normalized}`)
  })
  if (suffixMatches.length === 1) {
    return suffixMatches[0]!
  }
  if (suffixMatches.length > 1) {
    return null
  }

  const basenameMatches = changedFiles.filter(
    (file) => getBasename(file).toLowerCase() === basename,
  )
  if (basenameMatches.length === 1) {
    return basenameMatches[0]!
  }

  return null
}

function toWorkspaceFileTarget(candidate: string, workDir: string | null): FileTargetMatch | null {
  if (!candidate || candidate.startsWith('file://') || isExternalUrl(candidate)) {
    return null
  }

  const kind = classifyFileTarget(candidate)

  if (!kind) {
    return null
  }

  if (isAbsoluteFilePath(candidate)) {
    const absoluteCandidate = resolveFilePath(candidate)
    return {
      kind,
      normalizedPath: workDir && isWithinWorkDir(absoluteCandidate, workDir)
        ? relativeFilePath(workDir, absoluteCandidate)
        : absoluteCandidate,
    }
  }

  const baseDir = workDir ?? '.'
  const resolvedCandidate = resolveFilePath(candidate, baseDir)

  if (workDir && !isWithinWorkDir(resolvedCandidate, workDir)) {
    return null
  }

  const normalizedPath = workDir
    ? relativeFilePath(workDir, resolvedCandidate)
    : normalizeFilePath(candidate)

  if (!normalizedPath || normalizedPath === '.' || normalizedPath.startsWith('../')) {
    return null
  }

  return {
    kind,
    normalizedPath,
  }
}

function classifyFileTarget(candidate: string): FileTargetMatch['kind'] | null {
  const extension = getExtension(candidate).toLowerCase()

  if (extension === '.html' || extension === '.htm') {
    return 'local-html'
  }

  if (extension === '.md' || extension === '.markdown') {
    return 'markdown'
  }

  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(extension)) {
    return 'image'
  }

  if (['.mp4', '.webm', '.mov', '.m4v'].includes(extension)) {
    return 'video'
  }

  if (isLinkableFilePath(candidate) && isOutputResourceFile(candidate)) {
    return 'file'
  }

  return null
}

function toLocalhostTarget(candidate: string): LocalhostTargetMatch | null {
  const href = trimTrailingPunctuation(candidate)

  if (!localhostUrlPattern.test(href) || localhostUrlPattern.lastIndex !== href.length) {
    localhostUrlPattern.lastIndex = 0
    return null
  }

  localhostUrlPattern.lastIndex = 0

  return {
    kind: 'localhost-url',
    href,
  }
}

function isExternalUrl(candidate: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)
}

/** Whether an absolute path sits inside `workDir` (drive-letter and case aware). */
export function isWithinWorkDir(candidatePath: string, workDir: string): boolean {
  const relativePath = relativeFilePath(workDir, candidatePath)

  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsoluteFilePath(relativePath))
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/')
}

function extractMarkdownLinks(content: string): MarkdownLinkMatch[] {
  const matches: MarkdownLinkMatch[] = []

  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== '[') {
      continue
    }

    const labelEnd = content.indexOf(']', index + 1)

    if (labelEnd === -1 || content[labelEnd + 1] !== '(') {
      continue
    }

    const destinationEnd = findMarkdownDestinationEnd(content, labelEnd + 2)

    if (destinationEnd === -1) {
      continue
    }

    const title = content.slice(index + 1, labelEnd).trim()
    const rawDestination = content.slice(labelEnd + 2, destinationEnd)
    const href = normalizeMarkdownDestination(rawDestination)
    const isImage = content[index - 1] === '!'

    matches.push({
      title,
      href,
      isImage,
      start: isImage ? index - 1 : index,
      end: destinationEnd + 1,
    })

    index = destinationEnd
  }

  return matches
}

function findMarkdownDestinationEnd(content: string, start: number): number {
  let inAngleBrackets = false

  for (let index = start; index < content.length; index += 1) {
    const character = content[index]

    if (character === '<') {
      inAngleBrackets = true
      continue
    }

    if (character === '>' && inAngleBrackets) {
      inAngleBrackets = false
      continue
    }

    if (character === ')' && !inAngleBrackets) {
      return index
    }
  }

  return -1
}

function normalizeMarkdownDestination(destination: string): string {
  let normalized = destination.trim()
  const titleMatch = normalized.match(
    /^(.*\S)\s+(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^)\\]|\\.)*\))\s*$/,
  )
  if (titleMatch?.[1]) {
    normalized = titleMatch[1].trim()
  }

  if (normalized.startsWith('<') && normalized.endsWith('>')) {
    normalized = normalized.slice(1, -1).trim()
  }

  const lineSuffixMatch = normalized.match(/^(.*\.(?:html?|md|markdown|png|jpe?g|gif|webp|svg|mp4|webm|mov|m4v)):\d+$/i)
  const lineSuffixedPath = lineSuffixMatch?.[1]

  if (lineSuffixedPath && !isExternalUrl(lineSuffixedPath)) {
    normalized = lineSuffixedPath
  }

  return trimTrailingPunctuation(normalized)
}

type InlineCodeSpan = {
  start: number
  end: number
  ref: NonNullable<ReturnType<typeof parseFilePathRef>>
}

/** Single-line `code` spans outside fenced blocks whose whole content is one file reference. */
function extractInlineCodeSpans(content: string, codeBlocks: FencedCodeBlock[]): InlineCodeSpan[] {
  const spans: InlineCodeSpan[] = []

  for (const match of content.matchAll(/(?<!`)`([^`\n]+)`(?!`)/g)) {
    const start = match.index ?? 0
    if (isInCodeBlock(start, codeBlocks)) {
      continue
    }

    const ref = parseFilePathRef(match[1] ?? '')
    if (ref) {
      spans.push({ start, end: start + match[0].length, ref })
    }
  }

  return spans
}

function isInMarkdownLink(position: number, markdownLinks: MarkdownLinkMatch[]): boolean {
  return markdownLinks.some((link) => position >= link.start && position < link.end)
}

function isInCodeBlock(position: number, codeBlocks: FencedCodeBlock[]): boolean {
  return codeBlocks.some((block) => position >= block.start && position < block.end)
}

function extractFencedCodeBlocks(content: string): FencedCodeBlock[] {
  const blocks: FencedCodeBlock[] = []
  const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? []
  let offset = 0
  let active:
    | { marker: '```' | '~~~'; start: number; contentStart: number }
    | null = null

  for (const line of lines) {
    const trimmed = line.trimStart()

    if (!active && (trimmed.startsWith('```') || trimmed.startsWith('~~~'))) {
      active = {
        marker: trimmed.startsWith('```') ? '```' : '~~~',
        start: offset,
        contentStart: offset + line.length,
      }
      offset += line.length
      continue
    }

    if (active && trimmed.startsWith(active.marker)) {
      blocks.push({
        start: active.start,
        end: offset + line.length,
        contentStart: active.contentStart,
        text: content.slice(active.contentStart, offset),
      })
      active = null
    }

    offset += line.length
  }

  return blocks
}

function extractDirectoryTreeFileMatches(codeBlocks: FencedCodeBlock[]): DirectoryTreeFileMatch[] {
  const matches: DirectoryTreeFileMatch[] = []

  for (const block of codeBlocks) {
    matches.push(...extractDirectoryTreeFileMatchesFromBlock(block))
  }

  return matches
}

function extractDirectoryTreeFileMatchesFromBlock(block: FencedCodeBlock): DirectoryTreeFileMatch[] {
  const matches: DirectoryTreeFileMatch[] = []
  const lines = block.text.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const directoryStack: string[] = []
  let rootPath: string | null = null
  let offset = 0

  for (const line of lines) {
    const trimmed = line.trim()

    if (!rootPath) {
      const rootMatch = trimmed.match(/^((?:\/|[A-Za-z]:\/).*[\\/])$/)
      if (rootMatch) {
        rootPath = normalizeFilePath(rootMatch[1] ?? '')
      }
      offset += line.length
      continue
    }

    const entryMatch = line.match(/^(\s*)(?:[│|]\s*)*[├└]──\s+(.+?)\s*$/u)
    if (!entryMatch) {
      offset += line.length
      continue
    }

    const rawPrefix = entryMatch[1] ?? ''
    const level = Math.floor(rawPrefix.replace(/[│|]/g, ' ').length / 4)
    const entryName = stripTreeEntryComment(entryMatch[2] ?? '')

    if (!entryName || entryName === '.' || entryName === '..') {
      offset += line.length
      continue
    }

    if (entryName.endsWith('/')) {
      directoryStack[level] = entryName.replace(/\/+$/g, '')
      directoryStack.length = level + 1
      offset += line.length
      continue
    }

    const relativeSegments = [...directoryStack.slice(0, level), entryName]
    const href = resolveFilePath(relativeSegments.join('/'), rootPath)
    if (classifyFileTarget(href)) {
      matches.push({
        href,
        position: block.contentStart + offset,
      })
    }

    offset += line.length
  }

  return matches
}

function stripTreeEntryComment(value: string): string {
  return value.replace(/\s+#.*$/g, '').trim()
}

function createFileKey(target: FileTargetMatch): string {
  return `file:${target.kind}:${target.normalizedPath}`
}

function createLocalhostKey(href: string): string {
  return `url:${href}`
}

function createId(kind: AssistantOutputTargetKind, value: string): string {
  return `${kind}:${value}`
}

function isAbsoluteFilePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:\//.test(toPosixPath(value))
}

function normalizeFilePath(value: string): string {
  const slashed = toPosixPath(value)
  const { prefix, segments } = splitFilePath(slashed)
  const normalizedSegments: string[] = []

  for (const segment of segments) {
    if (!segment || segment === '.') {
      continue
    }

    if (segment === '..') {
      const previous = normalizedSegments[normalizedSegments.length - 1]

      if (previous && previous !== '..') {
        normalizedSegments.pop()
      } else if (!prefix) {
        normalizedSegments.push('..')
      }

      continue
    }

    normalizedSegments.push(segment)
  }

  if (!prefix && normalizedSegments.length === 0) {
    return '.'
  }

  if (normalizedSegments.length === 0) {
    return prefix
  }

  return `${prefix}${normalizedSegments.join('/')}`
}

function resolveFilePath(value: string, baseDir = '/'): string {
  if (isAbsoluteFilePath(value)) {
    return normalizeFilePath(value)
  }

  const normalizedBaseDir = normalizeFilePath(baseDir)
  const separator = normalizedBaseDir === '/' || normalizedBaseDir.endsWith('/') ? '' : '/'

  return normalizeFilePath(`${normalizedBaseDir}${separator}${value}`)
}

function relativeFilePath(from: string, to: string): string {
  const fromParts = splitFilePath(normalizeFilePath(from))
  const toParts = splitFilePath(normalizeFilePath(to))

  if (fromParts.prefix.toLowerCase() !== toParts.prefix.toLowerCase()) {
    return normalizeFilePath(to)
  }

  let sharedLength = 0

  while (
    sharedLength < fromParts.segments.length &&
    sharedLength < toParts.segments.length &&
    arePathSegmentsEqual(
      fromParts.segments[sharedLength],
      toParts.segments[sharedLength],
      fromParts.prefix,
    )
  ) {
    sharedLength += 1
  }

  const parentSegments = Array.from(
    { length: fromParts.segments.length - sharedLength },
    () => '..',
  )
  const childSegments = toParts.segments.slice(sharedLength)

  return [...parentSegments, ...childSegments].join('/')
}

function getExtension(value: string): string {
  const basename = getBasename(value)
  const extensionIndex = basename.lastIndexOf('.')

  if (extensionIndex <= 0) {
    return ''
  }

  return basename.slice(extensionIndex)
}

function getBasename(value: string): string {
  const normalized = toPosixPath(value).replace(/\/+$/g, '')
  const segments = normalized.split('/')

  return segments[segments.length - 1] || ''
}

function splitFilePath(value: string): { prefix: string, segments: string[] } {
  const slashed = toPosixPath(value)

  if (slashed.startsWith('/')) {
    return {
      prefix: '/',
      segments: slashed.slice(1).split('/').filter(Boolean),
    }
  }

  const driveMatch = slashed.match(/^([A-Za-z]:)\/?(.*)$/)

  if (driveMatch) {
    const drivePrefix = driveMatch[1] ?? ''
    const driveSegments = driveMatch[2] ?? ''

    return {
      prefix: `${drivePrefix}/`,
      segments: driveSegments.split('/').filter(Boolean),
    }
  }

  return {
    prefix: '',
    segments: slashed.split('/').filter(Boolean),
  }
}

function arePathSegmentsEqual(left: string | undefined, right: string | undefined, prefix: string): boolean {
  if (!left || !right) {
    return left === right
  }

  if (/^[A-Za-z]:\/$/.test(prefix)) {
    return left.toLowerCase() === right.toLowerCase()
  }

  return left === right
}
