/**
 * Workspace file write service — handles the user-driven save path for the
 * in-app editor (Phase 2 of editor-lsp-foundation).
 *
 * Responsibilities:
 *   - Validate the request (Zod schema, content size, hash format).
 *   - Resolve the target path inside the session's workspace root, with
 *     symlink-aware containment so `..` traversal and rogue symlinks cannot
 *     escape the workspace.
 *   - Detect concurrent edits via a `expectedBaseHash` (409 stale-base when
 *     the on-disk file no longer matches what the editor opened).
 *   - Write atomically: temp file in the same directory, `wx` open flag,
 *     `fsync`, then `rename`. Windows EBUSY/EPERM gets a short retry loop.
 *   - Round-trip `bom` and `lineEnding` so the editor never silently
 *     normalizes a file to LF/UTF-8 when the source was CRLF/UTF-8-BOM.
 *   - On success, emit `workspace.file.saved { source: 'user' }` via the
 *     shared WS emitter so the desktop conflict-banner contract holds.
 *
 * No `agent` source path — that ships in PR-4 (Phase 4) via AgentEditTool.
 *
 * _Requirements: 2.1-2.9 (Phase 2 task 10)_
 */

import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import { emitWorkspaceFileSaved } from '../events/workspaceFileSaved.js'

export const WORKSPACE_MAX_PATH_LENGTH = 1024
export const WORKSPACE_MAX_CONTENT_BYTES = 10 * 1024 * 1024
const HEX_HASH_64 = /^[0-9a-f]{64}$/

const EBUSY_RETRY_DELAYS_MS = [50, 50, 50] as const

const lineEndingSchema = z.enum(['LF', 'CRLF', 'CR'])
const bomSchema = z.enum(['none', 'utf-8'])

export const writeWorkspaceFileSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(WORKSPACE_MAX_PATH_LENGTH, {
      message: `path exceeds ${WORKSPACE_MAX_PATH_LENGTH} characters`,
    }),
  content: z.string().refine((s) => Buffer.byteLength(s, 'utf-8') <= WORKSPACE_MAX_CONTENT_BYTES, {
    message: `content exceeds ${WORKSPACE_MAX_CONTENT_BYTES} bytes`,
  }),
  expectedBaseHash: z.string().regex(HEX_HASH_64, {
    message: 'expectedBaseHash must be a 64-character lowercase hex string',
  }),
  bom: bomSchema,
  lineEnding: lineEndingSchema,
})

export type WriteWorkspaceFileInput = z.infer<typeof writeWorkspaceFileSchema>

export type WriteWorkspaceFileSuccess = {
  ok: true
  hash: string
  bytes: number
  timestamp: number
}

export type WriteWorkspaceFileFailure = {
  ok: false
  status: 400 | 404 | 409 | 500
  error: string
  message: string
  details?: Record<string, unknown>
}

export type WriteWorkspaceFileResult = WriteWorkspaceFileSuccess | WriteWorkspaceFileFailure

export type ResolveSessionWorkDir = (sessionId: string) => Promise<string | null>

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function utf8BomBytes(): Buffer {
  return Buffer.from([0xef, 0xbb, 0xbf])
}

function applyLineEnding(content: string, lineEnding: WriteWorkspaceFileInput['lineEnding']): string {
  // The editor normalizes everything to LF in memory, so we always re-encode
  // line endings on save based on the buffer's recorded style.
  if (lineEnding === 'LF') return content
  // Strip any CR that snuck in, then re-emit the requested style.
  const lf = content.replace(/\r\n?/g, '\n')
  if (lineEnding === 'CRLF') return lf.replace(/\n/g, '\r\n')
  return lf.replace(/\n/g, '\r')
}

