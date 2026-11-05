import { afterEach, describe, expect, it } from 'bun:test'
import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { openLocalIndexDatabase } from './database.js'
import {
  readSessionEntriesByLocator,
  type SessionEntryRangeIo,
} from './sessionEntries.js'
import { createSessionIndex } from './sessionIndex.js'
import {
  SESSION_SUMMARY_PARSER_VERSION,
  createSessionProjector,
  type SessionSourceCandidate,
} from './sessionProjector.js'
import {
  deserializeSourceFingerprint,
  serializeSourceFingerprint,
} from './sourceFingerprint.js'
import { reduceTranscriptWithLocators } from './transcriptReducer.js'
import type { SessionListSummary, TranscriptChunk, TranscriptProjection } from './types.js'

const tempDirs: string[] = []

async function createTempDir(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `cc-haha-entries-${label}-`))
  tempDirs.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true }),
  ))
})

function initialProjection(overrides: Partial<SessionListSummary> = {}): TranscriptProjection {
  return {
    summary: {
      title: 'Untitled Session',
      createdAt: '2026-01-01T00:00:00.000Z',
      modifiedAt: '2026-01-01T00:00:00.000Z',
      messageCount: 0,
      workDir: '/tmp/project',
      ...overrides,
    },
    indexedBytes: 0,
    pendingTailBytes: 0,
    malformedLineCount: 0,
  }
}

function chunk(text: string, byteStart: number, completeLine = true): TranscriptChunk {
  return {
    text,
    byteStart,
    byteLength: Buffer.byteLength(text),
    completeLine,
  }
}

function line(entry: Record<string, unknown>, ending = '\n'): string {
  return `${JSON.stringify(entry)}${ending}`
}

function fixedByteLine(entry: Record<string, unknown>, targetBytes = 512): string {
  const unpadded = line({ ...entry, padding: '' })
  const paddingBytes = targetBytes - Buffer.byteLength(unpadded)
  if (paddingBytes < 0) throw new Error('Target line size is too small')
  const padded = line({ ...entry, padding: 'x'.repeat(paddingBytes) })
  if (Buffer.byteLength(padded) !== targetBytes) {
    throw new Error('Fixed-byte JSONL fixture has the wrong size')
  }
  return padded
}

function user(content: string, uuid: string): Record<string, unknown> {
  return {
    type: 'user',
    uuid,
    parent_tool_use_id: 'parent-tool',
    timestamp: '2026-01-01T00:01:00.000Z',
    message: { role: 'user', content },
  }
}

async function createCandidate(options: {
  root: string
  projectPath: string
  sessionId: string
  content: string
}): Promise<SessionSourceCandidate> {
  const path = join(options.root, 'projects', options.projectPath, `${options.sessionId}.jsonl`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, options.content)
  const snapshot = await stat(path)
  return {
    path,
    sessionId: options.sessionId,
    projectPath: options.projectPath,
    fallbackCreatedAt: snapshot.birthtime.toISOString(),
    fallbackModifiedAt: snapshot.mtime.toISOString(),
    fallbackWorkDir: '/tmp/project',
    modifiedAtMs: snapshot.mtimeMs,
  }
}

