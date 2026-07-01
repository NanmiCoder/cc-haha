/**
 * Tests for `WorkspaceFileService.writeFile` (Phase 2 task 12).
 *
 * Strategy: drive the service against a temporary on-disk workspace so we
 * exercise the real path-resolution + atomic-write paths instead of
 * mocking `fs`. Only the WS emitter is mocked, since broadcasting is a
 * side-effect we just need to assert was called with the right payload.
 *
 * **Validates Properties: 1, 2, 3** (path-escape rejection, stale-base
 * detection, BOM/line-ending round-trip).
 *
 * _Requirements: 2.1-2.9_
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

const emitMock = vi.fn<(input: unknown) => boolean>(() => true)

vi.mock('../events/workspaceFileSaved.js', () => ({
  emitWorkspaceFileSaved: emitMock,
}))

import {
  WORKSPACE_MAX_PATH_LENGTH,
  WorkspaceFileService,
  writeWorkspaceFileSchema,
} from './workspaceFileService.js'

const SHA256_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

async function makeWorkspace(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-file-svc-'))
  const realRoot = await fs.realpath(root)
  return {
    root: realRoot,
    cleanup: async () => {
      await fs.rm(realRoot, { recursive: true, force: true })
    },
  }
}

describe('WorkspaceFileService.writeFile', () => {
  let workspaceRoot: string
  let cleanup: () => Promise<void>
  let service: WorkspaceFileService

  beforeEach(async () => {
    emitMock.mockClear()
    const w = await makeWorkspace()
    workspaceRoot = w.root
    cleanup = w.cleanup
    service = new WorkspaceFileService(async () => workspaceRoot)
  })

  afterEach(async () => {
    await cleanup()
  })

  // -------------------- 200 OK --------------------

  it('writes a new file inside the workspace and emits workspace.file.saved', async () => {
    const result = await service.writeFile('s1', {
      path: 'app.ts',
      content: 'export const x = 1\n',
      expectedBaseHash: SHA256_EMPTY,
      bom: 'none',
      lineEnding: 'LF',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.bytes).toBe(Buffer.byteLength('export const x = 1\n', 'utf-8'))

    const onDisk = await fs.readFile(path.join(workspaceRoot, 'app.ts'))
    expect(onDisk.toString('utf-8')).toBe('export const x = 1\n')

    expect(emitMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      path: 'app.ts',
      hash: result.hash,
      source: 'user',
    }))
  })

  it('overwrites an existing file when expectedBaseHash matches', async () => {
    const filePath = path.join(workspaceRoot, 'a.txt')
    await fs.writeFile(filePath, 'first')
    const baseHash = sha256(Buffer.from('first', 'utf-8'))

    const result = await service.writeFile('s1', {
      path: 'a.txt',
      content: 'second',
      expectedBaseHash: baseHash,
      bom: 'none',
      lineEnding: 'LF',
    })

    expect(result.ok).toBe(true)
    expect(await fs.readFile(filePath, 'utf-8')).toBe('second')
  })

  it('preserves UTF-8 BOM on round-trip (Validates Property 3)', async () => {
    const result = await service.writeFile('s1', {
      path: 'with-bom.txt',
      content: 'hello',
      expectedBaseHash: SHA256_EMPTY,
      bom: 'utf-8',
      lineEnding: 'LF',
    })
    expect(result.ok).toBe(true)

    const onDisk = await fs.readFile(path.join(workspaceRoot, 'with-bom.txt'))
    expect(onDisk[0]).toBe(0xef)
    expect(onDisk[1]).toBe(0xbb)
    expect(onDisk[2]).toBe(0xbf)
    expect(onDisk.subarray(3).toString('utf-8')).toBe('hello')
  })

  it('preserves CRLF line endings on round-trip (Validates Property 3)', async () => {
    const result = await service.writeFile('s1', {
      path: 'crlf.txt',
      content: 'a\nb\nc\n',
      expectedBaseHash: SHA256_EMPTY,
      bom: 'none',
      lineEnding: 'CRLF',
    })
    expect(result.ok).toBe(true)

    const onDisk = await fs.readFile(path.join(workspaceRoot, 'crlf.txt'), 'utf-8')
    expect(onDisk).toBe('a\r\nb\r\nc\r\n')
  })

  it('writes CR-only line endings when requested', async () => {
    const result = await service.writeFile('s1', {
      path: 'cr.txt',
      content: 'a\nb',
      expectedBaseHash: SHA256_EMPTY,
      bom: 'none',
      lineEnding: 'CR',
    })
    expect(result.ok).toBe(true)
    const onDisk = await fs.readFile(path.join(workspaceRoot, 'cr.txt'), 'utf-8')
    expect(onDisk).toBe('a\rb')
  })

  // -------------------- 400 invalid --------------------

  it('rejects an empty path with 400', async () => {
    const result = await service.writeFile('s1', {
      path: '',
      content: 'x',
      expectedBaseHash: SHA256_EMPTY,
      bom: 'none',
      lineEnding: 'LF',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(400)
  })

  it('rejects a path longer than WORKSPACE_MAX_PATH_LENGTH with 400', async () => {
    const longPath = 'x/'.repeat(700)
    const result = await service.writeFile('s1', {
      path: longPath,
      content: 'x',
      expectedBaseHash: SHA256_EMPTY,
      bom: 'none',
      lineEnding: 'LF',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(400)
    expect(longPath.length).toBeGreaterThan(WORKSPACE_MAX_PATH_LENGTH)
  })

  it('rejects malformed expectedBaseHash with 400', async () => {
    const result = await service.writeFile('s1', {
      path: 'a.txt',
      content: 'x',
      expectedBaseHash: 'not-a-hash',
      bom: 'none',
      lineEnding: 'LF',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(400)
    expect(result.error).toBe('INVALID_REQUEST')
  })

  it('rejects an unknown lineEnding with 400', async () => {
    const result = await service.writeFile('s1', {
      path: 'a.txt',
      content: 'x',
      expectedBaseHash: SHA256_EMPTY,
      bom: 'none',
      // @ts-expect-error — exercising the runtime guard
      lineEnding: 'lf',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(400)
  })

  it('rejects an absolute path with 400', async () => {
    const abs = process.platform === 'win32' ? 'C:\\Windows\\system32\\drivers\\etc\\hosts' : '/etc/passwd'
    const result = await service.writeFile('s1', {
      path: abs,
      content: 'x',
      expectedBaseHash: SHA256_EMPTY,
      bom: 'none',
      lineEnding: 'LF',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(400)
    expect(result.error).toBe('PATH_NOT_RELATIVE')
  })

  // -------------------- 400 path-escape --------------------

  it('rejects a "../" traversal with 400 PATH_ESCAPES_WORKSPACE (Validates Property 1)', async () => {
    const result = await service.writeFile('s1', {
      path: '../escaped.txt',
      content: 'x',
      expectedBaseHash: SHA256_EMPTY,
      bom: 'none',
      lineEnding: 'LF',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(400)
    expect(result.error).toBe('PATH_ESCAPES_WORKSPACE')
  })

  it('rejects a symlink that points outside the workspace with 400 (Validates Property 1)', async () => {
    if (process.platform === 'win32') {
      // Symlink creation on Windows requires elevated rights or developer mode.
      // The realpath defense is identical on Windows; we cover it on POSIX.
      return
    }
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-file-svc-out-'))
    try {
      await fs.symlink(outside, path.join(workspaceRoot, 'escape-link'))
      const result = await service.writeFile('s1', {
        path: 'escape-link/secret.txt',
        content: 'x',
        expectedBaseHash: SHA256_EMPTY,
        bom: 'none',
        lineEnding: 'LF',
      })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.status).toBe(400)
      expect(result.error).toBe('PATH_ESCAPES_WORKSPACE')
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('returns 400 PARENT_DIRECTORY_MISSING when the target dir does not exist', async () => {
    const result = await service.writeFile('s1', {
      path: 'no/such/dir/file.txt',
      content: 'x',
      expectedBaseHash: SHA256_EMPTY,
      bom: 'none',
      lineEnding: 'LF',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(400)
    expect(result.error).toBe('PARENT_DIRECTORY_MISSING')
  })

  // -------------------- 409 stale-base --------------------

  it('returns 409 STALE_BASE when the on-disk hash differs from expectedBaseHash (Validates Property 2)', async () => {
    const filePath = path.join(workspaceRoot, 'evolving.txt')
    await fs.writeFile(filePath, 'real-content')
    const wrongBase = sha256(Buffer.from('what-the-editor-thought', 'utf-8'))

    const result = await service.writeFile('s1', {
      path: 'evolving.txt',
      content: 'overwrite',
      expectedBaseHash: wrongBase,
      bom: 'none',
      lineEnding: 'LF',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(409)
    expect(result.error).toBe('STALE_BASE')
    expect(await fs.readFile(filePath, 'utf-8')).toBe('real-content')
    expect(emitMock).not.toHaveBeenCalled()
  })

  // -------------------- 404 / session resolution --------------------

  it('returns 404 when the session has no workspace', async () => {
    const noWorkspaceService = new WorkspaceFileService(async () => null)
    const result = await noWorkspaceService.writeFile('missing', {
      path: 'a.txt',
      content: 'x',
      expectedBaseHash: SHA256_EMPTY,
      bom: 'none',
      lineEnding: 'LF',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(404)
    expect(result.error).toBe('SESSION_NOT_FOUND')
  })

  // -------------------- temp file does not leak --------------------

  it('does not leave .tmp files in the workspace after a successful write', async () => {
    await service.writeFile('s1', {
      path: 'cleanup-check.txt',
      content: 'hello',
      expectedBaseHash: SHA256_EMPTY,
      bom: 'none',
      lineEnding: 'LF',
    })
    const entries = await fs.readdir(workspaceRoot)
    expect(entries.filter((name) => name.includes('.tmp.'))).toEqual([])
  })

  // -------------------- schema-only sanity --------------------

  it('writeWorkspaceFileSchema rejects content larger than 10 MiB', () => {
    const big = 'a'.repeat(10 * 1024 * 1024 + 1)
    const result = writeWorkspaceFileSchema.safeParse({
      path: 'big.bin',
      content: big,
      expectedBaseHash: SHA256_EMPTY,
      bom: 'none',
      lineEnding: 'LF',
    })
    expect(result.success).toBe(false)
  })
})