function buildPayloadBytes(input: WriteWorkspaceFileInput): Buffer {
  const text = applyLineEnding(input.content, input.lineEnding)
  const body = Buffer.from(text, 'utf-8')
  if (input.bom === 'utf-8') return Buffer.concat([utf8BomBytes(), body])
  return body
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

function isWithinRoot(target: string, root: string): boolean {
  // Normalize trailing separators so `/repo` is treated the same as `/repo/`.
  const rootSep = root.endsWith(path.sep) ? root : root + path.sep
  return target === root || target.startsWith(rootSep)
}

async function safeReadFile(absolutePath: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(absolutePath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

function isRetryableWindowsError(err: NodeJS.ErrnoException): boolean {
  if (process.platform !== 'win32') return false
  return err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES'
}

async function atomicWrite(targetAbsolute: string, payload: Buffer): Promise<void> {
  const dir = path.dirname(targetAbsolute)
  const base = path.basename(targetAbsolute)
  const tempName = `.${base}.tmp.${process.pid}.${Date.now().toString(36)}.${Math.random()
    .toString(36)
    .slice(2, 8)}`
  const tempPath = path.join(dir, tempName)

  let fileHandle: fs.FileHandle | null = null
  try {
    fileHandle = await fs.open(tempPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o644)
    await fileHandle.writeFile(payload)
    await fileHandle.sync()
  } finally {
    if (fileHandle) {
      try {
        await fileHandle.close()
      } catch {
        /* swallow close failures — primary write either succeeded or already threw. */
      }
    }
  }

  try {
    let attempt = 0
    while (true) {
      try {
        await fs.rename(tempPath, targetAbsolute)
        return
      } catch (err) {
        const nodeErr = err as NodeJS.ErrnoException
        if (attempt < EBUSY_RETRY_DELAYS_MS.length && isRetryableWindowsError(nodeErr)) {
          await delay(EBUSY_RETRY_DELAYS_MS[attempt]!)
          attempt += 1
          continue
        }
        throw err
      }
    }
  } catch (err) {
    // Best-effort cleanup of the temp file when rename fails.
    try {
      await fs.unlink(tempPath)
    } catch {
      /* ignore */
    }
    throw err
  }
}

export class WorkspaceFileService {
  constructor(private readonly resolveSessionWorkDir: ResolveSessionWorkDir) {}

  async writeFile(sessionId: string, raw: unknown): Promise<WriteWorkspaceFileResult> {
    const parsed = writeWorkspaceFileSchema.safeParse(raw)
    if (!parsed.success) {
      const issues = parsed.error.issues
      return {
        ok: false,
        status: 400,
        error: 'INVALID_REQUEST',
        message: issues[0]?.message ?? 'Invalid request body',
        details: { issues },
      }
    }
    const input = parsed.data

    const workDir = await this.resolveSessionWorkDir(sessionId)
    if (!workDir) {
      return {
        ok: false,
        status: 404,
        error: 'SESSION_NOT_FOUND',
        message: `Session ${sessionId} has no workspace`,
      }
    }

    let canonicalRoot: string
    try {
      canonicalRoot = await fs.realpath(workDir)
    } catch {
      return {
        ok: false,
        status: 500,
        error: 'WORKSPACE_ROOT_UNRESOLVABLE',
        message: 'Failed to canonicalize workspace root',
      }
    }

    // Reject absolute paths and paths whose lexical resolution escapes the root.
    if (path.isAbsolute(input.path)) {
      return {
        ok: false,
        status: 400,
        error: 'PATH_NOT_RELATIVE',
        message: 'path must be a relative path inside the workspace',
      }
    }

    const lexicalAbsolute = path.resolve(canonicalRoot, input.path)
    if (!isWithinRoot(lexicalAbsolute, canonicalRoot)) {
      return {
        ok: false,
        status: 400,
        error: 'PATH_ESCAPES_WORKSPACE',
        message: 'path resolves outside the workspace root',
      }
    }

    // Symlink-aware check: realpath the parent (which exists) and confirm the
    // resolved target stays inside the canonical root.
    const parentDir = path.dirname(lexicalAbsolute)
    let canonicalParent: string
    try {
      canonicalParent = await fs.realpath(parentDir)
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException
      if (nodeErr.code === 'ENOENT') {
        return {
          ok: false,
          status: 400,
          error: 'PARENT_DIRECTORY_MISSING',
          message: `Parent directory does not exist: ${path.relative(canonicalRoot, parentDir)}`,
        }
      }
      return {
        ok: false,
        status: 500,
        error: 'PATH_RESOLVE_FAILED',
        message: 'Failed to resolve parent directory',
      }
    }
    const canonicalTarget = path.join(canonicalParent, path.basename(lexicalAbsolute))
    if (!isWithinRoot(canonicalTarget, canonicalRoot)) {
      return {
        ok: false,
        status: 400,
        error: 'PATH_ESCAPES_WORKSPACE',
        message: 'path resolves outside the workspace root via symlink',
      }
    }

    // Stale-base check: read the current file and compare its hash against
    // what the editor opened with. Missing file is acceptable only when the
    // editor passed the empty-file hash (sha256 of zero bytes).
    let currentBuf: Buffer | null
    try {
      currentBuf = await safeReadFile(canonicalTarget)
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException
      return {
        ok: false,
        status: 500,
        error: 'READ_CURRENT_FAILED',
        message: nodeErr.message,
      }
    }
    const currentHash = currentBuf ? sha256Hex(currentBuf) : sha256Hex(Buffer.alloc(0))
    if (currentHash !== input.expectedBaseHash) {
      return {
        ok: false,
        status: 409,
        error: 'STALE_BASE',
        message: 'File has changed on disk since it was opened',
        details: { currentHash, expectedBaseHash: input.expectedBaseHash },
      }
    }

    const payload = buildPayloadBytes(input)
    try {
      await atomicWrite(canonicalTarget, payload)
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException
      return {
        ok: false,
        status: 500,
        error: 'ATOMIC_WRITE_FAILED',
        message: nodeErr.message,
        details: { code: nodeErr.code },
      }
    }

    const newHash = sha256Hex(payload)
    const timestamp = Date.now()
    emitWorkspaceFileSaved({
      sessionId,
      path: input.path,
      hash: newHash,
      source: 'user',
      timestamp,
    })

    return { ok: true, hash: newHash, bytes: payload.length, timestamp }
  }
}
