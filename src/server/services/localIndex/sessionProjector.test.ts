import { afterEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { appendFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import {
  appendFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { openLocalIndexDatabase } from './database.js'
import { createSessionIndex, type SessionIndex } from './sessionIndex.js'
import {
  SESSION_SUMMARY_PARSER_VERSION,
  createSessionProjector,
  type SessionSourceCandidate,
} from './sessionProjector.js'
import { verifySourceFingerprint } from './sourceFingerprint.js'

const tempDirs: string[] = []
const exactFileTime = new Date(1_700_000_000_000)

async function createTempDir(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `cc-haha-${label}-`))
  tempDirs.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true }),
  ))
})

function line(entry: Record<string, unknown> | string): string {
  return `${typeof entry === 'string' ? entry : JSON.stringify(entry)}\n`
}

function user(title: string, timestamp: string): Record<string, unknown> {
  return {
    type: 'user',
    message: { role: 'user', content: title },
    timestamp,
  }
}

function assistant(timestamp: string): Record<string, unknown> {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: 'reply' },
    timestamp,
  }
}

async function createCandidate(options: {
  root: string
  projectPath: string
  sessionId: string
  content: string
  fileTime?: Date
}): Promise<SessionSourceCandidate> {
  const path = join(options.root, 'projects', options.projectPath, `${options.sessionId}.jsonl`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, options.content)
  if (options.fileTime) await utimes(path, options.fileTime, options.fileTime)
  const snapshot = await stat(path)
  return {
    path,
    sessionId: options.sessionId,
    projectPath: options.projectPath,
    fallbackCreatedAt: snapshot.birthtime.toISOString(),
    fallbackModifiedAt: snapshot.mtime.toISOString(),
    fallbackWorkDir: `/decoded/${options.projectPath}`,
    modifiedAtMs: snapshot.mtimeMs,
  }
}

