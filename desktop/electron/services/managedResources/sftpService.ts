import { writeRemoteEdit } from './remoteEditWrite.js'
import crypto from 'node:crypto'
import { Buffer } from 'node:buffer'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { Client as SshClient, type SFTPWrapper } from 'ssh2'
import type { SshSession } from './sshSessionService.js'
import { isM4FileName } from '../../../src/features/managed-resources/api/m4IpcContract.js'

// ─────────────────────────────────────────────────────────────────────────────
// Module-public types
// ─────────────────────────────────────────────────────────────────────────────

export type SftpEntry = {
  name: string
  type: 'file' | 'directory' | 'symlink' | 'other'
  size: number
  mtimeMs: number
  mode: number
  uid: number
  gid: number
  /** Canonical POSIX path of the entry (joined to its parent). */
  absolutePath: string
}

export type SftpListInput = {
  connectionId: string
  ownerId: string
  generation: number
  absolutePath: string
}

export type SftpListResult = {
  parent: SftpEntry
  entries: SftpEntry[]
}

export type SftpStatInput = {
  connectionId: string
  ownerId: string
  generation: number
  absolutePath: string
}

export type TransferJobId = string

export type TransferDirection = 'upload' | 'download'

export type TransferState =
  | 'pending'
  | 'preparing'
  | 'in_progress'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type TransferError =
  | { code: 'STALE_GENERATION' }
  | { code: 'UNAUTHORIZED_OWNER' }
  | { code: 'RESOURCE_NOT_FOUND' }
  | { code: 'NOT_A_DIRECTORY' }
  | { code: 'NOT_A_FILE' }
  | { code: 'IS_SYMLINK' }
  | { code: 'FILE_TOO_LARGE'; size: number; max: number }
  | { code: 'INVALID_REMOTE_PATH'; reason: string }
  | { code: 'INVALID_LOCAL_PATH'; reason: string }
  | { code: 'INVALID_ENCODING'; reason: string }
  | { code: 'PERMISSION_DENIED' }
  | { code: 'CONNECTION_LOST' }
  | { code: 'DISCONNECTED' }
  | { code: 'CHECKSUM_MISMATCH'; expected: string; actual: string }
  | { code: 'SIZE_MISMATCH'; expected: number; actual: number }
  | { code: 'CANCELLED' }
  | { code: 'LOCAL_IO_ERROR'; reason: string }
  | { code: 'UNKNOWN'; reason: string }

export type TransferJob = {
  id: TransferJobId
  connectionId: string
  ownerId: string
  generation: number
  direction: TransferDirection
  remotePath: string
  localPath: string
  size: number
  transferred: number
  state: TransferState
  error: TransferError | null
  checksum: string | null
  startedAt: number
  finishedAt: number | null
  folder?: boolean
  entriesTotal?: number
  entriesCompleted?: number
}

export type LocalPathToken = {
  token: string
  /** Absolute path on the local filesystem the token resolves to. */
  absolutePath: string
  ownerId: string
  /** millisecond timestamp at which the token expires. */
  expiresAt: number
  /** purpose of the token, for telemetry and audit. */
  purpose: 'upload-source' | 'download-target' | 'editor-buffer'
}

export type RemoteEditSession = {
  id: string
  connectionId: string
  ownerId: string
  generation: number
  absolutePath: string
  baseRevision: string
  baseSha256: string
  baseSize: number
  baseMtimeMs: number
  text: string
  hasBom: boolean
  dirty: boolean
  openedAt: number
}

