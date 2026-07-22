import { afterEach, describe, expect, it } from 'bun:test'
import { appendFile, mkdtemp, open, rename, rm, stat, truncate, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  captureSourceFingerprint,
  deserializeSourceFingerprint,
  detectSourceChange,
  serializeSourceFingerprint,
  verifySourceFingerprint,
  type FileIdentityResolver,
  type LocalIndexIoMetrics,
  type SourceChange,
  type SourceFingerprintIo,
} from './sourceFingerprint.js'

const tempDirs: string[] = []

async function tempFile(contents: string | Buffer): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cc-haha-source-fingerprint-'))
  tempDirs.push(root)
  const path = join(root, 'session.jsonl')
  await writeFile(path, contents)
  return path
}

function metrics(): LocalIndexIoMetrics {
  return { filesOpened: 0, bytesRead: 0, statCalls: 0 }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('source fingerprint transitions', () => {
  it('reports an unchanged source from bounded windows', async () => {
    const path = await tempFile('{"type":"user"}\n')
    const io = metrics()
    const previous = await captureSourceFingerprint({
      path,
      indexedBytes: Buffer.byteLength('{"type":"user"}\n'),
      parserVersion: 1,
      metrics: io,
    })

    const change: SourceChange = await detectSourceChange({
      path,
      previous,
      parserVersion: 1,
      metrics: io,
    })

    expect(change).toEqual({ kind: 'unchanged' })
    expect(io.filesOpened).toBeGreaterThan(0)
    expect(io.bytesRead).toBeLessThanOrEqual(4 * 64 * 1024)
    expect(io.statCalls).toBeGreaterThan(0)
  })

  it('reports a pure append from the last complete byte boundary', async () => {
    const first = '{"type":"user"}\n'
    const path = await tempFile(first)
    const previous = await captureSourceFingerprint({
      path,
      indexedBytes: Buffer.byteLength(first),
      parserVersion: 1,
    })

    await appendFile(path, '{"type":"assistant"}\n')

    expect(await detectSourceChange({ path, previous, parserVersion: 1 })).toEqual({
      kind: 'append',
      readFrom: Buffer.byteLength(first),
    })
  })

  it('re-reads an existing partial tail when later bytes complete it', async () => {
    const complete = '{"type":"user"}\n'
    const partial = '{"type":"assistant"'
    const path = await tempFile(`${complete}${partial}`)
    const previous = await captureSourceFingerprint({
      path,
      indexedBytes: Buffer.byteLength(complete),
      parserVersion: 1,
    })

    await appendFile(path, '}\n{"type":"progress"')

    expect(await detectSourceChange({ path, previous, parserVersion: 1 })).toEqual({
      kind: 'append',
      readFrom: Buffer.byteLength(complete),
    })
  })

  it('distinguishes truncate, identity replacement, rewrite, and parser invalidation', async () => {
    const original = '{"type":"user","content":"aaaa"}\n'
    const path = await tempFile(original)
    const originalTimes = await stat(path)
    const previous = await captureSourceFingerprint({
      path,
      indexedBytes: Buffer.byteLength(original),
      parserVersion: 1,
    })

    await truncate(path, 4)
    expect(await detectSourceChange({ path, previous, parserVersion: 1 })).toEqual({
      kind: 'rebuild',
      reason: 'truncate',
    })

    await writeFile(path, original)
    const beforeReplacement = await captureSourceFingerprint({
      path,
      indexedBytes: Buffer.byteLength(original),
      parserVersion: 1,
      identityResolver: stats => `${stats.dev}:${stats.ino}`,
    })
    const replacedPath = `${path}.old`
    await rename(path, replacedPath)
    await writeFile(path, original)
    expect(await detectSourceChange({
      path,
      previous: beforeReplacement,
      parserVersion: 1,
      identityResolver: stats => `${stats.dev}:${stats.ino}`,
    })).toEqual({ kind: 'rebuild', reason: 'replace' })

    const beforeRewrite = await captureSourceFingerprint({
      path,
      indexedBytes: Buffer.byteLength(original),
      parserVersion: 1,
    })
    await writeFile(path, original.replace('aaaa', 'bbbb'))
    await utimes(path, originalTimes.atime, new Date(beforeRewrite.mtimeMs))
    expect((await stat(path)).size).toBe(beforeRewrite.size)
    expect(await detectSourceChange({ path, previous: beforeRewrite, parserVersion: 1 })).toEqual({
      kind: 'rebuild',
      reason: 'rewrite',
    })

    const current = await captureSourceFingerprint({
      path,
      indexedBytes: Buffer.byteLength(original),
      parserVersion: 1,
    })
    expect(await detectSourceChange({ path, previous: current, parserVersion: 2 })).toEqual({
      kind: 'rebuild',
      reason: 'parser-version',
    })
  })

  it('reports a renamed or deleted source as deleted', async () => {
    const path = await tempFile('{}\n')
    const previous = await captureSourceFingerprint({
      path,
      indexedBytes: 3,
      parserVersion: 1,
    })

    await rename(path, `${path}.renamed`)

    expect(await detectSourceChange({ path, previous, parserVersion: 1 })).toEqual({
      kind: 'deleted',
    })
  })

  it('returns retry when the source changes after the read snapshot but before commit', async () => {
    const path = await tempFile('{}\n')
    const expected = await captureSourceFingerprint({
      path,
      indexedBytes: 3,
      parserVersion: 1,
    })

    await appendFile(path, '{"changed":true}\n')

    expect(await verifySourceFingerprint({ path, expected })).toEqual({
      kind: 'retry',
      reason: 'changed-during-read',
    })
  })

  it('treats changed mtime as rewrite when a same-size edit misses every bounded window', async () => {
    const windowBytes = 64 * 1024
    const body = Buffer.alloc(5 * windowBytes, 0x61)
    const indexedBytes = 2 * windowBytes
    const unsampledOffset = 3 * windowBytes
    const path = await tempFile(body)
    const previous = await captureSourceFingerprint({
      path,
      indexedBytes,
      parserVersion: 1,
    })
    const handle = await open(path, 'r+')
    try {
      await handle.write(Buffer.from('b'), 0, 1, unsampledOffset)
    } finally {
      await handle.close()
    }
    await utimes(
      path,
      new Date(previous.mtimeMs),
      new Date(previous.mtimeMs + 2_000),
    )
    const io = metrics()

    expect((await stat(path)).size).toBe(previous.size)
    expect(await detectSourceChange({
      path,
      previous,
      parserVersion: 1,
      metrics: io,
    })).toEqual({ kind: 'rebuild', reason: 'rewrite' })
    expect(io.bytesRead).toBeLessThanOrEqual(3 * windowBytes)
  })

  it('uses ctime to detect an unsampled same-size rewrite with restored mtime', async () => {
    const windowBytes = 64 * 1024
    const body = Buffer.alloc(5 * windowBytes, 0x61)
    const indexedBytes = body.length
    const unsampledOffset = 2 * windowBytes
    const path = await tempFile(body)
    const fixedTime = new Date(1_700_000_000_000)
    await utimes(path, fixedTime, fixedTime)
    const previous = await captureSourceFingerprint({
      path,
      indexedBytes,
      parserVersion: 1,
    })

    await new Promise(resolve => setTimeout(resolve, 5))
    const handle = await open(path, 'r+')
    try {
      await handle.write(Buffer.from('b'), 0, 1, unsampledOffset)
    } finally {
      await handle.close()
    }
    await utimes(path, fixedTime, fixedTime)
    const current = await stat(path)

    expect(current.mtimeMs).toBe(previous.mtimeMs)
    expect(current.ctimeMs).not.toBe(previous.ctimeMs)
    expect(await detectSourceChange({
      path,
      previous,
      parserVersion: 1,
    })).toEqual({ kind: 'rebuild', reason: 'rewrite' })
  })

  it('maps non-deletion IO errors to a stable transient retry', async () => {
    const path = await tempFile('{}\n')
    const previous = await captureSourceFingerprint({
      path,
      indexedBytes: 3,
      parserVersion: 1,
    })

    expect(await detectSourceChange({
      path: `${path}\0invalid`,
      previous,
      parserVersion: 1,
    })).toEqual({ kind: 'retry', reason: 'transient-io' })
  })

  it('distinguishes a pre-vs-post stat race from ordinary transient IO', async () => {
    const payload = Buffer.from('{}\n')
    const path = await tempFile(payload)
    const previous = await captureSourceFingerprint({
      path,
      indexedBytes: payload.length,
      parserVersion: 1,
    })
    let statCalls = 0
    let closeCalls = 0
    const io: SourceFingerprintIo = {
      async openReadonly() {
        return {
          async stat() {
            statCalls += 1
            return {
              size: statCalls > 1 ? payload.length + 1 : payload.length,
              mtimeMs: statCalls > 1 ? 2 : 1,
              dev: 2,
              ino: 3,
            }
          },
          async read(buffer, offset, length, position) {
            const bytesRead = Math.min(length, payload.length - position)
            payload.copy(buffer, offset, position, position + bytesRead)
            return { bytesRead }
          },
          async close() {
            closeCalls += 1
          },
        }
      },
      async statPath() {
        return { size: payload.length, mtimeMs: 1, dev: 2, ino: 3 }
      },
    }

    expect(await detectSourceChange({
      path: '/synthetic',
      previous: { ...previous, mtimeMs: 1, fileIdentity: '2:3' },
      parserVersion: 1,
      io,
    })).toEqual({ kind: 'retry', reason: 'changed-during-read' })
    expect(closeCalls).toBe(1)
  })

  it('treats final path disappearance after hashing as changed-during-read', async () => {
    const unavailableIdentity: FileIdentityResolver = () => null
    const payload = Buffer.from('{}\n')
    const path = await tempFile(payload)
    const previous = await captureSourceFingerprint({
      path,
      indexedBytes: payload.length,
      parserVersion: 1,
      identityResolver: unavailableIdentity,
    })
    let closeCalls = 0
    const io: SourceFingerprintIo = {
      async openReadonly() {
        return {
          async stat() {
            return {
              size: payload.length,
              mtimeMs: previous.mtimeMs,
              dev: 0,
              ino: 0,
            }
          },
          async read(buffer, offset, length, position) {
            const bytesRead = Math.min(length, payload.length - position)
            payload.copy(buffer, offset, position, position + bytesRead)
            return { bytesRead }
          },
          async close() {
            closeCalls += 1
          },
        }
      },
      async statPath() {
        const error = new Error('gone') as NodeJS.ErrnoException
        error.code = 'ENOENT'
        throw error
      },
    }

    expect(await detectSourceChange({
      path: '/synthetic',
      previous,
      parserVersion: 1,
      identityResolver: unavailableIdentity,
      io,
    })).toEqual({ kind: 'retry', reason: 'changed-during-read' })
    expect(closeCalls).toBe(1)
  })

  it('detects appends without inode identity as on Windows', async () => {
    const unavailableIdentity: FileIdentityResolver = () => null
    const first = '{}\n'
    const path = await tempFile(first)
    const previous = await captureSourceFingerprint({
      path,
      indexedBytes: Buffer.byteLength(first),
      parserVersion: 1,
      identityResolver: unavailableIdentity,
    })

    await appendFile(path, '{"append":true}\n')

    expect(previous.fileIdentity).toBeNull()
    expect(await detectSourceChange({
      path,
      previous,
      parserVersion: 1,
      identityResolver: unavailableIdentity,
    })).toEqual({ kind: 'append', readFrom: Buffer.byteLength(first) })
  })

  it('detects a bounded rewrite without inode identity as on Windows', async () => {
    const unavailableIdentity: FileIdentityResolver = () => null
    const body = Buffer.alloc(192 * 1024, 0x61)
    const path = await tempFile(body)
    const previous = await captureSourceFingerprint({
      path,
      indexedBytes: body.length,
      parserVersion: 1,
      identityResolver: unavailableIdentity,
    })
    const handle = await open(path, 'r+')
    try {
      await handle.write(Buffer.from('b'), 0, 1, 0)
    } finally {
      await handle.close()
    }
    await utimes(path, new Date(previous.mtimeMs), new Date(previous.mtimeMs))

    expect(await detectSourceChange({
      path,
      previous,
      parserVersion: 1,
      identityResolver: unavailableIdentity,
    })).toEqual({ kind: 'rebuild', reason: 'rewrite' })
  })

  it('verifies at most bounded windows when a large source receives a small append', async () => {
    const line = `${JSON.stringify({ type: 'progress', data: 'x'.repeat(1000) })}\n`
    const body = line.repeat(256)
    const path = await tempFile(body)
    const previous = await captureSourceFingerprint({
      path,
      indexedBytes: Buffer.byteLength(body),
      parserVersion: 1,
    })
    await appendFile(path, `${JSON.stringify({ type: 'progress', data: 'y'.repeat(4096) })}\n`)
    const io = metrics()

    expect(await detectSourceChange({
      path,
      previous,
      parserVersion: 1,
      metrics: io,
    })).toEqual({ kind: 'append', readFrom: previous.indexedBytes })
    expect(io.bytesRead).toBeLessThanOrEqual(1024 * 1024)
  })

  it('round-trips a stable versioned fingerprint through the single prefix_hash field', async () => {
    const path = await tempFile('{}\n')
    const fingerprint = await captureSourceFingerprint({
      path,
      indexedBytes: 3,
      parserVersion: 7,
    })

    const stored = serializeSourceFingerprint(fingerprint)

    expect(stored.startsWith('cc-haha-source-fingerprint:v2:')).toBe(true)
    expect(serializeSourceFingerprint(fingerprint)).toBe(stored)
    expect(deserializeSourceFingerprint(stored)).toEqual(fingerprint)
    expect(deserializeSourceFingerprint(
      stored.replace(':v2:', ':v1:'),
    )).toBeNull()
    expect(deserializeSourceFingerprint('cc-haha-source-fingerprint:v2:not-json')).toBeNull()
  })
})