describe('transcript entry locators', () => {
  it('uses physical byte offsets for UTF-8, CRLF, malformed lines, and chunk boundaries', () => {
    const first = line(user('你好🙂', 'first'), '\r\n')
    const malformed = '{malformed}\n'
    const second = line({
      type: 'assistant',
      uuid: 'second',
      message: { role: 'assistant', content: '跨缓冲区' },
      timestamp: '2026-01-01T00:02:00.000Z',
    })
    const firstBytes = Buffer.byteLength(first)
    const malformedBytes = Buffer.byteLength(malformed)
    const splitAt = 7
    const chunks = [
      chunk(first, 0),
      chunk(malformed, firstBytes),
      chunk(second, firstBytes + malformedBytes),
    ]
    expect(Buffer.byteLength(second)).toBeGreaterThan(splitAt)

    const result = reduceTranscriptWithLocators(chunks, initialProjection())

    expect(result.locators).toEqual([
      {
        ordinal: 0,
        jsonlLine: 1,
        byteStart: 0,
        byteLength: firstBytes,
        entryType: 'user',
        messageId: 'first',
        role: 'user',
        timestamp: '2026-01-01T00:01:00.000Z',
        parentToolUseId: 'parent-tool',
      },
      {
        ordinal: 1,
        jsonlLine: 3,
        byteStart: firstBytes + malformedBytes,
        byteLength: Buffer.byteLength(second),
        entryType: 'assistant',
        messageId: 'second',
        role: 'assistant',
        timestamp: '2026-01-01T00:02:00.000Z',
        parentToolUseId: null,
      },
    ])
    expect(result.projection).toMatchObject({
      indexedBytes: firstBytes + malformedBytes + Buffer.byteLength(second),
      malformedLineCount: 1,
      summary: { messageCount: 2 },
    })
  })

  it('does not emit a locator for a partial tail and continues its ordinal and line later', () => {
    const complete = line(user('first', 'first'))
    const tail = '{"type":"assistant"'
    const first = reduceTranscriptWithLocators([
      chunk(complete, 0),
      chunk(tail, Buffer.byteLength(complete), false),
    ], initialProjection())

    expect(first.locators.map(locator => locator.messageId)).toEqual(['first'])
    expect(first.projection.pendingTailBytes).toBe(Buffer.byteLength(tail))

    const completedTail = `${tail},"uuid":"second","message":{"role":"assistant","content":"done"}}\n`
    const rebuilt = reduceTranscriptWithLocators([
      chunk(complete, 0),
      chunk(completedTail, Buffer.byteLength(complete)),
    ], initialProjection())

    expect(rebuilt.locators.map(locator => [
      locator.ordinal,
      locator.jsonlLine,
      locator.messageId,
    ])).toEqual([
      [0, 1, 'first'],
      [1, 2, 'second'],
    ])
  })
})

describe('session entry projection', () => {
  it('keeps append locators stable and rebuilds only the rewritten source', async () => {
    const root = await createTempDir('append-rewrite')
    const firstLine = line(user('first', 'first'))
    const candidate = await createCandidate({
      root,
      projectPath: '-tmp-project',
      sessionId: '11111111-1111-4111-8111-111111111111',
      content: `${firstLine}{"type":"assistant"`,
    })
    const untouched = await createCandidate({
      root,
      projectPath: '-tmp-other',
      sessionId: '22222222-2222-4222-8222-222222222222',
      content: line(user('untouched', 'untouched')),
    })
    const database = openLocalIndexDatabase({ path: join(root, 'index-v1.sqlite') })
    const index = createSessionIndex(database)
    const projector = createSessionProjector({ database, index, scope: root })

    try {
      expect(SESSION_SUMMARY_PARSER_VERSION).toBeGreaterThan(0)
      await projector.projectSource(candidate)
      await projector.projectSource(untouched)
      const firstBefore = index.getSessionEntryLocators(candidate.path, ['user'])
      const untouchedBefore = index.getSessionEntryLocators(untouched.path)

      await appendFile(
        candidate.path,
        ',"uuid":"second","message":{"role":"assistant","content":"done"},"timestamp":"2026-01-01T00:02:00.000Z"}\n',
      )
      expect(await projector.projectSource(candidate)).toMatchObject({
        kind: 'indexed',
        action: 'append',
      })
      expect(index.getSessionEntryLocators(candidate.path)?.entries[0]).toEqual(
        firstBefore?.entries[0],
      )
      expect(index.getSessionEntryLocators(candidate.path)?.entries.map(entry => entry.ordinal))
        .toEqual([0, 1])
      expect(index.getSessionEntryLocators(candidate.path)?.entries[1]).toMatchObject({
        ordinal: 1,
        jsonlLine: 2,
        byteStart: Buffer.byteLength(firstLine),
      })

      await writeFile(candidate.path, line(user('other', 'other')))
      expect(await projector.projectSource(candidate)).toMatchObject({
        kind: 'indexed',
        action: 'rebuild',
      })
      expect(index.getSessionEntryLocators(candidate.path)?.entries).toEqual([
        expect.objectContaining({ ordinal: 0, jsonlLine: 1, messageId: 'other' }),
      ])

      const sameSizeBefore = (await stat(candidate.path)).size
      await writeFile(candidate.path, line(user('again', 'again')))
      expect((await stat(candidate.path)).size).toBe(sameSizeBefore)
      expect(await projector.projectSource(candidate)).toMatchObject({
        kind: 'indexed',
        action: 'rebuild',
      })
      expect(index.getSessionEntryLocators(candidate.path)?.entries).toEqual([
        expect.objectContaining({ ordinal: 0, jsonlLine: 1, messageId: 'again' }),
      ])
      expect(index.getSessionEntryLocators(untouched.path)).toEqual(untouchedBefore)

      await rm(candidate.path)
      expect(await projector.deleteSource(candidate.path)).toEqual({ kind: 'deleted' })
      expect(index.getSessionEntryLocators(candidate.path)).toBeNull()
    } finally {
      database.close()
    }
  })
})

