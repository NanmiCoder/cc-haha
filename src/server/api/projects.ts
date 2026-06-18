/**
 * /api/projects/* — endpoints derived from the on-disk projects directory
 * (`~/.claude/projects/<sanitized-workDir>/...`) plus git state.
 *
 * Currently exposes:
 *   GET  /api/projects/recent-activity?workDir=<absolute-path>
 *   POST /api/projects/sessions/clear   body: { projectId } | { workDir }
 *   GET  /api/projects/sessions/export?workDir=<abs>&sessionId=<id>
 *   POST /api/projects/sessions/import  multipart: file=<jsonl>, workDir=<abs>
 *
 * The first returns a "what was the user just doing in this project" snapshot
 * for the desktop welcome screen. The second permanently deletes every .jsonl
 * session file (and the matching .summary.json sidecar) under the named
 * project so the project disappears from the sidebar/listings. The export
 * and import endpoints move single sessions in/out of a project as NDJSON.
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import { getRecentActivity } from '../services/projectActivityService.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { sanitizePath } from '../../utils/path.js'

function getProjectsDir(): string {
  return path.join(getClaudeConfigHomeDir(), 'projects')
}

function isValidProjectId(projectId: string): boolean {
  return (
    typeof projectId === 'string' &&
    projectId.length > 0 &&
    !projectId.includes('\0') &&
    !projectId.includes('/') &&
    !projectId.includes('\\') &&
    projectId !== '.' &&
    projectId !== '..'
  )
}

function isValidSessionId(sessionId: string): boolean {
  // Session ids are UUIDs in practice; accept the broader hex-and-dash shape
  // any uuid generator we'd use produces, but reject path separators / null.
  return (
    typeof sessionId === 'string' &&
    sessionId.length > 0 &&
    sessionId.length < 200 &&
    /^[A-Za-z0-9_-]+$/.test(sessionId)
  )
}

function projectIdFromWorkDir(workDir: string): string {
  return sanitizePath(workDir)
}

function resolveProjectDirFromBody(
  body: { projectId?: unknown; workDir?: unknown },
): string {
  // Accept either projectId (already sanitized) or workDir (an absolute path
  // that we sanitize ourselves). The desktop client passes workDir; backend
  // tooling can pass projectId directly.
  const { projectId, workDir } = body
  let resolvedId: string
  if (typeof projectId === 'string' && projectId.length > 0) {
    if (!isValidProjectId(projectId)) {
      throw ApiError.badRequest('Invalid projectId')
    }
    resolvedId = projectId
  } else if (typeof workDir === 'string' && workDir.length > 0 && path.isAbsolute(workDir)) {
    resolvedId = projectIdFromWorkDir(workDir)
    if (!isValidProjectId(resolvedId)) {
      throw ApiError.badRequest('workDir sanitized to an invalid id')
    }
  } else {
    throw ApiError.badRequest('Provide projectId or absolute workDir')
  }

  const projectsDir = path.resolve(getProjectsDir())
  const projectDir = path.resolve(path.join(projectsDir, resolvedId))
  if (
    projectDir !== path.join(projectsDir, resolvedId) ||
    !projectDir.startsWith(projectsDir + path.sep)
  ) {
    throw ApiError.badRequest('projectId resolves outside projects directory')
  }
  return projectDir
}

async function clearProjectSessions(req: Request): Promise<Response> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }

  const resolvedProjectDir = resolveProjectDirFromBody(body as { projectId?: unknown; workDir?: unknown })

  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(resolvedProjectDir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return Response.json({ ok: true, deletedSessions: 0, projectDirRemoved: false })
    }
    throw error
  }

  let deletedSessions = 0
  let nonSessionEntries = 0
  for (const entry of entries) {
    if (!entry.isFile()) {
      // Sub-directories (e.g. workspace snapshots tied to a session) are
      // intentionally preserved — they may hold user state we shouldn't drop.
      nonSessionEntries += 1
      continue
    }
    // Per-session artefacts: the JSONL transcript, plus its sidecar summary.
    if (entry.name.endsWith('.jsonl')) {
      try {
        await fs.unlink(path.join(resolvedProjectDir, entry.name))
        deletedSessions += 1
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      continue
    }
    if (entry.name.endsWith('.summary.json')) {
      try {
        await fs.unlink(path.join(resolvedProjectDir, entry.name))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      continue
    }
    nonSessionEntries += 1
  }

  // If the directory is now empty (no leftover memory/, etc.), remove it so
  // the project drops off the sidebar entirely.
  let projectDirRemoved = false
  if (nonSessionEntries === 0) {
    try {
      await fs.rmdir(resolvedProjectDir)
      projectDirRemoved = true
    } catch {
      // Race with another writer or non-empty after all — leave directory.
    }
  }

  return Response.json({ ok: true, deletedSessions, projectDirRemoved })
}

async function exportSession(url: URL): Promise<Response> {
  const workDir = url.searchParams.get('workDir')
  const sessionId = url.searchParams.get('sessionId')
  if (!workDir || !path.isAbsolute(workDir)) {
    throw ApiError.badRequest('Missing or non-absolute workDir')
  }
  if (!sessionId || !isValidSessionId(sessionId)) {
    throw ApiError.badRequest('Missing or invalid sessionId')
  }

  const projectDir = resolveProjectDirFromBody({ workDir })
  const filePath = path.join(projectDir, `${sessionId}.jsonl`)
  let content: Buffer
  try {
    content = await fs.readFile(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw ApiError.notFound(`Session not found: ${sessionId}`)
    }
    throw error
  }

  return new Response(new Uint8Array(content), {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Content-Disposition': `attachment; filename="${sessionId}.jsonl"`,
      'Content-Length': String(content.byteLength),
    },
  })
}

const MAX_IMPORT_BYTES = 50 * 1024 * 1024 // 50 MB hard cap to limit memory.

async function importSession(req: Request): Promise<Response> {
  const contentType = req.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    throw ApiError.badRequest('Expected multipart/form-data')
  }

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    throw ApiError.badRequest('Invalid multipart body')
  }

  const workDir = form.get('workDir')
  const file = form.get('file')

  if (typeof workDir !== 'string' || !path.isAbsolute(workDir)) {
    throw ApiError.badRequest('Missing or non-absolute workDir')
  }
  if (!(file instanceof Blob) || file.size === 0) {
    throw ApiError.badRequest('Missing file part')
  }
  if (file.size > MAX_IMPORT_BYTES) {
    throw ApiError.badRequest(`File too large (max ${MAX_IMPORT_BYTES} bytes)`)
  }

  const projectDir = resolveProjectDirFromBody({ workDir })
  const projectId = path.basename(projectDir)

  // Validate that the upload looks like NDJSON: every non-empty line must
  // parse as JSON. This rejects pasted binary or random files but keeps the
  // implementation cheap by bailing on the first bad line.
  const text = await file.text()
  const lines = text.split(/\r?\n/)
  let nonEmptyLines = 0
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    nonEmptyLines += 1
    try {
      JSON.parse(line)
    } catch {
      throw ApiError.badRequest('File is not valid NDJSON (one JSON object per line)')
    }
  }
  if (nonEmptyLines === 0) {
    throw ApiError.badRequest('File is empty')
  }

  // Always assign a fresh session id on import. Reusing the original id
  // could collide with an existing local session and is rarely useful — the
  // imported transcript is a snapshot, not a live session to resume.
  const newSessionId = randomUUID()
  const targetPath = path.join(projectDir, `${newSessionId}.jsonl`)

  await fs.mkdir(projectDir, { recursive: true })
  await fs.writeFile(targetPath, text, 'utf-8')

  return Response.json({
    ok: true,
    sessionId: newSessionId,
    projectId,
    bytes: text.length,
    nonEmptyLines,
  })
}

export async function handleProjectsApi(
  req: Request,
  url: URL,
  segments: string[],
): Promise<Response> {
  try {
    const sub = segments[2]

    if (sub === 'recent-activity') {
      if (req.method !== 'GET') {
        throw new ApiError(
          405,
          `Method ${req.method} not allowed on /api/projects/recent-activity`,
          'METHOD_NOT_ALLOWED',
        )
      }
      const workDir = url.searchParams.get('workDir')
      if (!workDir || !workDir.trim()) {
        throw ApiError.badRequest('Missing required query parameter: workDir')
      }
      const excludeSessionId = url.searchParams.get('excludeSessionId') || undefined
      const result = await getRecentActivity(workDir, {
        ...(excludeSessionId ? { excludeSessionId } : {}),
      })
      return Response.json(result)
    }

    if (sub === 'sessions' && segments[3] === 'clear') {
      if (req.method !== 'POST') {
        throw new ApiError(
          405,
          `Method ${req.method} not allowed on /api/projects/sessions/clear`,
          'METHOD_NOT_ALLOWED',
        )
      }
      return await clearProjectSessions(req)
    }

    if (sub === 'sessions' && segments[3] === 'export') {
      if (req.method !== 'GET') {
        throw new ApiError(
          405,
          `Method ${req.method} not allowed on /api/projects/sessions/export`,
          'METHOD_NOT_ALLOWED',
        )
      }
      return await exportSession(url)
    }

    if (sub === 'sessions' && segments[3] === 'import') {
      if (req.method !== 'POST') {
        throw new ApiError(
          405,
          `Method ${req.method} not allowed on /api/projects/sessions/import`,
          'METHOD_NOT_ALLOWED',
        )
      }
      return await importSession(req)
    }

    throw ApiError.notFound(`Unknown projects endpoint: ${sub ?? '(root)'}`)
  } catch (error) {
    return errorResponse(error)
  }
}