export type RemoteEditMetadata = {
  size: number
  mtimeMs: number
  mode: number
  lineEnding: 'lf' | 'crlf' | 'mixed'
  hasBom: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants & guards
// ─────────────────────────────────────────────────────────────────────────────

const MAX_FILE_BYTES = 2 * 1024 * 1024
const LOCAL_TOKEN_TTL_MS = 5 * 60 * 1000

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isUuid(value: unknown): boolean {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function safeRelativeName(raw: string): string | null {
  return isM4FileName(raw) ? raw : null
}

function isValidPosixPath(p: string): boolean {
  if (typeof p !== 'string') return false
  if (p.length === 0 || p.length > 4096) return false
  if (p.includes('\u0000')) return false
  if (p.includes('//')) return false
  return p.startsWith('/')
}

function detectLineEnding(text: string): 'lf' | 'crlf' | 'mixed' {
  let lf = false
  let crlf = false
  let lastWasCr = false
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    if (ch === 13) {
      lastWasCr = true
    } else if (ch === 10) {
      if (lastWasCr) crlf = true
      else lf = true
      lastWasCr = false
    } else {
      lastWasCr = false
    }
  }
  if (lf && crlf) return 'mixed'
  if (crlf) return 'crlf'
  return 'lf'
}

// ─────────────────────────────────────────────────────────────────────────────
// Local path token store — owner-bound, scoped to the user-data dir only.
// The renderer can never inject an arbitrary local path. Tokens are minted
// by the main process when the user picks a file through the Electron
// showSaveDialog/showOpenDialog flow, or when a download target needs a
// fixed local landing path.
// ─────────────────────────────────────────────────────────────────────────────

export type LocalPathService = {
  mintUploadToken: (input: {
    ownerId: string
    /** Filename chosen by the user; only used inside the user-data dir. */
    fileName: string
  }) => Promise<LocalPathToken>
  mintDownloadToken: (input: {
    ownerId: string
    fileName: string
  }) => Promise<LocalPathToken>
  resolveToken: (token: string, ownerId: string, purpose: LocalPathToken['purpose']) => string | null
  revokeToken: (token: string, ownerId: string) => void
  renewToken: (token: string, ownerId: string) => void
  clearForOwner: (ownerId: string) => void
  dispose: () => void
}

type TokenEntry = LocalPathToken & { handle: string }

export function createLocalPathService(opts: {
  userDataDir: string
}): LocalPathService {
  const tokens = new Map<string, TokenEntry>()
  // The userDataDir is the only allowed root for any resolved local path.
  // We pin it to a single subdirectory so a stray ".." or symlink cannot
  // escape it; the resolver verifies the resolved absolute path starts with
  // this directory before returning it.
  const landingDir = path.resolve(opts.userDataDir, 'managed-resources', 'transfers')
  // We do not mkdir at construction — the first mint will lazily create it.
  let dirReady = false
  async function ensureDir(): Promise<void> {
    if (dirReady) return
    await fsp.mkdir(landingDir, { recursive: true })
    dirReady = true
  }

  function isPathInsideRoot(absolute: string): boolean {
    const resolved = path.resolve(absolute)
    const rel = path.relative(landingDir, resolved)
    return !rel.startsWith('..') && !path.isAbsolute(rel)
  }

  function purgeExpired(now: number): void {
    for (const [handle, entry] of tokens.entries()) {
      if (entry.expiresAt <= now) tokens.delete(handle)
    }
  }

  async function mint(ownerId: string, fileName: string, purpose: LocalPathToken['purpose']): Promise<LocalPathToken> {
    if (typeof ownerId !== 'string' || ownerId.length === 0 || ownerId.length > 256) {
      throw new Error('UNAUTHORIZED_OWNER')
    }
    const safe = safeRelativeName(fileName)
    if (!safe) throw new Error('INVALID_LOCAL_PATH')
    await ensureDir()
    purgeExpired(Date.now())
    const token = crypto.randomUUID()
    const absolutePath = path.join(landingDir, `${token.slice(0, 8)}__${safe}`)
    if (!isPathInsideRoot(absolutePath)) throw new Error('INVALID_LOCAL_PATH')
    const entry: TokenEntry = {
      token,
      absolutePath,
      ownerId,
      expiresAt: Date.now() + LOCAL_TOKEN_TTL_MS,
      purpose,
      handle: token,
    }
    tokens.set(token, entry)
    return entry
  }

  return {
    mintUploadToken: input => mint(input.ownerId, input.fileName, 'upload-source'),
    mintDownloadToken: input => mint(input.ownerId, input.fileName, 'download-target'),
    resolveToken(token, ownerId, purpose) {
      const entry = tokens.get(token)
      if (!entry) return null
      if (entry.ownerId !== ownerId) return null
      if (entry.purpose !== purpose) return null
      if (entry.expiresAt <= Date.now()) {
        tokens.delete(token)
        return null
      }
      if (!isPathInsideRoot(entry.absolutePath)) {
        tokens.delete(token)
        return null
      }
      return entry.absolutePath
    },
    renewToken(token, ownerId) {
      const entry = tokens.get(token)
      if (!entry || entry.ownerId !== ownerId) throw new Error('UNAUTHORIZED_OWNER')
      entry.expiresAt = Date.now() + LOCAL_TOKEN_TTL_MS
    },
    revokeToken(token, ownerId) {
      const entry = tokens.get(token)
      if (entry && entry.ownerId === ownerId) tokens.delete(token)
    },
    clearForOwner(ownerId) {
      for (const [handle, entry] of tokens.entries()) {
        if (entry.ownerId === ownerId) tokens.delete(handle)
      }
    },
    dispose() {
      tokens.clear()
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-connection SFTP subsystem cache (lazy init, released on disconnect).
// ─────────────────────────────────────────────────────────────────────────────

export type SftpServiceOptions = {
  resolveSession: (input: { connectionId: string; ownerId: string }) => { session: SshSession; client: SshClient; generation: number }
  tempDir: string
}

export type SftpService = {
  listDirectory: (input: SftpListInput) => Promise<SftpListResult>
  stat: (input: SftpStatInput) => Promise<SftpEntry>
  ensureSftp: (connectionId: string, ownerId: string) => Promise<{ sftp: SFTPWrapper; client: SshClient }>
  dispose: () => void
}

function normalizeEntry(name: string, parentPath: string, attrs: any): SftpEntry {
  const isLink = attrs?.isSymbolicLink?.() || (attrs?.mode & 0o170000) === 0o120000
  const isDir = attrs?.isDirectory?.() || (attrs?.mode & 0o170000) === 0o040000
  const isFile = attrs?.isFile?.() || (attrs?.mode & 0o170000) === 0o100000
  const type: SftpEntry['type'] = isLink
    ? 'symlink'
    : isDir
      ? 'directory'
      : isFile
        ? 'file'
        : 'other'
  const absolutePath = name === '/' ? '/' : parentPath.endsWith('/') ? parentPath + name : `${parentPath}/${name}`
  return {
    name,
    type,
    size: typeof attrs?.size === 'number' ? attrs.size : 0,
    mtimeMs: typeof attrs?.mtimeMs === 'number' ? attrs.mtimeMs : typeof attrs?.mtime === 'number' ? attrs.mtime * 1000 : 0,
    mode: typeof attrs?.mode === 'number' ? attrs.mode : 0,
    uid: typeof attrs?.uid === 'number' ? attrs.uid : 0,
    gid: typeof attrs?.gid === 'number' ? attrs.gid : 0,
    absolutePath,
  }
}

function parentOf(absolutePath: string): string {
  const idx = absolutePath.lastIndexOf('/')
  if (idx <= 0) return '/'
  return absolutePath.slice(0, idx)
}

export function createSftpService(options: SftpServiceOptions): SftpService {
  const sftpCache = new Map<string, { sftp: SFTPWrapper; client: SshClient; ready: Promise<SFTPWrapper> }>()

  function getClient(client: SshClient, ownerId: string, connectionId: string): Promise<SFTPWrapper> {
    void ownerId
    const cached = sftpCache.get(connectionId)
    if (cached && cached.client === client) return cached.ready
    const ready = new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) reject(new Error('SFTP_UNAVAILABLE'))
        else {
          sftp.once('end', () => sftpCache.delete(connectionId))
          sftp.once('close', () => sftpCache.delete(connectionId))
          resolve(sftp)
        }
      })
    })
    const entry = { sftp: undefined as unknown as SFTPWrapper, client, ready }
    sftpCache.set(connectionId, entry)
    ready.then(s => { entry.sftp = s }).catch(() => undefined)
    return ready
  }

  function ensureOwner(input: { connectionId: string; ownerId: string }): { client: SshClient; generation: number } {
    const resolved = options.resolveSession(input)
    if (!resolved.client) throw new Error('DISCONNECTED')
    return resolved
  }

  function ensureConnection(input: SftpListInput | SftpStatInput): { client: SshClient; generation: number } {
    if (!isUuid(input.connectionId)) throw new Error('UNAUTHORIZED_OWNER')
    if (!isValidPosixPath(input.absolutePath)) throw new Error('INVALID_REMOTE_PATH')
    const session = ensureOwner({ connectionId: input.connectionId, ownerId: input.ownerId })
    if (session.generation !== input.generation) throw new Error('STALE_GENERATION')
    return session
  }

  async function listDirectoryInternal(sftp: SFTPWrapper, absolutePath: string, parentEntry: SftpEntry): Promise<SftpListResult> {
    const list = await new Promise<Array<{ filename: string; attrs: any }>>((resolve, reject) => {
      sftp.readdir(absolutePath, (err: any, items: any) => {
        if (err) reject(new Error('PERMISSION_DENIED'))
        else resolve(items as Array<{ filename: string; attrs: any }>)
      })
    })
    const entries = list.map(item => normalizeEntry(item.filename, absolutePath, item.attrs))
    return { parent: parentEntry, entries }
  }

  return {
    async listDirectory(input) {
      const session = ensureConnection(input)
      const sftp = await getClient(session.client, input.ownerId, input.connectionId)
      const attrs = await new Promise<any>((resolve, reject) => {
        sftp.stat(input.absolutePath, (err: any, a: any) => err ? reject(new Error('RESOURCE_NOT_FOUND')) : resolve(a))
      })
      const isDir = attrs.isDirectory?.() || (attrs.mode & 0o170000) === 0o040000
      if (!isDir) throw new Error('NOT_A_DIRECTORY')
      const parentEntry = normalizeEntry(input.absolutePath.split('/').pop() || '/', parentOf(input.absolutePath), attrs)
      return listDirectoryInternal(sftp, input.absolutePath, parentEntry)
    },
    async stat(input) {
      const session = ensureConnection(input)
      const sftp = await getClient(session.client, input.ownerId, input.connectionId)
      const attrs = await new Promise<any>((resolve, reject) => {
        sftp.stat(input.absolutePath, (err: any, a: any) => err ? reject(new Error('RESOURCE_NOT_FOUND')) : resolve(a))
      })
      return normalizeEntry(input.absolutePath.split('/').pop() || input.absolutePath, parentOf(input.absolutePath), attrs)
    },
    async ensureSftp(connectionId, ownerId) {
      if (!isUuid(connectionId)) throw new Error('UNAUTHORIZED_OWNER')
      const session = ensureOwner({ connectionId, ownerId })
      const sftp = await getClient(session.client, ownerId, connectionId)
      const cached = sftpCache.get(connectionId)
      if (!cached) throw new Error('SFTP_UNAVAILABLE')
      return { sftp, client: cached.client }
    },
    dispose() {
      for (const [, entry] of sftpCache.entries()) {
        try { entry.sftp?.end() } catch {}
      }
      sftpCache.clear()
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Transfer service — owner-bound, abort-able streams, same-directory .part,
// SHA-256 + size verification, typed errors.
// ─────────────────────────────────────────────────────────────────────────────

export type TransferServiceOptions = {
  resolveSession: (input: { connectionId: string; ownerId: string }) => { session: SshSession; client: SshClient; generation: number }
  sftpService: SftpService
  localPathService: LocalPathService
  maxFileBytes?: number
  chunkSize?: number
  idleTimeoutMs?: number
  maxEntries?: number
  maxDepth?: number
  emit?: (event: { type: 'transfer-update'; job: TransferJob }) => void
}

export type FolderTransferInput = {
  jobId: string
  connectionId: string
  ownerId: string
  generation: number
  remotePath: string
  /** Granted only by the native folder picker, never by a renderer payload. */
  localRoot: string
}

export type TransferService = {
  startFolderUpload: (input: FolderTransferInput) => Promise<TransferJob>
  startFolderDownload: (input: FolderTransferInput) => Promise<TransferJob>
  startDownload: (input: {
    jobId: TransferJobId
    connectionId: string
    ownerId: string
    generation: number
    remotePath: string
    localToken: string
  }) => Promise<TransferJob>
  startUpload: (input: {
    jobId: TransferJobId
    connectionId: string
    ownerId: string
    generation: number
    remotePath: string
    localToken: string
  }) => Promise<TransferJob>
  cancel: (jobId: TransferJobId, ownerId: string) => Promise<void>
  getJob: (jobId: TransferJobId, ownerId: string) => TransferJob | null
  listJobs: (ownerId: string) => TransferJob[]
  dispose: () => void
}

export { createStreamingTransferService as createTransferService } from './streamingTransferService.js'

// ─────────────────────────────────────────────────────────────────────────────
// Remote edit service — 2 MiB UTF-8 only, fatal UTF-8 decode, external
// conflict detection, same-directory temp file + atomic rename, draft
// preservation on disconnect.
// ─────────────────────────────────────────────────────────────────────────────

export type RemoteEditServiceOptions = {
  resolveSession: (input: { connectionId: string; ownerId: string }) => { session: SshSession; client: SshClient; generation: number }
  sftpService: SftpService
  localPathService: LocalPathService
  maxFileBytes?: number
}

export type RemoteEditService = {
  open: (input: {
    connectionId: string
    ownerId: string
    generation: number
    absolutePath: string
  }) => Promise<{ edit: RemoteEditSession; metadata: RemoteEditMetadata }>
  save: (input: { editId: string; baseRevision: string; text: string; ownerId: string }) => Promise<{ edit: RemoteEditSession; metadata: RemoteEditMetadata }>
  rebind: (input: { editId: string; newConnectionId: string; newGeneration: number; ownerId: string }) => Promise<RemoteEditSession>
  close: (editId: string, ownerId: string) => Promise<void>
  getEdit: (editId: string, ownerId: string) => RemoteEditSession | null
}

function makeEdit(input: {
  id: string
  connectionId: string
  ownerId: string
  generation: number
  absolutePath: string
  baseRevision: string
  baseSha256: string
  baseSize: number
  baseMtimeMs: number
  text: string
  hasBom: boolean
}): RemoteEditSession {
  return {
    id: input.id,
    connectionId: input.connectionId,
    ownerId: input.ownerId,
    generation: input.generation,
    absolutePath: input.absolutePath,
    baseRevision: input.baseRevision,
    baseSha256: input.baseSha256,
    baseSize: input.baseSize,
    baseMtimeMs: input.baseMtimeMs,
    text: input.text,
    hasBom: input.hasBom,
    dirty: false,
    openedAt: Date.now(),
  }
}

export function createRemoteEditService(options: RemoteEditServiceOptions): RemoteEditService {
  const maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES
  const edits = new Map<string, RemoteEditSession>()
  const draftBlobs = new Map<string, string>() // editId -> local path to draft
  const saving = new Set<string>()

  function ensureOwned(editId: string, ownerId: string): RemoteEditSession {
    const edit = edits.get(editId)
    if (!edit) throw new Error('RESOURCE_NOT_FOUND')
    if (edit.ownerId !== ownerId) throw new Error('UNAUTHORIZED_OWNER')
    return edit
  }

  /**
   * Decode a Buffer as strict UTF-8. Throws on any invalid sequence or NUL
   * byte. We never substitute replacement characters.
   */
  function decodeUtf8(buffer: Buffer): string {
    if (buffer.includes(0x00)) throw new Error('INVALID_ENCODING: NUL byte')
    // Node's TextDecoder with fatal:true rejects any invalid UTF-8 sequence.
    const decoder = new TextDecoder('utf-8', { fatal: true })
    try {
      return decoder.decode(buffer)
    } catch {
      throw new Error('INVALID_ENCODING: not UTF-8')
    }
  }

  return {
    async open(input) {
      if (!isUuid(input.connectionId)) throw new Error('UNAUTHORIZED_OWNER')
      if (!isValidPosixPath(input.absolutePath)) throw new Error('INVALID_REMOTE_PATH')
      const session = options.resolveSession({ connectionId: input.connectionId, ownerId: input.ownerId })
      if (session.generation !== input.generation) throw new Error('STALE_GENERATION')
      const sftpHolder = await options.sftpService.ensureSftp(input.connectionId, input.ownerId)
      const sftp = sftpHolder.sftp
      const attrs = await new Promise<any>((resolve, reject) => {
        sftp.stat(input.absolutePath, (err: any, a: any) => err ? reject(new Error('RESOURCE_NOT_FOUND')) : resolve(a))
      })
      const isLink = attrs.isSymbolicLink?.() || (attrs.mode & 0o170000) === 0o120000
      if (isLink) throw new Error('IS_SYMLINK')
      const isFile = attrs.isFile?.() || (attrs.mode & 0o170000) === 0o100000
      if (!isFile) throw new Error('NOT_A_FILE')
      if (attrs.size > maxFileBytes) throw new Error(`FILE_TOO_LARGE size=${attrs.size} max=${maxFileBytes}`)
      const buffer = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = []
        const rs = sftp.createReadStream(input.absolutePath, { highWaterMark: 64 * 1024 })
        rs.on('error', reject)
        rs.on('data', (chunk: Buffer) => chunks.push(chunk))
        rs.on('close', () => resolve(Buffer.concat(chunks)))
        rs.on('end', () => {})
      })
      if (buffer.length > maxFileBytes) throw new Error('FILE_TOO_LARGE')
      const hasBom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
      const stripped = hasBom ? buffer.subarray(3) : buffer
      const text = decodeUtf8(stripped)
      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex')
      const baseRevision = `${attrs.size}:${attrs.mtimeMs || (attrs.mtime * 1000)}:${sha256}`
      const edit = makeEdit({
        id: crypto.randomUUID(),
        connectionId: input.connectionId,
        ownerId: input.ownerId,
        generation: input.generation,
        absolutePath: input.absolutePath,
        baseRevision,
        baseSha256: sha256,
        baseSize: buffer.length,
        baseMtimeMs: (attrs.mtimeMs || (attrs.mtime * 1000)) ?? Date.now(),
        text,
        hasBom,
      })
      edits.set(edit.id, edit)
      return {
        edit,
        metadata: {
          size: buffer.length,
          mtimeMs: (attrs.mtimeMs || (attrs.mtime * 1000)) ?? Date.now(),
          mode: attrs.mode ?? 0,
          lineEnding: detectLineEnding(text),
          hasBom,
        },
      }
    },
    async save(input) {
      const edit = ensureOwned(input.editId, input.ownerId)
      if (edit.baseRevision !== input.baseRevision) throw new Error('REVISION_CONFLICT')
      // Re-validate the text BEFORE going near the network.
      if (typeof input.text !== 'string') throw new Error('INVALID_ENCODING')
      const buffer = Buffer.from(input.text, 'utf-8')
      if (buffer.includes(0x00)) throw new Error('INVALID_ENCODING: NUL byte')
      if (buffer.length > maxFileBytes) throw new Error(`FILE_TOO_LARGE size=${buffer.length} max=${maxFileBytes}`)
      // Round-trip: encoding -> bytes -> string. If this differs, the
      // caller passed invalid UTF-16 or surrogate-pair fragments.
      const rt = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
      if (rt !== input.text) throw new Error('INVALID_ENCODING: round-trip mismatch')
      const key = `${edit.connectionId}:${edit.absolutePath}`
      if (saving.has(key)) throw new Error('SAVE_IN_PROGRESS')
      saving.add(key)
      try {
        const check = () => {
          const current = options.resolveSession({ connectionId: edit.connectionId, ownerId: edit.ownerId })
          if (current.generation !== edit.generation) throw new Error('STALE_GENERATION')
          if (['closed', 'closing', 'failed', 'disconnected'].includes(current.session.status)) throw new Error('DISCONNECTED')
        }
        check()
        const { sftp } = await options.sftpService.ensureSftp(edit.connectionId, edit.ownerId)
        const result = await writeRemoteEdit(sftp, edit, input.text, buffer, maxFileBytes, check)
        const saved = { ...edit, baseSha256: result.hash, baseRevision: `${result.size}:${result.mtimeMs}:${result.hash}`,
          baseSize: result.size, baseMtimeMs: result.mtimeMs, text: input.text, dirty: false }
        edits.set(saved.id, saved)
        return { edit: saved, metadata: { size: result.size, mtimeMs: result.mtimeMs, mode: result.mode,
          lineEnding: detectLineEnding(input.text), hasBom: saved.hasBom } }
      } finally { saving.delete(key) }
    },
    async rebind(input) {
      const edit = ensureOwned(input.editId, input.ownerId)
      edit.connectionId = input.newConnectionId
      edit.generation = input.newGeneration
      edits.set(edit.id, edit)
      return edit
    },
    async close(editId, ownerId) {
      ensureOwned(editId, ownerId)
      edits.delete(editId)
      const local = draftBlobs.get(editId)
      if (local) {
        await fsp.unlink(local).catch(() => undefined)
        draftBlobs.delete(editId)
      }
    },
    getEdit(editId, ownerId) {
      const edit = edits.get(editId)
      if (!edit || edit.ownerId !== ownerId) return null
      return edit
    },
  }
}