describe('targeted session entry reads', () => {
  it('reports production range I/O far below the full large transcript size', async () => {
    const root = await createTempDir('production-io-evidence')
    const selected = line(user('bounded production read', 'selected'))
    const bulk = line({
      type: 'tool_result',
      uuid: 'bulk',
      message: { role: 'user', content: 'x'.repeat(4 * 1024 * 1024) },
    })
    const candidate = await createCandidate({
      root,
      projectPath: '-tmp-project',
      sessionId: '66666666-6666-4666-8666-666666666666',
      content: selected + bulk,
    })
    const database = openLocalIndexDatabase({ path: join(root, 'index-v1.sqlite') })
    const index = createSessionIndex(database)
    const projector = createSessionProjector({ database, index, scope: root })

    try {
      await projector.projectSource(candidate)
      const page = index.getSessionEntryLocators(candidate.path, ['user'])!
      const result = await readSessionEntriesByLocator({
        transcriptPath: candidate.path,
        projectsRoot: join(root, 'projects'),
        expectedProjectDir: '-tmp-project',
        page,
      })
      const fullBytes = (await stat(candidate.path)).size

      expect(result?.entries.map(entry => entry.uuid)).toEqual(['selected'])
      expect(result?.rangesRead).toBe(1)
      expect(result!.bytesRead).toBeLessThan(fullBytes / 10)
    } finally {
      database.close()
    }
  })

  it('merges adjacent ranges, reads bounded bytes, and parses only selected entries', async () => {
    const root = await createTempDir('targeted')
    const snapshotA = line({
      type: 'file-history-snapshot',
      messageId: 'snapshot-a',
      snapshot: { messageId: 'a', trackedFileBackups: {} },
    })
    const snapshotB = line({
      type: 'file-history-snapshot',
      messageId: 'snapshot-b',
      snapshot: { messageId: 'b', trackedFileBackups: {} },
    })
    const large = line({
      type: 'assistant',
      uuid: 'large',
      message: { role: 'assistant', content: 'x'.repeat(256 * 1024) },
    })
    const candidate = await createCandidate({
      root,
      projectPath: '-tmp-project',
      sessionId: '33333333-3333-4333-8333-333333333333',
      content: snapshotA + snapshotB + large,
    })
    const database = openLocalIndexDatabase({ path: join(root, 'index-v1.sqlite') })
    const index = createSessionIndex(database)
    const projector = createSessionProjector({ database, index, scope: root })

    try {
      await projector.projectSource(candidate)
      const page = index.getSessionEntryLocators(candidate.path, ['file-history-snapshot'])!
      expect(index.getSessionEntryLocators(candidate.path)?.entries[2]).toMatchObject({
        ordinal: 2,
        jsonlLine: 3,
        byteStart: Buffer.byteLength(snapshotA + snapshotB),
        byteLength: Buffer.byteLength(large),
      })
      let readCalls = 0
      let bytesRead = 0
      const io: SessionEntryRangeIo = {
        lstatPath: path => lstat(path),
        realpathPath: path => import('node:fs/promises').then(module => module.realpath(path)),
        async openReadonly(path) {
          const handle = await open(path, 'r')
          return {
            stat: () => handle.stat(),
            async read(buffer, offset, length, position) {
              readCalls += 1
              const result = await handle.read(buffer, offset, length, position)
              bytesRead += result.bytesRead
              return result
            },
            close: () => handle.close(),
          }
        },
      }

      const result = await readSessionEntriesByLocator({
        transcriptPath: candidate.path,
        projectsRoot: join(root, 'projects'),
        expectedProjectDir: '-tmp-project',
        page,
        io,
      })

      expect(result?.entries.map(entry => entry.type)).toEqual([
        'file-history-snapshot',
        'file-history-snapshot',
      ])
      expect(result?.rangesRead).toBe(1)
      expect(result?.bytesRead).toBe(bytesRead)
      expect(readCalls).toBeLessThanOrEqual(4)
      expect(bytesRead).toBeGreaterThan(Buffer.byteLength(snapshotA + snapshotB))
      expect(bytesRead).toBeLessThan((await stat(candidate.path)).size)

      const expectedFingerprint = deserializeSourceFingerprint(page.source.fingerprint)!
      const portablePage = {
        ...page,
        source: {
          ...page.source,
          fileIdentity: null,
          fingerprint: serializeSourceFingerprint({
            ...expectedFingerprint,
            fileIdentity: null,
          }),
        },
      }
      expect((await readSessionEntriesByLocator({
        transcriptPath: candidate.path,
        projectsRoot: join(root, 'projects'),
        expectedProjectDir: '-tmp-project',
        page: portablePage,
      }))?.entries.map(entry => entry.type)).toEqual([
        'file-history-snapshot',
        'file-history-snapshot',
      ])
    } finally {
      database.close()
    }
  })

  it('rejects a same-inode same-size rewrite even when its mtime is restored', async () => {
    const root = await createTempDir('same-inode-rewrite')
    const original = fixedByteLine({
      type: 'assistant',
      uuid: 'old-assistant',
      message: { role: 'assistant', content: 'old' },
    })
    const replacement = fixedByteLine({
      type: 'file-history-snapshot',
      messageId: 'new-snapshot',
      snapshot: { messageId: 'new-snapshot', trackedFileBackups: {} },
    })
    const candidate = await createCandidate({
      root,
      projectPath: '-tmp-project',
      sessionId: '55555555-5555-4555-8555-555555555555',
      content: original,
    })
    const stableTimestamp = new Date('2026-07-15T00:00:00.000Z')
    await utimes(candidate.path, stableTimestamp, stableTimestamp)
    const database = openLocalIndexDatabase({ path: join(root, 'index-v1.sqlite') })
    const index = createSessionIndex(database)
    const projector = createSessionProjector({ database, index, scope: root })

    try {
      await projector.projectSource(candidate)
      const page = index.getSessionEntryLocators(
        candidate.path,
        ['file-history-snapshot'],
      )!
      expect(page.entries).toEqual([])
      const before = await stat(candidate.path)

      await writeFile(candidate.path, replacement)
      await utimes(candidate.path, before.atime, before.mtime)
      const after = await stat(candidate.path)
      expect(after.ino).toBe(before.ino)
      expect(after.size).toBe(before.size)
      expect(after.mtimeMs).toBe(page.source.mtimeMs)

      expect(await readSessionEntriesByLocator({
        transcriptPath: candidate.path,
        projectsRoot: join(root, 'projects'),
        expectedProjectDir: '-tmp-project',
        page,
      })).toBeNull()
    } finally {
      database.close()
    }
  })

  it('rejects corrupt, stale, out-of-scope, and symlink locator pages for file fallback', async () => {
    const root = await createTempDir('fallback')
    const candidate = await createCandidate({
      root,
      projectPath: '-tmp-project',
      sessionId: '44444444-4444-4444-8444-444444444444',
      content: line(user('target', 'target')),
    })
    const database = openLocalIndexDatabase({ path: join(root, 'index-v1.sqlite') })
    const index = createSessionIndex(database)
    const projector = createSessionProjector({ database, index, scope: root })

    try {
      await projector.projectSource(candidate)
      const page = index.getSessionEntryLocators(candidate.path, ['user'])!
      expect(await readSessionEntriesByLocator({
        transcriptPath: candidate.path,
        projectsRoot: join(root, 'projects'),
        expectedProjectDir: '-tmp-project',
        page: {
          ...page,
          entries: [{ ...page.entries[0]!, byteLength: page.source.size + 1 }],
        },
      })).toBeNull()

      await appendFile(candidate.path, line(user('stale append', 'stale')))
      expect(await readSessionEntriesByLocator({
        transcriptPath: candidate.path,
        projectsRoot: join(root, 'projects'),
        expectedProjectDir: '-tmp-project',
        page,
      })).toBeNull()

      const outside = join(root, 'outside.jsonl')
      await writeFile(outside, await readFile(candidate.path))
      expect(await readSessionEntriesByLocator({
        transcriptPath: outside,
        projectsRoot: join(root, 'projects'),
        expectedProjectDir: '-tmp-project',
        page: { ...page, source: { ...page.source, path: outside } },
      })).toBeNull()

      const link = join(root, 'projects', '-tmp-project', 'linked.jsonl')
      await symlink(process.platform === 'win32' ? root : outside, link, process.platform === 'win32' ? 'junction' : 'file')
      expect(await readSessionEntriesByLocator({
        transcriptPath: link,
        projectsRoot: join(root, 'projects'),
        expectedProjectDir: '-tmp-project',
        page: { ...page, source: { ...page.source, path: link } },
      })).toBeNull()
    } finally {
      database.close()
    }
  })
})
