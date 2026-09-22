/**
 * Filesystem browser & search API — supports directory browsing and file search
 * for the DirectoryPicker component and @-triggered file search popup.
 */

import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import ignore from 'ignore'
import { getGlobalConfig } from '../../utils/config.js'
import { execFileNoThrowWithCwd } from '../../utils/execFileNoThrow.js'
import { findGitRoot, gitExe } from '../../utils/git.js'
import { ripGrep } from '../../utils/ripgrep.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import {
  canonicalizeFilesystemAccessPath,
  isWithinRegisteredFilesystemRoot,
} from '../services/filesystemAccessRoots.js'
import { canonicalizeExistingFilesystemPath } from '../services/filesystemPathSecurity.js'
import {
  isSameOrInsidePathForPlatform,
  normalizeDriveRootPathForPlatform,
} from '../services/windowsDrivePath.js'

export type FilesystemEntry = {
  name: string
  path: string
  isDirectory: boolean
  relativePath?: string
}

type ScoredFilesystemEntry = FilesystemEntry & {
  score: number
}

const FILE_SEARCH_TIMEOUT_MS = 10_000
const INTERACTIVE_FILE_SEARCH_TIMEOUT_MS = 2_000
const FILE_SEARCH_FALLBACK_MAX_DIRECTORIES = 5_000
const FILE_SEARCH_FALLBACK_MAX_FILES = 20_000
const VCS_METADATA_DIRECTORY_NAMES = new Set(['.git', '.svn', '.hg', '.bzr', '.jj', '.sl'])
const activeInteractiveSearches = new Map<string, AbortController>()

type ProjectSearchDependencies = {
  ripGrepFn?: (
    args: string[],
    target: string,
    abortSignal: AbortSignal,
  ) => Promise<string[]>
  fallbackOptions?: {
    searchQuery?: string
    timeoutMs?: number
    maxDirectories?: number
    maxFiles?: number
  }
  signal?: AbortSignal
}

type SearchIgnoreContext = {
  baseRelativePath: string
  matcher: ReturnType<typeof ignore>
}

const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
}

function isWithinRoot(targetPath: string, rootPath: string): boolean {
  return isSameOrInsidePathForPlatform(targetPath, rootPath)
}

function isVcsMetadataDirectoryName(name: string): boolean {
  return VCS_METADATA_DIRECTORY_NAMES.has(name.toLowerCase())
}

export function isAllowedFilesystemPath(targetPath: string): boolean {
  const resolvedPath = canonicalizeFilesystemAccessPath(targetPath)
  const homeDir = canonicalizeFilesystemAccessPath(os.homedir())
  const temporaryDir = canonicalizeFilesystemAccessPath('/tmp')

  if (isWithinRoot(resolvedPath, homeDir) || isWithinRoot(resolvedPath, temporaryDir)) {
    return true
  }

  if (isWithinRegisteredFilesystemRoot(resolvedPath)) {
    return true
  }

  // macOS reports /tmp as /private/tmp via native folder pickers and realpath().
  if (process.platform === 'darwin' && isWithinRoot(resolvedPath, canonicalizeFilesystemAccessPath('/private/tmp'))) {
    return true
  }

  return false
}

export async function handleFilesystemRoute(pathname: string, url: URL, signal?: AbortSignal): Promise<Response> {
  if (pathname === '/api/filesystem/browse') {
    return handleBrowse(url, signal)
  }

  if (pathname === '/api/filesystem/file') {
    return handleServeFile(url)
  }

  return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 })
}

