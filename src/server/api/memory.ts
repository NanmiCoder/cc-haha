/**
 * Memory REST API
 *
 * GET  /api/memory/projects?cwd=...       — list project-scoped memory dirs
 * GET  /api/memory/files?projectId=...    — list markdown memory files
 * GET  /api/memory/file?projectId=...&path=...
 * PUT  /api/memory/file                   — update/create a markdown memory file
 */

import * as fs from 'node:fs/promises'
import { homedir } from 'node:os'
import * as path from 'node:path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { parseFrontmatter } from '../../utils/frontmatterParser.js'
import { findCanonicalGitRoot } from '../../utils/git.js'
import { sanitizePath } from '../../utils/path.js'
import { extractJsonStringField } from '../../utils/sessionStoragePortable.js'
import { getCwd } from '../../utils/cwd.js'
import { parseMemoryType } from '../../memdir/memoryTypes.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'

type MemoryProject = {
  id: string
  label: string
  memoryDir: string
  exists: boolean
  fileCount: number
  isCurrent: boolean
}

type MemoryFile = {
  path: string
  name: string
  bytes: number
  updatedAt: string
  type?: string
  description?: string
  title: string
  isIndex: boolean
}

const MAX_MEMORY_FILE_BYTES = 512 * 1024
const MAX_MEMORY_FILES = 500
const PROJECT_LABEL_SESSION_SCAN_LIMIT = 10
const PROJECT_LABEL_HEAD_BYTES = 64 * 1024
const PROJECT_LABEL_FS_SEARCH_DEPTH = 24
const PROJECT_LABEL_FS_SEARCH_NODE_LIMIT = 2000

export async function handleMemoryApi(
  req: Request,
  url: URL,
  segments: string[],
): Promise<Response> {
  try {
    const sub = segments[2]

    switch (sub) {
      case 'projects':
        if (req.method !== 'GET') throw methodNotAllowed(req.method)
        return Response.json({
          projects: await listMemoryProjects(url.searchParams.get('cwd') || undefined),
        })

      case 'files':
        if (req.method !== 'GET') throw methodNotAllowed(req.method)
        return Response.json({
          files: await listMemoryFiles(requireProjectId(url)),
        })

      case 'file':
        return await handleMemoryFile(req, url)

      default:
        throw ApiError.notFound(`Unknown memory endpoint: ${sub}`)
    }
  } catch (error) {
    return errorResponse(error)
  }
}

async function listMemoryProjects(cwd?: string): Promise<MemoryProject[]> {
  const projectsDir = getProjectsDir()
  const currentCwd = cwd || getCwd()
  const currentProjectId = getProjectIdForCwd(currentCwd)
  const projects = new Map<string, MemoryProject>()

  addProject(projects, currentProjectId, true)

  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(projectsDir, { withFileTypes: true })
  } catch {
    entries = []
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    addProject(projects, entry.name, entry.name === currentProjectId)
  }

  const resolved = await Promise.all(
    Array.from(projects.values()).map(async project => {
      const [fileCount, label] = await Promise.all([
        countMarkdownFiles(project.memoryDir),
        resolveProjectLabel(project.id, currentCwd),
      ])
      return {
        ...project,
        label,
        exists: fileCount > 0 || (await directoryExists(project.memoryDir)),
        fileCount,
      }
    }),
  )

  return resolved
    .filter((project) => project.isCurrent || project.exists || project.fileCount > 0)
    .sort((a, b) => {
      if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1
      if (a.fileCount !== b.fileCount) return b.fileCount - a.fileCount
      return a.label.localeCompare(b.label)
    })
}

function addProject(projects: Map<string, MemoryProject>, id: string, isCurrent: boolean) {
  if (!isValidProjectId(id)) return
  const existing = projects.get(id)
  if (existing) {
    existing.isCurrent = existing.isCurrent || isCurrent
    return
  }
  projects.set(id, {
    id,
    label: unsanitizeProjectLabel(id),
    memoryDir: path.join(getProjectsDir(), id, 'memory'),
    exists: false,
    fileCount: 0,
    isCurrent,
  })
}

