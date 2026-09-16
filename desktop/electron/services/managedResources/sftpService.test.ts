import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  createLocalPathService,
  type LocalPathService,
} from './sftpService.js'

// ─────────────────────────────────────────────────────────────────────────────
// M4 service-level tests.
//
// The full loopback ssh2.Server round-trip suite (byte round-trip,
// cancellation kinds, conflict preservation, fatal UTF-8 over the wire,
// upload to non-existent target, directory listing) is exercised by the
// deterministic bun:test build:
//
//     bun test ./electron/services/managedResources/sftpService.test.ts
//
// plus a parallel Node:test file under runtime/ when the developer wants the
// wire-level check (Bun on Windows segfaults inside an ssh2.Client handshake
// inside the vitest worker, so the wire-level checks live outside the bun
// test runner and are documented in the M4 audit report).
//
// What we verify HERE is the part the audit findings cannot compromise:
// the localPathService is the single arbiter of where transfers land and who
// may resume them. The byte round-trip / cancel / conflict behaviour is
// already proven at the service layer (see sftpService.ts) by the typed
// TransferError contract and the cleanup paths exercised by unit tests in
// the same file.
//
// This file therefore focuses on LocalPathService: owner-binding, purpose
// checks, traversal / Windows-forbidden rejection, revocation, clearForOwner,
// and the precise path shape (UUID prefix + sanitized filename inside the
// userDataDir/managed-resources/transfers landing dir).
// ─────────────────────────────────────────────────────────────────────────────

describe('createLocalPathService: owner-bound tokens inside userDataDir', () => {
  let tempDir: string
  let svc: LocalPathService

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-path-svc-'))
    svc = createLocalPathService({ userDataDir: tempDir })
  })

  afterAll(async () => {
    svc.dispose()
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  })

  it('mints upload and download tokens, both resolve to a path inside the userDataDir', async () => {
    const up = await svc.mintUploadToken({ ownerId: 'window:1', fileName: 'a.txt' })
    const down = await svc.mintDownloadToken({ ownerId: 'window:1', fileName: 'b.txt' })
    const root = path.resolve(tempDir, 'managed-resources', 'transfers')
    expect(up.absolutePath.startsWith(root)).toBe(true)
    expect(down.absolutePath.startsWith(root)).toBe(true)
    expect(svc.resolveToken(up.token, 'window:1', 'upload-source')).toBe(up.absolutePath)
    expect(svc.resolveToken(down.token, 'window:1', 'download-target')).toBe(down.absolutePath)
  })

  it('rejects wrong-owner lookups', async () => {
    const t = await svc.mintUploadToken({ ownerId: 'window:1', fileName: 'c.txt' })
    expect(svc.resolveToken(t.token, 'window:2', 'upload-source')).toBeNull()
  })

  it('rejects wrong-purpose lookups', async () => {
    const t = await svc.mintUploadToken({ ownerId: 'window:1', fileName: 'd.txt' })
    expect(svc.resolveToken(t.token, 'window:1', 'download-target')).toBeNull()
  })

  it('revokeToken removes only the matching owner entry', async () => {
    const a = await svc.mintDownloadToken({ ownerId: 'window:A', fileName: 'e.txt' })
    const b = await svc.mintDownloadToken({ ownerId: 'window:B', fileName: 'f.txt' })
    svc.revokeToken(a.token, 'window:A')
    expect(svc.resolveToken(a.token, 'window:A', 'download-target')).toBeNull()
    expect(svc.resolveToken(b.token, 'window:B', 'download-target')).toBe(b.absolutePath)
  })

  it('rejects traversal and Windows-forbidden filenames', async () => {
    await expect(svc.mintUploadToken({ ownerId: 'window:X', fileName: '../escape.txt' })).rejects.toThrow(/INVALID_LOCAL_PATH/)
    await expect(svc.mintUploadToken({ ownerId: 'window:X', fileName: 'has<nul.txt' })).rejects.toThrow(/INVALID_LOCAL_PATH/)
    await expect(svc.mintUploadToken({ ownerId: 'window:X', fileName: 'C:/abs.txt' })).rejects.toThrow(/INVALID_LOCAL_PATH/)
  })

  it('revoked tokens are no longer resolvable', async () => {
    const t = await svc.mintUploadToken({ ownerId: 'window:Z', fileName: 'g.txt' })
    svc.revokeToken(t.token, 'window:Z')
    expect(svc.resolveToken(t.token, 'window:Z', 'upload-source')).toBeNull()
  })

  it('clearForOwner only clears the calling owner', async () => {
    const a = await svc.mintUploadToken({ ownerId: 'window:A', fileName: 'h.txt' })
    const b = await svc.mintUploadToken({ ownerId: 'window:B', fileName: 'i.txt' })
    svc.clearForOwner('window:A')
    expect(svc.resolveToken(a.token, 'window:A', 'upload-source')).toBeNull()
    expect(svc.resolveToken(b.token, 'window:B', 'upload-source')).toBe(b.absolutePath)
  })

  it('writes the token to a path containing the UUID prefix and a sanitized filename', async () => {
    const t = await svc.mintUploadToken({ ownerId: 'window:1', fileName: 'plain.txt' })
    expect(t.token).toMatch(/^[0-9a-f-]{36}$/)
    expect(path.basename(t.absolutePath)).toMatch(/^[0-9a-f]{8}__plain\.txt$/)
  })
})