async function handleServeFile(url: URL): Promise<Response> {
  const filePath = url.searchParams.get('path')
  if (!filePath) {
    return json({ error: 'Missing path parameter' }, 400)
  }

  const resolvedPath = path.resolve(normalizeDriveRootPathForPlatform(filePath))
  const canonicalPath = await canonicalizeExistingFilesystemPath(resolvedPath)
  if (!canonicalPath) {
    if (!isAllowedFilesystemPath(resolvedPath)) {
      return json({ error: 'Access denied: path outside allowed directory' }, 403)
    }
    return json({ error: 'File not found' }, 404)
  }
  if (!isAllowedFilesystemPath(canonicalPath)) {
    return json({ error: 'Access denied: path outside allowed directory' }, 403)
  }

  const ext = path.extname(canonicalPath).toLowerCase()
  const mimeType = IMAGE_MIME_TYPES[ext]

  if (!mimeType) {
    return json({ error: 'Unsupported file type' }, 400)
  }

  try {
    const stat = fs.statSync(canonicalPath)
    if (!stat.isFile()) {
      return json({ error: 'Not a file' }, 400)
    }
    // Limit to 50MB
    if (stat.size > 50 * 1024 * 1024) {
      return json({ error: 'File too large' }, 400)
    }

    const data = fs.readFileSync(canonicalPath)
    return new Response(data, {
      status: 200,
      headers: {
        'Content-Type': mimeType,
        'Content-Length': String(stat.size),
        'Cache-Control': 'private, max-age=3600',
      },
    })
  } catch {
    return json({ error: 'File not found' }, 404)
  }
}

async function handleBrowse(url: URL, requestSignal?: AbortSignal): Promise<Response> {
  const targetPath = url.searchParams.get('path') || os.homedir() || '/'
  const resolvedPath = path.resolve(normalizeDriveRootPathForPlatform(targetPath))
  const canonicalPath = await canonicalizeExistingFilesystemPath(resolvedPath)
  if (!canonicalPath) {
    if (!isAllowedFilesystemPath(resolvedPath)) {
      return json({ error: 'Access denied: path outside allowed directory' }, 403)
    }
    return json({ error: 'Cannot read directory: path not found', path: resolvedPath }, 404)
  }
  if (!isAllowedFilesystemPath(canonicalPath)) {
    return json({ error: 'Access denied: path outside allowed directory' }, 403)
  }

  const searchQuery = url.searchParams.get('search') || ''
  const includeFiles = url.searchParams.get('includeFiles') === 'true'
  const maxResults = Math.min(parseInt(url.searchParams.get('maxResults') || '200', 10), 200)

  try {
    const stat = fs.statSync(canonicalPath)
    if (!stat.isDirectory()) {
      return json({ error: 'Not a directory', path: canonicalPath }, 400)
    }

    if (searchQuery) {
      // Composer searches supersede one another while the user types. Abort the
      // older scan before starting another one for the same root so broad roots
      // such as /tmp cannot accumulate a process and a large candidate array
      // for every keystroke.
      activeInteractiveSearches.get(canonicalPath)?.abort()
      const searchController = new AbortController()
      activeInteractiveSearches.set(canonicalPath, searchController)
      const signal = combineAbortSignals(requestSignal, searchController.signal)
      let results: FilesystemEntry[]
      try {
        results = await searchFilesystemEntries(canonicalPath, searchQuery, {
          includeFiles,
          maxResults,
          signal,
          timeoutMs: INTERACTIVE_FILE_SEARCH_TIMEOUT_MS,
        })
      } finally {
        if (activeInteractiveSearches.get(canonicalPath) === searchController) {
          activeInteractiveSearches.delete(canonicalPath)
        }
      }

      return json({
        currentPath: canonicalPath,
        parentPath: path.dirname(canonicalPath),
        entries: results,
        query: searchQuery,
      })
    }

    const entries = fs.readdirSync(canonicalPath, { withFileTypes: true })

    // Browse mode: show dot-prefixed project entries while keeping VCS internals hidden.
    const filtered = entries.filter((e) => {
      if (e.isDirectory()) return !isVcsMetadataDirectoryName(e.name)
      return includeFiles
    })

    const entries_list = filtered
      .map((e) => ({
        name: e.name,
        path: path.join(canonicalPath, e.name),
        isDirectory: e.isDirectory(),
        relativePath: e.name,
      }))
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        return a.name.localeCompare(b.name)
      })

    return json({
      currentPath: canonicalPath,
      parentPath: path.dirname(canonicalPath),
      entries: entries_list,
    })
  } catch (err) {
    return json({ error: `Cannot read directory: ${err}`, path: canonicalPath }, 500)
  }
}