async function listMemoryFiles(projectId: string): Promise<MemoryFile[]> {
  const memoryDir = await ensureMemoryDirBoundary(projectId, { mustExist: false })
  if (!(await directoryExists(memoryDir))) return []

  const files: MemoryFile[] = []

  async function walk(dir: string, prefix = ''): Promise<void> {
    if (files.length >= MAX_MEMORY_FILES) return

    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name)
    })

    for (const entry of entries) {
      if (files.length >= MAX_MEMORY_FILES) break
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue

      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath, relativePath)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue

      const stat = await fs.stat(fullPath)
      let type: string | undefined
      let description: string | undefined
      try {
        if (stat.size <= MAX_MEMORY_FILE_BYTES) {
          const raw = await fs.readFile(fullPath, 'utf-8')
          const parsed = parseFrontmatter(raw, fullPath)
          type = parseMemoryType(parsed.frontmatter.type) ?? undefined
          description =
            typeof parsed.frontmatter.description === 'string'
              ? parsed.frontmatter.description
              : undefined
        }
      } catch {
        // Metadata is best-effort. The file remains editable from the UI.
      }

      files.push({
        path: relativePath,
        name: entry.name,
        bytes: stat.size,
        updatedAt: stat.mtime.toISOString(),
        type,
        description,
        title: relativePath === 'MEMORY.md' ? 'MEMORY.md' : entry.name.replace(/\.md$/, ''),
        isIndex: relativePath === 'MEMORY.md',
      })
    }
  }

  await walk(memoryDir)
  return files.sort((a, b) => {
    if (a.isIndex !== b.isIndex) return a.isIndex ? -1 : 1
    return a.path.localeCompare(b.path)
  })
}

async function handleMemoryFile(req: Request, url: URL): Promise<Response> {
  if (req.method === 'GET') {
    const projectId = requireProjectId(url)
    const relativePath = requireMemoryPath(url.searchParams.get('path'))
    const fullPath = await resolveMemoryFilePath(projectId, relativePath, {
      mustExist: true,
    })
    const stat = await fs.stat(fullPath)
    if (stat.size > MAX_MEMORY_FILE_BYTES) {
      throw ApiError.badRequest(`Memory file is too large to edit: ${relativePath}`)
    }
    return Response.json({
      file: {
        path: relativePath,
        content: await fs.readFile(fullPath, 'utf-8'),
        updatedAt: stat.mtime.toISOString(),
        bytes: stat.size,
      },
    })
  }

  if (req.method === 'PUT') {
    const body = await parseJsonBody(req)
    const projectId = typeof body.projectId === 'string' ? body.projectId : ''
    const relativePath = requireMemoryPath(
      typeof body.path === 'string' ? body.path : undefined,
    )
    const content = typeof body.content === 'string' ? body.content : undefined
    if (content === undefined) {
      throw ApiError.badRequest('Missing or invalid "content" in request body')
    }
    if (Buffer.byteLength(content, 'utf-8') > MAX_MEMORY_FILE_BYTES) {
      throw ApiError.badRequest('Memory file content exceeds 512 KB')
    }

    const fullPath = await resolveMemoryFilePath(projectId, relativePath, {
      mustExist: false,
    })
    const memoryDir = await ensureMemoryDirBoundary(projectId, { mustExist: false })
    await fs.mkdir(path.dirname(fullPath), { recursive: true, mode: 0o700 })
    await assertWithinDirectory(path.dirname(fullPath), memoryDir, true)
    if (await fileExists(fullPath)) {
      await assertWithinDirectory(fullPath, memoryDir, true)
    }
    await fs.writeFile(fullPath, content, { encoding: 'utf-8', mode: 0o600 })
    const stat = await fs.stat(fullPath)
    return Response.json({
      ok: true,
      file: {
        path: relativePath,
        updatedAt: stat.mtime.toISOString(),
        bytes: stat.size,
      },
    })
  }

  throw methodNotAllowed(req.method)
}

