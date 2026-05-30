export type AssistantOutputTargetKind =
  | 'local-html'
  | 'localhost-url'
  | 'image'
  | 'video'
  | 'markdown'

export type AssistantOutputTargetSource =
  | 'markdown-link'
  | 'plain-url'
  | 'plain-path'

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

const localhostUrlPattern =
  /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/[^\s`"'<>，。；、）\])}]*)?/gi
const previewablePathPattern =
  /(^|[\s("'`[])((?:\.{1,2}\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:html?|md|markdown|png|jpe?g|gif|webp|svg|mp4|webm|mov|m4v))(?![\w/-])/gi

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
    const title = match.title
    const href = match.href
    const localhostTarget = toLocalhostTarget(href)
    const fileTarget = toWorkspaceFileTarget(href, workDir)

    if (!title) {
      continue
    }

    if (localhostTarget) {
      queueTarget({
        id: createId(localhostTarget.kind, localhostTarget.href),
        kind: localhostTarget.kind,
        title,
        href: localhostTarget.href,
        confidence: 'high',
        source: 'markdown-link',
      }, createLocalhostKey(localhostTarget.href), match.start)
      continue
    }

    if (!fileTarget) {
      continue
    }

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

  for (const match of content.matchAll(previewablePathPattern)) {
    const position = match.index ?? 0

    if (isInMarkdownLink(position, markdownLinks)) {
      continue
    }

    if (isInCodeBlock(position, codeBlocks)) {
      continue
    }

    const href = trimTrailingPunctuation(match[2] ?? '')
    const fileTarget = toWorkspaceFileTarget(href, workDir)

    if (!fileTarget) {
      continue
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

  candidates.sort((left, right) => {
    if (left.position !== right.position) {
      return left.position - right.position
    }

    return left.order - right.order
  })

  for (const candidate of candidates) {
    if (results.length >= limit || seen.has(candidate.key)) {
      continue
    }

    seen.add(candidate.key)
    results.push(candidate.target)
  }

  return results
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
    if (!workDir) {
      return null
    }

    const absoluteCandidate = resolveFilePath(candidate)

    if (!isWithinWorkDir(absoluteCandidate, workDir)) {
      return null
    }

    return {
      kind,
      normalizedPath: relativeFilePath(workDir, absoluteCandidate),
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

function isWithinWorkDir(candidatePath: string, workDir: string): boolean {
  const relativePath = relativeFilePath(workDir, candidatePath)

  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsoluteFilePath(relativePath))
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/')
}

function trimTrailingPunctuation(value: string): string {
  return value.replace(/[`'")\]\}>,.;!?，。；、）】》]+$/g, '')
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

    matches.push({
      title,
      href,
      start: index,
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
