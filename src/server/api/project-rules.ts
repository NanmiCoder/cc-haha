/**
 * Project Rules (CLAUDE.md) REST API
 *
 * GET  /api/project-rules         — List all known projects and their CLAUDE.md files
 * POST /api/project-rules/create  — Create a CLAUDE.md file if it doesn't exist
 *
 * Project discovery mirrors the memory API: scan ~/.claude/projects/ for known
 * project IDs, then resolve each ID back to a real filesystem path by reading
 * session (.jsonl) file heads for a `cwd` field, falling back to a sanitized
 * directory search. For each resolved project we check all CLAUDE.md locations
 * the harness actually loads:
 *  - Project root: CLAUDE.md, .claude/CLAUDE.md, .claude/rules/*.md, CLAUDE.local.md
 * Plus user-level rules shared across all projects:
 *  - ~/.claude/CLAUDE.md, ~/.claude/rules/*.md
 */

import * as path from 'path'
import * as fs from 'fs/promises'
import { homedir } from 'os'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { getCwd } from '../../utils/cwd.js'
import { findCanonicalGitRoot } from '../../utils/git.js'
import { sanitizePath, containsPathTraversal } from '../../utils/path.js'

type RuleFile = {
  path: string
  exists: boolean
  type: 'project' | 'user' | 'local'
  label: string
}

type ProjectRulesEntry = {
  id: string
  label: string
  projectPath: string | null
  isCurrent: boolean
  files: RuleFile[]
}

// Bounds for resolving a project ID back to a filesystem path.
const SESSION_SCAN_LIMIT = 5
const HEAD_BYTES = 4096
const FS_SEARCH_DEPTH = 8
const FS_SEARCH_NODE_LIMIT = 4000

export async function handleProjectRulesApi(
  req: Request,
  url: URL,
  segments: string[],
): Promise<Response> {
  const sub = segments[2]

  if (req.method === 'GET' && !sub) {
    return await getProjectRules(url)
  }

  if (req.method === 'POST' && sub === 'create') {
    return await createProjectRulesFile(req, url)
  }

  return Response.json(
    { error: 'Not Found', message: `Unknown project-rules endpoint` },
    { status: 404 },
  )
}

function getProjectsDir(): string {
  return path.join(getClaudeConfigHomeDir(), 'projects')
}

async function getProjectRules(url: URL): Promise<Response> {
  const cwd = url.searchParams.get('cwd') || getCwd()
  const claudeHome = getClaudeConfigHomeDir()
  const projectsDir = getProjectsDir()

  // Current project: prefer git root, fall back to cwd.
  const currentProjectPath = (findCanonicalGitRoot(cwd) ?? cwd).normalize('NFC')
  const currentProjectId = sanitizePath(currentProjectPath)

  // Collect project IDs: current + every dir under ~/.claude/projects/
  const projectIds = new Map<string, boolean>() // id -> isCurrent
  projectIds.set(currentProjectId, true)

  try {
    const entries = await fs.readdir(projectsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!isValidProjectId(entry.name)) continue
      if (!projectIds.has(entry.name)) projectIds.set(entry.name, false)
    }
  } catch {
    // projects dir may not exist yet
  }

  const projects: ProjectRulesEntry[] = await Promise.all(
    Array.from(projectIds.entries()).map(async ([id, isCurrent]) => {
      const projectPath = isCurrent
        ? currentProjectPath
        : await resolveProjectPath(id)
      const files = projectPath ? await scanProjectFiles(projectPath) : []
      return {
        id,
        label: projectPath ?? unsanitizeProjectLabel(id),
        projectPath,
        isCurrent,
        files,
      }
    }),
  )

  // User-level rules (shared across all projects)
  const userFiles: RuleFile[] = []
  const userMd = path.join(claudeHome, 'CLAUDE.md')
  userFiles.push({ path: userMd, exists: await fileExists(userMd), type: 'user', label: '~/.claude/CLAUDE.md' })
  for (const rulePath of await listMdFiles(path.join(claudeHome, 'rules'))) {
    userFiles.push({ path: rulePath, exists: true, type: 'user', label: '~/.claude/rules/' + path.basename(rulePath) })
  }

  // Sort: current first, then projects with existing files, then alphabetical.
  projects.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1
    const aHas = a.files.some(f => f.exists)
    const bHas = b.files.some(f => f.exists)
    if (aHas !== bHas) return aHas ? -1 : 1
    return a.label.localeCompare(b.label)
  })

  // Keep: current project, or any project we can resolve to a real directory.
  // The UI surfaces existence per-file, so projects without any rules yet are
  // still useful entries (the user creates rules from there). Projects whose
  // sanitized id no longer maps to a real path (deleted folders, stale ids)
  // are filtered out.
  const filtered = projects.filter(
    p => p.isCurrent || p.projectPath !== null,
  )

  return Response.json({ projects: filtered, userFiles, cwd })
}