function requireProjectId(url: URL): string {
  const projectId = url.searchParams.get('projectId')
  if (!projectId) throw ApiError.badRequest('Missing projectId')
  return projectId
}

function requireMemoryPath(value: string | null | undefined): string {
  if (!value || typeof value !== 'string') {
    throw ApiError.badRequest('Missing memory file path')
  }
  const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '')
  if (
    normalized.length === 0 ||
    normalized.includes('\0') ||
    normalized.split('/').some(part => part === '' || part === '.' || part === '..') ||
    !normalized.endsWith('.md')
  ) {
    throw ApiError.badRequest('Memory path must be a relative .md file path')
  }
  return normalized
}

async function resolveMemoryFilePath(
  projectId: string,
  relativePath: string,
  opts: { mustExist: boolean },
): Promise<string> {
  const memoryDir = await ensureMemoryDirBoundary(projectId, {
    mustExist: opts.mustExist,
  })
  const candidate = path.resolve(memoryDir, relativePath)
  await assertWithinDirectory(candidate, memoryDir, opts.mustExist)
  return candidate
}

async function ensureMemoryDirBoundary(
  projectId: string,
  opts: { mustExist: boolean },
): Promise<string> {
  if (!isValidProjectId(projectId)) {
    throw ApiError.badRequest('Invalid projectId')
  }
  const projectsDir = path.resolve(getProjectsDir())
  const projectDir = path.resolve(projectsDir, projectId)
  await assertWithinDirectory(projectDir, projectsDir, false)
  const memoryDir = path.resolve(projectDir, 'memory')
  if (await directoryExists(projectDir)) {
    await assertWithinDirectory(projectDir, projectsDir, true)
  }
  if (await directoryExists(memoryDir)) {
    await assertWithinDirectory(memoryDir, projectDir, true)
  }
  if (opts.mustExist && !(await directoryExists(memoryDir))) {
    throw ApiError.notFound(`Memory project not found: ${projectId}`)
  }
  return memoryDir
}

async function assertWithinDirectory(
  candidate: string,
  directory: string,
  mustExist: boolean,
): Promise<void> {
  const resolvedDirectory = mustExist
    ? await safeRealpath(directory)
    : path.resolve(directory)
  const resolvedCandidate = mustExist
    ? await safeRealpath(candidate)
    : path.resolve(candidate)
  const boundary = resolvedDirectory.endsWith(path.sep)
    ? resolvedDirectory
    : `${resolvedDirectory}${path.sep}`
  if (resolvedCandidate !== resolvedDirectory && !resolvedCandidate.startsWith(boundary)) {
    throw ApiError.badRequest('Path escapes memory directory')
  }
}

async function safeRealpath(targetPath: string): Promise<string> {
  try {
    return await fs.realpath(targetPath)
  } catch {
    return path.resolve(targetPath)
  }
}

function isValidProjectId(projectId: string): boolean {
  return (
    projectId.length > 0 &&
    !projectId.includes('\0') &&
    !projectId.includes('/') &&
    !projectId.includes('\\') &&
    projectId !== '.' &&
    projectId !== '..'
  )
}

function getProjectsDir(): string {
  return path.join(getClaudeConfigHomeDir(), 'projects')
}

function getProjectIdForCwd(cwd: string): string {
  return sanitizePath(findCanonicalGitRoot(cwd) ?? cwd)
}

async function resolveProjectLabel(projectId: string, currentCwd: string): Promise<string> {
  const currentRoot = findCanonicalGitRoot(currentCwd) ?? currentCwd
  if (sanitizePath(currentRoot) === projectId) return currentRoot

  const sessionPath = await inferProjectPathFromSessionFiles(projectId)
  if (sessionPath) return sessionPath

  const filesystemPath = await inferProjectPathFromExistingDirectory(projectId)
  return filesystemPath ?? unsanitizeProjectLabel(projectId)
}