export async function searchFilesystemEntries(
  rootPath: string,
  searchQuery: string,
  options: {
    includeFiles: boolean
    includeDirectories?: boolean
    maxResults: number
    signal?: AbortSignal
    timeoutMs?: number
  },
): Promise<FilesystemEntry[]> {
  const normalizedQuery = normalizeSearchText(searchQuery)
  if (!normalizedQuery) return []

  const candidates = await getSearchCandidates(
    rootPath,
    options.includeFiles,
    options.includeDirectories ?? true,
    normalizedQuery,
    options.signal,
    options.timeoutMs,
  )
  options.signal?.throwIfAborted()
  const results = candidates
    .map((entry): ScoredFilesystemEntry | null => {
      const relativePath = entry.relativePath ?? entry.name
      const score = scoreFilesystemEntry(entry.name, relativePath, normalizedQuery, entry.isDirectory)
      return score > 0 ? { ...entry, score } : null
    })
    .filter((entry): entry is ScoredFilesystemEntry => entry !== null)

  return results
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      const aPath = a.relativePath ?? a.name
      const bPath = b.relativePath ?? b.name
      const aDepth = pathDepth(aPath)
      const bDepth = pathDepth(bPath)
      if (aDepth !== bDepth) return aDepth - bDepth
      return (a.relativePath ?? a.name).localeCompare(b.relativePath ?? b.name)
    })
    .slice(0, options.maxResults)
    .map(({ score: _score, ...entry }) => entry)
}