/** Scan a project directory for all CLAUDE.md rule file locations. */
async function scanProjectFiles(projectPath: string): Promise<RuleFile[]> {
  const files: RuleFile[] = []

  const rootMd = path.join(projectPath, 'CLAUDE.md')
  files.push({ path: rootMd, exists: await fileExists(rootMd), type: 'project', label: 'CLAUDE.md' })

  const dotClaudeMd = path.join(projectPath, '.claude', 'CLAUDE.md')
  files.push({ path: dotClaudeMd, exists: await fileExists(dotClaudeMd), type: 'project', label: '.claude/CLAUDE.md' })

  for (const rulePath of await listMdFiles(path.join(projectPath, '.claude', 'rules'))) {
    files.push({ path: rulePath, exists: true, type: 'project', label: '.claude/rules/' + path.basename(rulePath) })
  }

  const localMd = path.join(projectPath, 'CLAUDE.local.md')
  files.push({ path: localMd, exists: await fileExists(localMd), type: 'local', label: 'CLAUDE.local.md' })

  return files
}

async function createProjectRulesFile(req: Request, url: URL): Promise<Response> {
  let body: { scope?: string; cwd?: string; filename?: string }
  try {
    body = await req.json() as { scope?: string; cwd?: string; filename?: string }
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const scope = body.scope
  const cwd = body.cwd || url.searchParams.get('cwd') || getCwd()
  const filename = body.filename || 'CLAUDE.md'

  // Security: filename is user-controlled and flows into path.join below.
  // Reject traversal ("../") and absolute paths so a crafted filename cannot
  // write outside the intended scope directory. The harness only ever sends
  // basenames, but this endpoint is unauthenticated server input.
  if (containsPathTraversal(filename) || path.isAbsolute(filename) || filename.includes('\0')) {
    return Response.json({ error: 'Invalid filename' }, { status: 400 })
  }

  let filePath: string
  if (scope === 'project-root') {
    filePath = path.join(cwd, filename)
  } else if (scope === 'project') {
    filePath = path.join(cwd, '.claude', filename)
  } else if (scope === 'project-rules') {
    filePath = path.join(cwd, '.claude', 'rules', filename)
  } else if (scope === 'user') {
    filePath = path.join(getClaudeConfigHomeDir(), filename)
  } else if (scope === 'user-rules') {
    filePath = path.join(getClaudeConfigHomeDir(), 'rules', filename)
  } else if (scope === 'local') {
    filePath = path.join(cwd, 'CLAUDE.local.md')
  } else {
    return Response.json({ error: 'Invalid scope' }, { status: 400 })
  }

  if (await fileExists(filePath)) {
    return Response.json({ ok: true, path: filePath, created: false })
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, getTemplate(scope, filename), 'utf-8')

  return Response.json({ ok: true, path: filePath, created: true })
}

// --- Project ID → filesystem path resolution (mirrors memory.ts) ---

/** Resolve a sanitized project ID back to a real directory path. */
async function resolveProjectPath(projectId: string): Promise<string | null> {
  const fromSession = await inferProjectPathFromSessionFiles(projectId)
  if (fromSession) return fromSession

  const fromFs = await inferProjectPathFromExistingDirectory(projectId)
  return fromFs ?? null
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
      // racing delete — skip
    }
  }

  sessionFiles.sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const { filePath } of sessionFiles.slice(0, SESSION_SCAN_LIMIT)) {
    const head = await readFileHead(filePath, HEAD_BYTES)
    const candidate =
      extractJsonStringField(head, 'cwd') ??
      extractJsonStringField(head, 'workDir') ??
      extractJsonStringField(head, 'projectPath')
    if (candidate && path.isAbsolute(candidate)) return candidate.normalize('NFC')
  }

  return undefined
}

async function readFileHead(filePath: string, bytes: number): Promise<string> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(filePath, 'r')
    const buffer = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
    return buffer.subarray(0, bytesRead).toString('utf-8')
  } catch {
    return ''
  } finally {
    await handle?.close()
  }
}

function extractJsonStringField(head: string, field: string): string | undefined {
  // Cheap extraction without full JSON parse — head may be truncated mid-line.
  const re = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`)
  const m = head.match(re)
  if (!m) return undefined
  try {
    return JSON.parse(`"${m[1]}"`)
  } catch {
    return undefined
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
    const match = await findDirectoryBySanitizedPath(projectId, resolvedRoot, 0, { visited: 0 })
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
  if (state.visited >= FS_SEARCH_NODE_LIMIT) return undefined
  state.visited += 1

  const candidateId = sanitizePath(candidate)
  if (candidateId === projectId) return candidate
  if (depth >= FS_SEARCH_DEPTH || !sanitizedPrefixCanMatch(projectId, candidateId)) {
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

// --- Misc helpers ---

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

function unsanitizeProjectLabel(projectId: string): string {
  return projectId.replace(/^-/, '/').replace(/-/g, '/')
}

function getTemplate(scope: string, filename: string): string {
  if (scope === 'local') {
    return '# Local Rules\n\n<!-- Local rules (gitignored). Add machine-specific instructions here. -->\n'
  }
  if (scope?.includes('rules')) {
    const name = filename.replace(/\.md$/, '')
    return `# ${name}\n\n<!-- Add rule content here. -->\n`
  }
  if (scope === 'user' || scope === 'user-rules') {
    return '# User Rules\n\n<!-- Global rules applied to all projects. -->\n'
  }
  return '# Project Rules\n\n<!-- Project-specific instructions loaded into every conversation. -->\n'
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function directoryExists(dir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dir)
    return stat.isDirectory()
  } catch {
    return false
  }
}

async function listMdFiles(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    return entries
      .filter(e => e.isFile() && e.name.endsWith('.md'))
      .map(e => path.join(dirPath, e.name))
  } catch {
    return []
  }
}