async function inferProjectPathFromSessionFiles(projectId: string): Promise<string | undefined> {
  const projectDir = path.join(getProjectsDir(), projectId)
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(projectDir, { withFileTypes: true })
  } catch {
    return undefined
  }

  const sessionFiles: Array<{ filePath: string; mtimeMs: number }> = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
    const filePath = path.join(projectDir, entry.name)
    try {
      const stat = await fs.stat(filePath)
      sessionFiles.push({ filePath, mtimeMs: stat.mtimeMs })
    } catch {
      // A racing delete should not hide the rest of the memory projects.
    }
  }

  sessionFiles.sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const { filePath } of sessionFiles.slice(0, PROJECT_LABEL_SESSION_SCAN_LIMIT)) {
    const head = await readFileHead(filePath, PROJECT_LABEL_HEAD_BYTES)
    const candidate =
      extractJsonStringField(head, 'cwd') ??
      extractJsonStringField(head, 'workDir') ??
      extractJsonStringField(head, 'projectPath')
    if (candidate && path.isAbsolute(candidate)) return candidate.normalize('NFC')
  }

  return undefined
}

async function readFileHead(filePath: string, bytes: number): Promise<string> {
  const handle = await fs.open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
    return buffer.subarray(0, bytesRead).toString('utf-8')
  } catch {
    return ''
  } finally {
    await handle.close()
  }
}

async function inferProjectPathFromExistingDirectory(projectId: string): Promise<string | undefined> {
  const roots = Array.from(new Set([
    homedir(),
    process.env.HOME,
    process.env.USERPROFILE,
    '/private/tmp',
    '/tmp',
  ].filter((root): root is string => Boolean(root && path.isAbsolute(root)))))

  for (const root of roots) {
    const resolvedRoot = path.resolve(root)
    if (!sanitizedPrefixCanMatch(projectId, sanitizePath(resolvedRoot))) continue
    const state = { visited: 0 }
    const match = await findDirectoryBySanitizedPath(projectId, resolvedRoot, 0, state)
    if (match) return match.normalize('NFC')
  }

  return undefined
}

async function findDirectoryBySanitizedPath(
  projectId: string,
  candidate: string,
  depth: number,
  state: { visited: number },
): Promise<string | undefined> {
  if (state.visited >= PROJECT_LABEL_FS_SEARCH_NODE_LIMIT) return undefined
  state.visited += 1

  const candidateId = sanitizePath(candidate)
  if (candidateId === projectId) return candidate
  if (depth >= PROJECT_LABEL_FS_SEARCH_DEPTH || !sanitizedPrefixCanMatch(projectId, candidateId)) {
    return undefined
  }

  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(candidate, { withFileTypes: true })
  } catch {
    return undefined
  }

  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const child = path.join(candidate, entry.name)
    if (!sanitizedPrefixCanMatch(projectId, sanitizePath(child))) continue
    if (entry.isSymbolicLink() && !(await directoryExists(child))) continue
    const match = await findDirectoryBySanitizedPath(projectId, child, depth + 1, state)
    if (match) return match
  }

  return undefined
}

function sanitizedPrefixCanMatch(projectId: string, prefix: string): boolean {
  if (projectId === prefix) return true
  return prefix.endsWith('-')
    ? projectId.startsWith(prefix)
    : projectId.startsWith(`${prefix}-`)
}

function unsanitizeProjectLabel(projectId: string): string {
  return projectId.replace(/^-/, '/').replace(/-/g, '/')
}

async function directoryExists(dir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dir)
    return stat.isDirectory()
  } catch {
    return false
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath)
    return stat.isFile()
  } catch {
    return false
  }
}

async function countMarkdownFiles(dir: string): Promise<number> {
  let count = 0
  async function walk(current: string): Promise<void> {
    if (count >= MAX_MEMORY_FILES) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (count >= MAX_MEMORY_FILES) break
      if (entry.name.startsWith('.')) continue
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath)
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        count++
      }
    }
  }
  await walk(dir)
  return count
}

async function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }
}

function methodNotAllowed(method: string): ApiError {
  return new ApiError(405, `Method ${method} not allowed`, 'METHOD_NOT_ALLOWED')
}