async function sourceHash(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

describe('session projector', () => {
  it('fully builds without changing JSONL and preserves malformed/pending semantics', async () => {
    const root = await createTempDir('projector-full')
    const candidate = await createCandidate({
      root,
      projectPath: '-repo-a',
      sessionId: 'same-id',
      content: [
        line(user('First title', '2026-01-01T00:00:00.000Z')),
        line('{malformed}'),
        line(assistant('2026-01-01T00:01:00.000Z')),
        '{"type":"assistant"',
      ].join(''),
    })
    const beforeHash = await sourceHash(candidate.path)
    const database = openLocalIndexDatabase({ path: join(root, 'index.sqlite') })
    const index = createSessionIndex(database)
    const projector = createSessionProjector({
      database,
      index,
      scope: root,
    })

    try {
      const result = await projector.projectSource(candidate, {
        discovered: 1,
        indexed: 1,
      })

      expect(result).toMatchObject({
        kind: 'indexed',
        action: 'full',
        projection: {
          summary: {
            title: 'First title',
            messageCount: 2,
            modifiedAt: '2026-01-01T00:01:00.000Z',
          },
          malformedLineCount: 1,
        },
      })
      expect(result.kind === 'indexed' && result.projection.pendingTailBytes).toBeGreaterThan(0)
      expect(index.listSessions()).toMatchObject({
        total: 1,
        sessions: [{
          id: 'same-id',
          projectPath: '-repo-a',
          title: 'First title',
          messageCount: 2,
          transcriptPath: candidate.path,
        }],
      })
      expect(index.getSource(candidate.path)).toMatchObject({
        path: candidate.path,
        state: 'pending',
      })
      expect(await sourceHash(candidate.path)).toBe(beforeHash)
    } finally {
      database.close()
    }
  })

  it('refreshes stale discovery fallback times from the fingerprinted source snapshot', async () => {
    const root = await createTempDir('projector-fresh-fallback')
    const candidate = await createCandidate({
      root,
      projectPath: '-repo-a',
      sessionId: 'fresh-fallback',
      content: line({ type: 'session-meta', workDir: '/before' }),
    })
    const staleModifiedAt = candidate.fallbackModifiedAt
    await writeFile(
      candidate.path,
      line({ type: 'session-meta', workDir: '/after' }),
    )
    const forcedModifiedAt = new Date('2025-05-06T07:08:09.000Z')
    await utimes(candidate.path, forcedModifiedAt, forcedModifiedAt)
    const projectionSnapshot = await stat(candidate.path)
    const database = openLocalIndexDatabase({ path: join(root, 'index.sqlite') })
    const index = createSessionIndex(database)
    const projector = createSessionProjector({ database, index, scope: root })

    try {
      expect(projectionSnapshot.mtime.toISOString()).not.toBe(staleModifiedAt)
      expect(await projector.projectSource(candidate)).toMatchObject({
        kind: 'indexed',
        action: 'full',
        projection: {
          summary: {
            createdAt: projectionSnapshot.birthtime.toISOString(),
            modifiedAt: projectionSnapshot.mtime.toISOString(),
          },
        },
      })
      expect(index.listSessions().sessions[0]).toMatchObject({
        createdAt: projectionSnapshot.birthtime.toISOString(),
        modifiedAt: projectionSnapshot.mtime.toISOString(),
      })
    } finally {
      database.close()
    }
  })

  it('incrementally consumes a prior pending tail and only updates that source', async () => {
    const root = await createTempDir('projector-append')
    const first = await createCandidate({
      root,
      projectPath: '-repo-a',
      sessionId: 'first',
      content: `${line(user('First', '2026-01-01T00:00:00.000Z'))}{"type":"assistant"`,
    })
    const untouched = await createCandidate({
      root,
      projectPath: '-repo-b',
      sessionId: 'untouched',
      content: line(user('Untouched', '2026-01-01T00:02:00.000Z')),
    })
    const database = openLocalIndexDatabase({ path: join(root, 'index.sqlite') })
    const index = createSessionIndex(database)
    const projector = createSessionProjector({ database, index, scope: root })

    try {
      await projector.projectSource(first)
      await projector.projectSource(untouched)
      const untouchedSource = index.getSource(untouched.path)
      await appendFile(
        first.path,
        `,"message":{"role":"assistant","content":"done"},"timestamp":"2026-01-01T00:03:00.000Z"}\n`,
      )

      const result = await projector.projectSource(first)

      expect(result).toMatchObject({
        kind: 'indexed',
        action: 'append',
        projection: {
          summary: { messageCount: 2 },
          pendingTailBytes: 0,
        },
      })
      expect(index.getSource(untouched.path)).toEqual(untouchedSource)
    } finally {
      database.close()
    }
  })

  it('rebuilds an append when the prior summary depended on the file mtime fallback', async () => {
    const root = await createTempDir('projector-append-fallback')
    const candidate = await createCandidate({
      root,
      projectPath: '-repo-a',
      sessionId: 'append-fallback',
      content: line({ type: 'session-meta', workDir: '/before' }),
    })
    const database = openLocalIndexDatabase({ path: join(root, 'index.sqlite') })
    const index = createSessionIndex(database)
    const projector = createSessionProjector({ database, index, scope: root })

    try {
      expect(await projector.projectSource(candidate)).toMatchObject({
        kind: 'indexed',
        action: 'full',
      })
      await appendFile(candidate.path, line({ type: 'session-meta', workDir: '/after' }))
      const appendedSnapshot = await stat(candidate.path)

      expect(await projector.projectSource(candidate)).toMatchObject({
        kind: 'indexed',
        action: 'rebuild',
        projection: {
          summary: {
            modifiedAt: appendedSnapshot.mtime.toISOString(),
            workDir: '/after',
          },
        },
      })
    } finally {
      database.close()
    }
  })

  it('rebuilds one source for rewrites, parser changes, and missing reducer state after restart', async () => {
    const root = await createTempDir('projector-rebuild')
    const candidate = await createCandidate({
      root,
      projectPath: '-repo-a',
      sessionId: 'first',
      content: line(user('Original', '2026-01-01T00:00:00.000Z')),
    })
    const database = openLocalIndexDatabase({ path: join(root, 'index.sqlite') })
    const index = createSessionIndex(database)
    const firstProcess = createSessionProjector({ database, index, scope: root })

    try {
      await firstProcess.projectSource(candidate)
      await writeFile(
        candidate.path,
        line(user('Replacement', '2026-01-02T00:00:00.000Z')),
      )
      expect(await firstProcess.projectSource(candidate)).toMatchObject({
        kind: 'indexed',
        action: 'rebuild',
        projection: { summary: { title: 'Replacement', messageCount: 1 } },
      })

      const parserUpgrade = createSessionProjector({
        database,
        index,
        scope: root,
        parserVersion: SESSION_SUMMARY_PARSER_VERSION + 1,
      })
      expect(await parserUpgrade.projectSource(candidate)).toMatchObject({
        kind: 'indexed',
        action: 'rebuild',
      })

      const restartedProcess = createSessionProjector({
        database,
        index,
        scope: root,
        parserVersion: SESSION_SUMMARY_PARSER_VERSION + 1,
      })
      await appendFile(candidate.path, line(assistant('2026-01-02T00:01:00.000Z')))
      expect(await restartedProcess.projectSource(candidate)).toMatchObject({
        kind: 'indexed',
        action: 'rebuild',
        projection: { summary: { title: 'Replacement', messageCount: 2 } },
      })
    } finally {
      database.close()
    }
  })

  it('keeps duplicate ids distinct and queries project-filtered deterministic pages', async () => {
    const root = await createTempDir('projector-query')
    const database = openLocalIndexDatabase({ path: join(root, 'index.sqlite') })
    const index = createSessionIndex(database)
    const projector = createSessionProjector({ database, index, scope: root })
    const candidates = [
      await createCandidate({
        root,
        projectPath: '-repo-b',
        sessionId: 'duplicate',
        content: line(user('B', '2026-01-01T00:00:00.000Z')),
      }),
      await createCandidate({
        root,
        projectPath: '-repo-a',
        sessionId: 'duplicate',
        content: line(user('A', '2026-01-01T01:00:00.000+01:00')),
      }),
      await createCandidate({
        root,
        projectPath: '-repo-a',
        sessionId: 'later',
        content: line(user('Later', '2026-01-02T00:00:00.000Z')),
      }),
      await createCandidate({
        root,
        projectPath: '-repo-c',
        sessionId: 'timezone-later',
        content: line(user('Timezone later', '2026-01-01T00:30:00.000Z')),
      }),
    ]

    try {
      for (const candidate of candidates) await projector.projectSource(candidate)

      expect(index.listSessions().sessions.map(item => [item.id, item.projectPath])).toEqual([
        ['later', '-repo-a'],
        ['timezone-later', '-repo-c'],
        ['duplicate', '-repo-a'],
        ['duplicate', '-repo-b'],
      ])
      expect(index.listSessions({ project: '-repo-a', limit: 1, offset: 1 })).toMatchObject({
        total: 2,
        sessions: [{ id: 'duplicate', title: 'A' }],
      })
      expect(index.findSearchCandidates?.({
        project: '-repo-a',
        modifiedAfterMs: Date.parse('2026-01-02T00:00:00.000Z'),
        modifiedBeforeMs: Date.parse('2026-01-02T23:59:59.999Z'),
      })).toEqual([{
        transcriptPath: candidates[2]!.path,
        id: 'later',
        title: 'Later',
        modifiedAt: '2026-01-02T00:00:00.000Z',
        projectPath: '-repo-a',
        workDir: '/decoded/-repo-a',
      }])
      expect(index.findSessionFiles('duplicate')).toEqual([
        { filePath: candidates[1]!.path, projectDir: '-repo-a' },
        { filePath: candidates[0]!.path, projectDir: '-repo-b' },
      ])
    } finally {
      database.close()
    }
  })

  it('round-trips absent, explicit-null, and string runtime provider metadata', async () => {
    const root = await createTempDir('projector-provider-presence')
    const database = openLocalIndexDatabase({ path: join(root, 'index.sqlite') })
    const index = createSessionIndex(database)
    const projector = createSessionProjector({ database, index, scope: root })
    const candidates = [
      await createCandidate({
        root,
        projectPath: '-repo-a',
        sessionId: 'absent',
        content: line(user('Absent', '2026-01-01T00:00:00.000Z')),
      }),
      await createCandidate({
        root,
        projectPath: '-repo-a',
        sessionId: 'explicit-null',
        content: line({
          type: 'session-meta',
          runtimeProviderId: null,
          timestamp: '2026-01-01T00:01:00.000Z',
        }),
      }),
      await createCandidate({
        root,
        projectPath: '-repo-a',
        sessionId: 'string',
        content: line({
          type: 'session-meta',
          runtimeProviderId: 'provider-a',
          timestamp: '2026-01-01T00:02:00.000Z',
        }),
      }),
    ]

    try {
      for (const candidate of candidates) await projector.projectSource(candidate)
      const byId = new Map(index.listSessions({ limit: 10 }).sessions.map(row => [row.id, row]))

      expect(Object.hasOwn(byId.get('absent')!, 'runtimeProviderId')).toBe(false)
      expect(Object.hasOwn(byId.get('explicit-null')!, 'runtimeProviderId')).toBe(true)
      expect(byId.get('explicit-null')!.runtimeProviderId).toBeNull()
      expect(byId.get('string')!.runtimeProviderId).toBe('provider-a')
    } finally {
      database.close()
    }
  })

  it('removes only a confirmed missing source projection', async () => {
    const root = await createTempDir('projector-delete')
    const candidate = await createCandidate({
      root,
      projectPath: '-repo-a',
      sessionId: 'deleted',
      content: line(user('Delete me', '2026-01-01T00:00:00.000Z')),
    })
    const database = openLocalIndexDatabase({ path: join(root, 'index.sqlite') })
    const index = createSessionIndex(database)
    const projector = createSessionProjector({ database, index, scope: root })

    try {
      await projector.projectSource(candidate)
      await rm(candidate.path)

      expect(await projector.deleteSource(candidate.path)).toEqual({ kind: 'deleted' })
      expect(index.listSessions()).toEqual({ sessions: [], total: 0 })
      expect(index.getSource(candidate.path)).toBeNull()
    } finally {
      database.close()
    }
  })

  it('retains all derived rows when a missing source is recreated before delete BEGIN', async () => {
    const root = await createTempDir('projector-delete-recreate')
    const canonical = line(user('Keep me', '2026-01-01T00:00:00.000Z'))
    const candidate = await createCandidate({
      root,
      projectPath: '-repo-a',
      sessionId: 'delete-recreate',
      content: canonical,
    })
    const database = openLocalIndexDatabase({ path: join(root, 'index.sqlite') })
    const index = createSessionIndex(database)
    const initialProjector = createSessionProjector({ database, index, scope: root })

    try {
      await initialProjector.projectSource(candidate, { discovered: 1, indexed: 1 })
      const sourceBefore = index.getSource(candidate.path)
      const sessionsBefore = index.listSessions()
      const backfillBefore = index.getBackfillState(root)
      await rm(candidate.path)
      let recreated = false
      const deleteProjector = createSessionProjector({
        database,
        index,
        scope: root,
        fileIo: {
          openReadonly(path, flags) {
            return open(path, flags)
          },
          async statPath(path) {
            try {
              return await stat(path)
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !recreated) {
                recreated = true
                await writeFile(path, canonical)
              }
              throw error
            }
          },
        },
      })

      expect(await deleteProjector.deleteSource(candidate.path, {
        discovered: 1,
        indexed: 1,
      })).toEqual({ kind: 'retry', reason: 'changed-during-read' })
      expect(recreated).toBe(true)
      expect(index.getSource(candidate.path)).toEqual(sourceBefore)
      expect(index.listSessions()).toEqual(sessionsBefore)
      expect(index.getBackfillState(root)).toEqual(backfillBefore)
      expect(await readFile(candidate.path, 'utf8')).toBe(canonical)
    } finally {
      database.close()
    }
  })

  it('uses progress or COUNT(*) without materializing all source rows per projection', async () => {
    const root = await createTempDir('projector-source-count')
    const database = openLocalIndexDatabase({ path: join(root, 'index.sqlite') })
    const realIndex = createSessionIndex(database)
    let listSourcesCalls = 0
    let countSourcesCalls = 0
    const index: SessionIndex = {
      ...realIndex,
      listSources() {
        listSourcesCalls += 1
        return realIndex.listSources()
      },
      countSources() {
        countSourcesCalls += 1
        return realIndex.countSources()
      },
    }
    const progressed = await createCandidate({
      root,
      projectPath: '-repo-a',
      sessionId: 'progressed',
      content: line(user('Progressed', '2026-01-01T00:00:00.000Z')),
    })
    const independent = await createCandidate({
      root,
      projectPath: '-repo-b',
      sessionId: 'independent',
      content: line(user('Independent', '2026-01-01T00:01:00.000Z')),
    })
    const projector = createSessionProjector({ database, index, scope: root })

    try {
      await projector.projectSource(progressed, { discovered: 1, indexed: 1 })
      await projector.projectSource(progressed, { discovered: 1, indexed: 1 })
      await rm(progressed.path)
      await projector.deleteSource(progressed.path, { discovered: 1, indexed: 1 })
      expect(listSourcesCalls).toBe(0)
      expect(countSourcesCalls).toBe(0)

      await projector.projectSource(independent)
      expect(listSourcesCalls).toBe(0)
      expect(countSourcesCalls).toBeGreaterThan(0)
      expect(realIndex.countSources()).toBe(1)
    } finally {
      database.close()
    }
  })

  it('does not write any row when commit-time verification sees a changed source', async () => {
    const root = await createTempDir('projector-rollback')
    const candidate = await createCandidate({
      root,
      projectPath: '-repo-a',
      sessionId: 'race',
      content: line(user('Before', '2026-01-01T00:00:00.000Z')),
    })
    const database = openLocalIndexDatabase({ path: join(root, 'index.sqlite') })
    const index = createSessionIndex(database)
    let changed = false
    const projector = createSessionProjector({
      database,
      index,
      scope: root,
      verifyFingerprint: async (options) => {
        if (!changed) {
          changed = true
          await appendFile(candidate.path, line(assistant('2026-01-01T00:01:00.000Z')))
        }
        return verifySourceFingerprint(options)
      },
    })

    try {
      expect(await projector.projectSource(candidate)).toEqual({
        kind: 'retry',
        reason: 'changed-during-read',
      })
      expect(index.listSessions()).toEqual({ sessions: [], total: 0 })
      expect(index.getSource(candidate.path)).toBeNull()
      expect(index.getBackfillState(root)).toBeNull()
    } finally {
      database.close()
    }
  })

  it('rolls back source, session, and backfill rows when SQL projection work fails mid-transaction', async () => {
    const root = await createTempDir('projector-sql-rollback')
    const candidate = await createCandidate({
      root,
      projectPath: '-repo-a',
      sessionId: 'sql-race',
      content: line(user('Atomic', '2026-01-01T00:00:00.000Z')),
    })
    const database = openLocalIndexDatabase({ path: join(root, 'index.sqlite') })
    const index = createSessionIndex(database)
    const projector = createSessionProjector({
      database,
      index,
      scope: root,
      beforeSessionUpsert: () => {
        throw new Error('injected-session-upsert-failure')
      },
    })

    try {
      await expect(projector.projectSource(candidate)).rejects.toThrow(
        'injected-session-upsert-failure',
      )
      expect(index.getSource(candidate.path)).toBeNull()
      expect(index.listSessions()).toEqual({ sessions: [], total: 0 })
      expect(index.getBackfillState(root)).toBeNull()
    } finally {
      database.close()
    }
  })

  it('rolls back all rows when the source changes inside the short write transaction', async () => {
    const root = await createTempDir('projector-commit-guard')
    const candidate = await createCandidate({
      root,
      projectPath: '-repo-a',
      sessionId: 'commit-race',
      content: line(user('Atomic', '2026-01-01T00:00:00.000Z')),
    })
    const database = openLocalIndexDatabase({ path: join(root, 'index.sqlite') })
    const index = createSessionIndex(database)
    let changed = false
    const projector = createSessionProjector({
      database,
      index,
      scope: root,
      beforeSessionUpsert: () => {
        if (changed) return
        changed = true
        appendFileSync(candidate.path, line(assistant('2026-01-01T00:01:00.000Z')))
      },
    })

    try {
      expect(await projector.projectSource(candidate)).toEqual({
        kind: 'retry',
        reason: 'changed-during-read',
      })
      expect(index.getSource(candidate.path)).toBeNull()
      expect(index.listSessions()).toEqual({ sessions: [], total: 0 })
      expect(index.getBackfillState(root)).toBeNull()
    } finally {
      database.close()
    }
  })

  it('rolls back all rows when an equal-length rewrite restores mtime inside the transaction', async () => {
    const root = await createTempDir('projector-commit-ctime-guard')
    const beforeContent = line(user('Before', '2026-01-01T00:00:00.000Z'))
    const afterContent = line(user('Forged', '2026-01-01T00:00:00.000Z'))
    expect(afterContent.length).toBe(beforeContent.length)
    const candidate = await createCandidate({
      root,
      projectPath: '-repo-a',
      sessionId: 'commit-ctime-race',
      content: beforeContent,
      fileTime: exactFileTime,
    })
    const originalSnapshot = await stat(candidate.path)
    const database = openLocalIndexDatabase({ path: join(root, 'index.sqlite') })
    const index = createSessionIndex(database)
    let changed = false
    const projector = createSessionProjector({
      database,
      index,
      scope: root,
      beforeSessionUpsert: () => {
        if (changed) return
        changed = true
        writeFileSync(candidate.path, afterContent)
        utimesSync(
          candidate.path,
          exactFileTime,
          exactFileTime,
        )
      },
    })

    try {
      expect(await projector.projectSource(candidate)).toEqual({
        kind: 'retry',
        reason: 'changed-during-read',
      })
      const rewrittenSnapshot = statSync(candidate.path)
      expect(changed).toBe(true)
      expect(rewrittenSnapshot.size).toBe(originalSnapshot.size)
      expect(rewrittenSnapshot.mtimeMs).toBe(originalSnapshot.mtimeMs)
      expect(rewrittenSnapshot.ctimeMs).not.toBe(originalSnapshot.ctimeMs)
      expect(await readFile(candidate.path, 'utf8')).toBe(afterContent)
      expect(index.getSource(candidate.path)).toBeNull()
      expect(index.listSessions()).toEqual({ sessions: [], total: 0 })
      expect(index.getBackfillState(root)).toBeNull()
    } finally {
      database.close()
    }
  })

  it('rolls back activity rows when an equal-length rewrite restores mtime inside the transaction', async () => {
    const root = await createTempDir('projector-activity-commit-ctime-guard')
    const beforeContent = line(user('Before', '2026-01-01T00:00:00.000Z'))
    const afterContent = line(user('Forged', '2026-01-01T00:00:00.000Z'))
    expect(afterContent.length).toBe(beforeContent.length)
    const candidate = await createCandidate({
      root,
      projectPath: '-repo-a',
      sessionId: 'activity-commit-ctime-race',
      content: beforeContent,
      fileTime: exactFileTime,
    })
    const originalSnapshot = await stat(candidate.path)
    const database = openLocalIndexDatabase({ path: join(root, 'index.sqlite') })
    const index = createSessionIndex(database)
    let changed = false
    const projector = createSessionProjector({
      database,
      index,
      scope: root,
      syncStat: (path) => {
        if (!changed) {
          changed = true
          writeFileSync(path, afterContent)
          utimesSync(
            path,
            exactFileTime,
            exactFileTime,
          )
        }
        return statSync(path)
      },
    })

    try {
      expect(await projector.projectActivitySource(candidate)).toEqual({
        kind: 'retry',
        reason: 'changed-during-read',
      })
      const rewrittenSnapshot = statSync(candidate.path)
      expect(changed).toBe(true)
      expect(rewrittenSnapshot.size).toBe(originalSnapshot.size)
      expect(rewrittenSnapshot.mtimeMs).toBe(originalSnapshot.mtimeMs)
      expect(rewrittenSnapshot.ctimeMs).not.toBe(originalSnapshot.ctimeMs)
      expect(await readFile(candidate.path, 'utf8')).toBe(afterContent)
      expect(index.getActivitySource(candidate.path)).toBeNull()
    } finally {
      database.close()
    }
  })

  it.each(['after verify', 'inside transaction'] as const)(
    'generation fencing prevents an old projector commit %s',
    async (cancelAt) => {
      const root = await createTempDir(`projector-generation-${cancelAt.replace(' ', '-')}`)
      const candidate = await createCandidate({
        root,
        projectPath: '-repo-a',
        sessionId: 'old-generation',
        content: line(user('Old generation', '2026-01-01T00:00:00.000Z')),
      })
      const database = openLocalIndexDatabase({ path: join(root, 'index.sqlite') })
      const index = createSessionIndex(database)
      let active = true
      const projector = createSessionProjector({
        database,
        index,
        scope: root,
        canCommit: () => active,
        ...(cancelAt === 'after verify'
          ? {
            verifyFingerprint: async (options) => {
              const result = await verifySourceFingerprint(options)
              active = false
              return result
            },
          }
          : {
            beforeSessionUpsert: () => {
              active = false
            },
          }),
      })

      try {
        expect(await projector.projectSource(candidate)).toMatchObject({ kind: 'retry' })
        expect(index.getSource(candidate.path)).toBeNull()
        expect(index.listSessions()).toEqual({ sessions: [], total: 0 })
        expect(index.getBackfillState(root)).toBeNull()
      } finally {
        database.close()
      }
    },
  )

  it('opens sources read-only, closes the handle, and bounds reducer batches', async () => {
    const root = await createTempDir('projector-streaming')
    const content = Array.from({ length: 1_200 }, (_, index) => line(user(
      `${index.toString().padStart(4, '0')}-${'x'.repeat(1_800)}`,
      new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    ))).join('')
    const candidate = await createCandidate({
      root,
      projectPath: '-repo-a',
      sessionId: 'streaming',
      content,
    })
    const database = openLocalIndexDatabase({ path: join(root, 'index.sqlite') })
    const index = createSessionIndex(database)
    const flags: string[] = []
    let closeCount = 0
    const projector = createSessionProjector({
      database,
      index,
      scope: root,
      fileIo: {
        async openReadonly(path, flag) {
          flags.push(flag)
          const handle = await open(path, flag)
          return {
            stat: () => handle.stat(),
            read: (buffer, offset, length, position) =>
              handle.read(buffer, offset, length, position),
            async close() {
              closeCount += 1
              await handle.close()
            },
          }
        },
        statPath: path => stat(path),
      },
    })

    try {
      const result = await projector.projectSource(candidate)

      expect(result).toMatchObject({ kind: 'indexed', action: 'full' })
      expect(result.kind === 'indexed' && result.work.maxBufferedChunks).toBeLessThanOrEqual(256)
      expect(result.kind === 'indexed' && result.work.maxBufferedBytes).toBeLessThan(1_100_000)
      expect(flags.length).toBeGreaterThanOrEqual(4)
      expect(flags.every(flag => flag === 'r')).toBe(true)
      expect(closeCount).toBe(flags.length)
    } finally {
      database.close()
    }
  })
})