async function getSearchCandidates(
  rootPath: string,
  includeFiles: boolean,
  includeDirectories: boolean,
  searchQuery: string,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<FilesystemEntry[]> {
  const files = await getProjectSearchFiles(rootPath, {
    fallbackOptions: { searchQuery, timeoutMs },
    signal,
  })
  const entries = new Map<string, FilesystemEntry>()

  for (const filePath of files) {
    signal?.throwIfAborted()
    const normalizedFile = normalizeRelativePath(filePath)
    if (!normalizedFile || !isRelativeInsideRoot(normalizedFile)) continue

    if (includeDirectories) {
      let currentDir = path.posix.dirname(normalizedFile)
      while (currentDir !== '.') {
        addCandidate(entries, rootPath, currentDir, true)
        const parent = path.posix.dirname(currentDir)
        if (parent === currentDir) break
        currentDir = parent
      }
    }

    if (includeFiles) {
      addCandidate(entries, rootPath, normalizedFile, false)
    }
  }

  return [...entries.values()]
}

function addCandidate(entries: Map<string, FilesystemEntry>, rootPath: string, relativePath: string, isDirectory: boolean): void {
  if (entries.has(relativePath)) return
  entries.set(relativePath, {
    name: path.posix.basename(relativePath),
    path: path.join(rootPath, ...relativePath.split('/')),
    isDirectory,
    relativePath,
  })
}

export async function getProjectSearchFiles(
  rootPath: string,
  dependencies: ProjectSearchDependencies = {},
): Promise<string[]> {
  dependencies.signal?.throwIfAborted()
  const respectGitignore = shouldRespectGitignore()
  const gitFiles = await getFilesUsingGit(rootPath, respectGitignore, dependencies.signal)
  if (gitFiles !== null && gitFiles.length > 0) {
    return gitFiles
  }

  // For a non-repository interactive search, scanning every file into rg's
  // stdout before applying the query is both slower and far more memory hungry.
  // The bounded fallback applies the query while walking and stops at its
  // deadline/budget.
  if (dependencies.fallbackOptions?.searchQuery) {
    return getFilesUsingFilesystem(
      rootPath,
      respectGitignore,
      dependencies.fallbackOptions,
      dependencies.signal,
    )
  }

  try {
    return await getFilesUsingRipgrep(
      rootPath,
      respectGitignore,
      dependencies.ripGrepFn ?? ripGrep,
      dependencies.signal,
    )
  } catch {
    dependencies.signal?.throwIfAborted()
    return getFilesUsingFilesystem(
      rootPath,
      respectGitignore,
      dependencies.fallbackOptions,
      dependencies.signal,
    )
  }
}

function shouldRespectGitignore(): boolean {
  const projectSettings = getInitialSettings()
  const globalConfig = getGlobalConfig()
  return projectSettings.respectGitignore ?? globalConfig.respectGitignore ?? true
}

async function getFilesUsingGit(rootPath: string, respectGitignore: boolean, signal?: AbortSignal): Promise<string[] | null> {
  const repoRoot = findGitRoot(rootPath)
  if (!repoRoot) return null

  const trackedResult = await execFileNoThrowWithCwd(
    gitExe(),
    ['-c', 'core.quotepath=false', 'ls-files', '--recurse-submodules'],
    { timeout: FILE_SEARCH_TIMEOUT_MS, cwd: repoRoot, abortSignal: signal },
  )
  signal?.throwIfAborted()
  if (trackedResult.code !== 0) return null

  const untrackedArgs = respectGitignore
    ? ['-c', 'core.quotepath=false', 'ls-files', '--others', '--exclude-standard']
    : ['-c', 'core.quotepath=false', 'ls-files', '--others']
  const untrackedResult = await execFileNoThrowWithCwd(gitExe(), untrackedArgs, {
    timeout: FILE_SEARCH_TIMEOUT_MS,
    cwd: repoRoot,
    abortSignal: signal,
  })
  signal?.throwIfAborted()

  const files = [
    ...lines(trackedResult.stdout),
    ...(untrackedResult.code === 0 ? lines(untrackedResult.stdout) : []),
  ]
  let normalized = files
    .map(filePath => normalizeGitPath(filePath, repoRoot, rootPath))
    .filter((filePath): filePath is string => filePath !== null)

  const ignorePatterns = loadSearchIgnorePatterns(repoRoot, rootPath, false)
  if (ignorePatterns) {
    normalized = ignorePatterns.filter(normalized)
  }

  return [...new Set(normalized)]
}

async function getFilesUsingRipgrep(
  rootPath: string,
  respectGitignore: boolean,
  ripGrepFn: NonNullable<ProjectSearchDependencies['ripGrepFn']>,
  signal?: AbortSignal,
): Promise<string[]> {
  const rgArgs = [
    '--files',
    '--follow',
    '--hidden',
    '--glob',
    '!.git/',
    '--glob',
    '!.svn/',
    '--glob',
    '!.hg/',
    '--glob',
    '!.bzr/',
    '--glob',
    '!.jj/',
    '--glob',
    '!.sl/',
  ]
  if (!respectGitignore) {
    rgArgs.push('--no-ignore-vcs')
  }

  const files = await ripGrepFn(
    rgArgs,
    rootPath,
    combineAbortSignals(signal, AbortSignal.timeout(FILE_SEARCH_TIMEOUT_MS)),
  )
  signal?.throwIfAborted()
  let normalized = files
    .map(filePath => normalizeRipgrepPath(filePath, rootPath))
    .filter((filePath): filePath is string => filePath !== null)

  const ignorePatterns = loadSearchIgnorePatterns(rootPath, rootPath, true)
  if (ignorePatterns) {
    normalized = ignorePatterns.filter(normalized)
  }

  return normalized
}

async function getFilesUsingFilesystem(
  rootPath: string,
  respectGitignore: boolean,
  options: NonNullable<ProjectSearchDependencies['fallbackOptions']> = {},
  signal?: AbortSignal,
): Promise<string[]> {
  const deadline = Date.now() + (options.timeoutMs ?? FILE_SEARCH_TIMEOUT_MS)
  const maxDirectories = options.maxDirectories ?? FILE_SEARCH_FALLBACK_MAX_DIRECTORIES
  const maxFiles = options.maxFiles ?? FILE_SEARCH_FALLBACK_MAX_FILES
  const searchQuery = normalizeSearchText(options.searchQuery ?? '')
  const files: string[] = []
  const directories: Array<{
    absolutePath: string
    relativePath: string
    ignoreContexts: SearchIgnoreContext[]
  }> = [{ absolutePath: rootPath, relativePath: '', ignoreContexts: [] }]
  let directoryIndex = 0
  let visitedDirectories = 0

  while (
    directoryIndex < directories.length &&
    visitedDirectories < maxDirectories &&
    files.length < maxFiles &&
    Date.now() < deadline
  ) {
    signal?.throwIfAborted()
    const current = directories[directoryIndex]
    directoryIndex += 1
    if (!current) continue
    visitedDirectories += 1

    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(current.absolutePath, {
        withFileTypes: true,
      })
    } catch {
      continue
    }
    signal?.throwIfAborted()

    entries.sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) {
        return left.isDirectory() ? -1 : 1
      }
      return left.name.localeCompare(right.name)
    })

    const localIgnore = loadDirectorySearchIgnorePatterns(
      current.absolutePath,
      respectGitignore,
    )
    const ignoreContexts = localIgnore
      ? [
          ...current.ignoreContexts,
          {
            baseRelativePath: current.relativePath,
            matcher: localIgnore,
          },
        ]
      : current.ignoreContexts

    for (const entry of entries) {
      const relativePath = normalizeRelativePath(
        current.relativePath
          ? `${current.relativePath}/${entry.name}`
          : entry.name,
      )

      if (entry.isDirectory()) {
        if (isVcsMetadataDirectoryName(entry.name)) continue
        if (isIgnoredBySearchContexts(ignoreContexts, relativePath, true)) continue
        directories.push({
          absolutePath: path.join(current.absolutePath, entry.name),
          relativePath,
          ignoreContexts,
        })
        continue
      }

      if (
        !entry.isFile() ||
        isIgnoredBySearchContexts(ignoreContexts, relativePath, false) ||
        (searchQuery && !matchesFilesystemFallbackQuery(relativePath, searchQuery))
      ) {
        continue
      }
      files.push(relativePath)
      if (files.length >= maxFiles) break
    }
  }

  return files
}

function combineAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const available = signals.filter((signal): signal is AbortSignal => signal !== undefined)
  if (available.length === 0) return new AbortController().signal
  if (available.length === 1) return available[0]!
  return AbortSignal.any(available)
}

function loadDirectorySearchIgnorePatterns(
  directoryPath: string,
  includeGitignore: boolean,
): ReturnType<typeof ignore> | null {
  const matcher = ignore()
  let hasPatterns = false
  const ignoreFiles = includeGitignore
    ? ['.gitignore', '.ignore', '.rgignore']
    : ['.ignore', '.rgignore']

  for (const fileName of ignoreFiles) {
    try {
      matcher.add(fs.readFileSync(path.join(directoryPath, fileName), 'utf8'))
      hasPatterns = true
    } catch {
      // Missing or unreadable ignore files should not break suggestions.
    }
  }

  return hasPatterns ? matcher : null
}

function isIgnoredBySearchContexts(
  contexts: SearchIgnoreContext[],
  relativePath: string,
  isDirectory: boolean,
): boolean {
  let ignored = false

  for (const context of contexts) {
    const scopedPath = context.baseRelativePath
      ? path.posix.relative(context.baseRelativePath, relativePath)
      : relativePath
    if (!isRelativeInsideRoot(scopedPath)) continue

    const result = context.matcher.test(
      isDirectory ? `${scopedPath}/` : scopedPath,
    )
    if (result.ignored) ignored = true
    if (result.unignored) ignored = false
  }

  return ignored
}

function matchesFilesystemFallbackQuery(
  relativePath: string,
  searchQuery: string,
): boolean {
  if (
    scoreFilesystemEntry(
      path.posix.basename(relativePath),
      relativePath,
      searchQuery,
      false,
    ) > 0
  ) {
    return true
  }

  let directoryPath = path.posix.dirname(relativePath)
  while (directoryPath !== '.') {
    if (
      scoreFilesystemEntry(
        path.posix.basename(directoryPath),
        directoryPath,
        searchQuery,
        true,
      ) > 0
    ) {
      return true
    }
    const parentPath = path.posix.dirname(directoryPath)
    if (parentPath === directoryPath) break
    directoryPath = parentPath
  }

  return false
}

function normalizeGitPath(filePath: string, repoRoot: string, rootPath: string): string | null {
  const relativePath = path.relative(rootPath, path.join(repoRoot, filePath))
  const normalized = normalizeRelativePath(relativePath)
  return isRelativeInsideRoot(normalized) ? normalized : null
}

function normalizeRipgrepPath(filePath: string, rootPath: string): string | null {
  const relativePath = path.isAbsolute(filePath) ? path.relative(rootPath, filePath) : filePath
  const normalized = normalizeRelativePath(relativePath)
  return isRelativeInsideRoot(normalized) ? normalized : null
}

function normalizeRelativePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\/+/, '')
}

function isRelativeInsideRoot(filePath: string): boolean {
  return !!filePath && filePath !== '.' && !filePath.startsWith('../') && !path.isAbsolute(filePath)
}

function lines(output: string): string[] {
  return output.trim().split('\n').map(line => line.trim()).filter(Boolean)
}

function loadSearchIgnorePatterns(repoRoot: string, rootPath: string, includeGitignore: boolean): ReturnType<typeof ignore> | null {
  const ig = ignore()
  let hasPatterns = false
  const ignoreFiles = includeGitignore ? ['.gitignore', '.ignore', '.rgignore'] : ['.ignore', '.rgignore']
  const paths = [...new Set([repoRoot, rootPath])].flatMap(dir => ignoreFiles.map(fileName => path.join(dir, fileName)))

  for (const ignorePath of paths) {
    try {
      ig.add(fs.readFileSync(ignorePath, 'utf8'))
      hasPatterns = true
    } catch {
      // Missing or unreadable ignore files should not break suggestions.
    }
  }

  return hasPatterns ? ig : null
}

function normalizeSearchText(value: string): string {
  return value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^@+/, '')
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '')
    .toLowerCase()
}

function scoreFilesystemEntry(name: string, relativePath: string, query: string, isDirectory: boolean): number {
  const normalizedName = normalizeSearchText(name)
  const normalizedPath = normalizeSearchText(relativePath)
  const pathNoExtension = normalizedPath.replace(/\.[^/.]+$/, '')
  const pathPrefix = `${query}/`
  const baseBoost = isDirectory ? 4 : 0
  const depthPenalty = Math.min(relativePath.split('/').length - 1, 8) * 2

  if (normalizedPath === query) return 150 + baseBoost - depthPenalty
  if (pathNoExtension === query) return 144 + baseBoost - depthPenalty
  if (normalizedPath.startsWith(pathPrefix)) return 136 + baseBoost - depthPenalty
  if (normalizedPath.startsWith(query)) return 112 + baseBoost - depthPenalty
  if (normalizedName === query) return 96 + baseBoost - depthPenalty
  if (normalizedName.startsWith(query)) return 88 + baseBoost - depthPenalty
  if (normalizedName.includes(query)) return 72 + baseBoost - depthPenalty
  if (normalizedPath.includes(query)) return 60 + baseBoost - depthPenalty

  const nameFuzzy = fuzzyScore(normalizedName, query)
  if (nameFuzzy > 0) return 44 + nameFuzzy + baseBoost - depthPenalty

  const pathFuzzy = fuzzyScore(normalizedPath, query)
  if (pathFuzzy > 0) return 28 + pathFuzzy + baseBoost - depthPenalty

  return 0
}

function pathDepth(relativePath: string): number {
  return relativePath.split('/').length
}

function fuzzyScore(value: string, query: string): number {
  let queryIndex = 0
  let runLength = 0
  let score = 0

  for (let valueIndex = 0; valueIndex < value.length && queryIndex < query.length; valueIndex += 1) {
    if (value[valueIndex] !== query[queryIndex]) {
      runLength = 0
      continue
    }

    const boundaryBoost = valueIndex === 0 || ['/', '-', '_', '.', ' '].includes(value[valueIndex - 1] ?? '')
      ? 3
      : 0
    runLength += 1
    score += 2 + boundaryBoost + Math.min(runLength, 4)
    queryIndex += 1
  }

  return queryIndex === query.length ? score : 0
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
