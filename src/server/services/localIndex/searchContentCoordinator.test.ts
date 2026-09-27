import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createSearchContentCoordinator,
  discoverSearchContentSources,
  type SearchContentCoordinatorStatus,
} from './searchContentCoordinator.js'
import { openSearchContentDatabase } from './searchContentDatabase.js'
import { createSearchContentIndex } from './searchContentIndex.js'
import type {
  ReconciliationBatch,
  ReconciliationWatcherOptions,
} from './reconciliationWatcher.js'

const tempDirs: string[] = []

async function createTempScope(): Promise<string> {
  const scope = await mkdtemp(join(tmpdir(), 'cc-haha-search-content-coordinator-'))
  tempDirs.push(scope)
  return scope
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(path =>
    rm(path, { recursive: true, force: true }),
  ))
})

async function waitForStatus(
  getStatus: () => SearchContentCoordinatorStatus,
  state: SearchContentCoordinatorStatus['state'],
): Promise<SearchContentCoordinatorStatus> {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    const status = getStatus()
    if (status.state === state) return status
    await Bun.sleep(5)
  }
  throw new Error(`Timed out waiting for search content state ${state}`)
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await Bun.sleep(5)
  }
  throw new Error('Timed out waiting for coordinator condition')
}

function noOpWatcher(options?: {
  start?: () => Promise<void>
  stop?: () => Promise<void>
}) {
  return {
    start: options?.start ?? (async () => {}),
    stop: options?.stop ?? (async () => {}),
    queueTranscriptPath() {},
    queueFullSweep() {},
    getMetrics: () => ({
      queuedPaths: 0,
      maxBatchSize: 0,
      yielded: 0,
      fullSweeps: 0,
      watchFailures: 0,
    }),
  }
}

function userLine(text: string, id = 'message'): string {
  return `${JSON.stringify({
    type: 'user',
    uuid: id,
    timestamp: '2026-07-16T00:00:00.000Z',
    message: { role: 'user', content: text },
  })}\n`
}

describe('search content coordinator', () => {
  test('recursively discovers root, session, subagent, workflow, and journal JSONL sources', async () => {
    const scope = await createTempScope()
    const projects = join(scope, 'projects')
    const project = join(projects, '-repo')
    const owner = join(project, 'owner-session.jsonl')
    const subagent = join(project, 'owner-session', 'subagents', 'agent-1.jsonl')
    const workflowAgent = join(
      project,
      'owner-session',
      'subagents',
      'workflows',
      'wf-1',
      'agent-2.jsonl',
    )
    const journal = join(
      project,
      'owner-session',
      'subagents',
      'workflows',
      'wf-1',
      'journal.jsonl',
    )
    const rootFile = join(projects, 'orphan.jsonl')
    await Promise.all([owner, subagent, workflowAgent, journal, rootFile].map(async path => {
      await mkdir(join(path, '..'), { recursive: true })
      await writeFile(path, userLine(path))
    }))
    await writeFile(join(project, 'ignore.json'), '{}')

    const candidates: Parameters<Parameters<typeof discoverSearchContentSources>[2]>[0] = []
    const controller = new AbortController()
    const result = await discoverSearchContentSources(
      scope,
      controller.signal,
      async batch => {
        candidates.push(...batch)
      },
    )

    expect(result).toEqual({ complete: true })
    expect(candidates.map(candidate => candidate.path).sort()).toEqual([
      journal,
      owner,
      rootFile,
      subagent,
      workflowAgent,
    ].sort())
    expect(candidates.find(candidate => candidate.path === subagent)).toMatchObject({
      projectPath: '-repo',
      ownerSessionId: 'owner-session',
      ownerTranscriptPath: owner,
    })
    expect(candidates.find(candidate => candidate.path === rootFile)).toMatchObject({
      projectPath: 'projects',
      ownerSessionId: 'orphan',
      ownerTranscriptPath: rootFile,
    })
  })

  test('keeps queries on fallback until full backfill, then invalidates before watcher debounce', async () => {
    const scope = await createTempScope()
    const project = join(scope, 'projects', '-repo')
    const owner = join(project, 'owner-session.jsonl')
    const nested = join(project, 'owner-session', 'subagents', 'agent-1.jsonl')
    await mkdir(project, { recursive: true })
    await writeFile(owner, userLine('owner sqlite searchable'))

    let watcherOptions: ReconciliationWatcherOptions | undefined
    let stopped = false
    const coordinator = createSearchContentCoordinator({
      resolveScope: () => scope,
      resolveDatabasePath: () => join(scope, 'cc-haha', 'db', 'search-index-v1.sqlite'),
      schedule: task => queueMicrotask(task),
      createWatcher: options => {
        watcherOptions = options
        return {
          async start() {},
          async stop() {
            stopped = true
          },
          queueTranscriptPath() {},
          queueFullSweep() {},
          getMetrics: () => ({
            queuedPaths: 0,
            maxBatchSize: 0,
            yielded: 0,
            fullSweeps: 0,
            watchFailures: 0,
          }),
        }
      },
    })

    await coordinator.start()
    expect(coordinator.search('sqlite')).toBeNull()
    expect(coordinator.suggestSessions('sqlite')).toBeNull()
    await waitForStatus(coordinator.getStatus, 'ready')
    expect(coordinator.search('sqlite')?.sessions[0]).toMatchObject({
      ownerSessionId: 'owner-session',
      matchCount: 1,
    })

    expect(coordinator.suggestSessions('sqlite')?.sessions[0]?.ownerSessionId).toBe('owner-session')
    expect(coordinator.suggestSessions('sqlite', { signal: AbortSignal.abort() })).toBeNull()

    await mkdir(join(nested, '..'), { recursive: true })
    await writeFile(nested, userLine('nested workflow needle', 'nested-message'))
    watcherOptions?.onDirty?.()
    expect(coordinator.search('needle')).toBeNull()
    expect(coordinator.suggestSessions('needle')).toBeNull()
    await watcherOptions?.onBatch({ paths: [nested], fullSweep: false } satisfies ReconciliationBatch)
    await waitForStatus(coordinator.getStatus, 'ready')

    const nestedResult = coordinator.search('needle')
    expect(nestedResult?.sessions).toHaveLength(1)
    expect(nestedResult?.sessions[0]).toMatchObject({
      ownerSessionId: 'owner-session',
      ownerTranscriptPath: owner,
    })
    expect(nestedResult?.sessions[0]?.matches[0]).toMatchObject({
      sourcePath: nested,
      messageId: 'nested-message',
      body: 'nested workflow needle',
    })

    await coordinator.stop()
    expect(stopped).toBe(true)
  })

  test('never treats an incomplete recursive discovery as query-ready', async () => {
    const scope = await createTempScope()
    const coordinator = createSearchContentCoordinator({
      resolveScope: () => scope,
      resolveDatabasePath: () => join(scope, 'cc-haha', 'db', 'search-index-v1.sqlite'),
      schedule: task => queueMicrotask(task),
      discoverSources: async () => ({ complete: false }),
      createWatcher: () => ({
        async start() {},
        async stop() {},
        queueTranscriptPath() {},
        queueFullSweep() {},
        getMetrics: () => ({
          queuedPaths: 0,
          maxBatchSize: 0,
          yielded: 0,
          fullSweeps: 0,
          watchFailures: 0,
        }),
      }),
    })

    await coordinator.start()
    const status = await waitForStatus(coordinator.getStatus, 'degraded')
    expect(status.lastErrorCode).toBe('SEARCH_CONTENT_DISCOVERY_INCOMPLETE')
    expect(coordinator.search('anything')).toBeNull()
    await coordinator.stop()
  })

  test('keeps a half-written source on fallback until its JSONL line is complete', async () => {
    const scope = await createTempScope()
    const source = join(scope, 'projects', '-repo', 'pending-session.jsonl')
    await mkdir(join(source, '..'), { recursive: true })
    await writeFile(source, userLine('pending search needle').trimEnd())
    let watcherOptions: ReconciliationWatcherOptions | undefined
    const coordinator = createSearchContentCoordinator({
      resolveScope: () => scope,
      resolveDatabasePath: () => join(scope, 'cc-haha', 'db', 'search-index-v1.sqlite'),
      createWatcher: options => {
        watcherOptions = options
        return {
          async start() {},
          async stop() {},
          queueTranscriptPath() {},
          queueFullSweep() {},
          getMetrics: () => ({
            queuedPaths: 0,
            maxBatchSize: 0,
            yielded: 0,
            fullSweeps: 0,
            watchFailures: 0,
          }),
        }
      },
    })

    await coordinator.start()
    expect((await waitForStatus(coordinator.getStatus, 'degraded')).lastErrorCode)
      .toBe('SEARCH_CONTENT_SOURCE_PENDING')
    expect(coordinator.search('needle')).toBeNull()

    await writeFile(source, userLine('pending search needle'))
    watcherOptions?.onDirty?.()
    await watcherOptions?.onBatch({ paths: [source], fullSweep: false })
    await waitForStatus(coordinator.getStatus, 'ready')
    expect(coordinator.search('needle')?.sessions[0]?.ownerSessionId)
      .toBe('pending-session')
    await coordinator.stop()
  })

  test('discards only a corrupt disposable search database and rebuilds it', async () => {
    const scope = await createTempScope()
    const source = join(scope, 'projects', '-repo', 'session.jsonl')
    const databasePath = join(scope, 'cc-haha', 'db', 'search-index-v1.sqlite')
    await mkdir(join(source, '..'), { recursive: true })
    await mkdir(join(databasePath, '..'), { recursive: true })
    await writeFile(source, userLine('rebuilt after corruption'))
    await writeFile(databasePath, 'this is not sqlite')

    const coordinator = createSearchContentCoordinator({
      resolveScope: () => scope,
      resolveDatabasePath: () => databasePath,
      createWatcher: () => ({
        async start() {},
        async stop() {},
        queueTranscriptPath() {},
        queueFullSweep() {},
        getMetrics: () => ({
          queuedPaths: 0,
          maxBatchSize: 0,
          yielded: 0,
          fullSweeps: 0,
          watchFailures: 0,
        }),
      }),
    })

    await coordinator.start()
    await waitForStatus(coordinator.getStatus, 'ready')
    expect(coordinator.search('corruption')?.sessions[0]?.ownerSessionId)
      .toBe('session')
    expect((await readFile(databasePath)).subarray(0, 16).toString())
      .toBe('SQLite format 3\0')
    await coordinator.stop()
  })

  test('falls back instead of querying when the disposable index exceeds its cap', async () => {
    const scope = await createTempScope()
    const source = join(scope, 'projects', '-repo', 'session.jsonl')
    await mkdir(join(source, '..'), { recursive: true })
    await writeFile(source, userLine('storage limit fallback'))

    const coordinator = createSearchContentCoordinator({
      resolveScope: () => scope,
      resolveDatabasePath: () => join(scope, 'cc-haha', 'db', 'search-index-v1.sqlite'),
      storageLimitBytes: 1,
      createWatcher: () => ({
        async start() {},
        async stop() {},
        queueTranscriptPath() {},
        queueFullSweep() {},
        getMetrics: () => ({
          queuedPaths: 0,
          maxBatchSize: 0,
          yielded: 0,
          fullSweeps: 0,
          watchFailures: 0,
        }),
      }),
    })

    await coordinator.start()
    const status = await waitForStatus(coordinator.getStatus, 'degraded')
    expect(status.lastErrorCode).toBe('SEARCH_CONTENT_STORAGE_LIMIT')
    expect(status.databaseBytes + status.walBytes).toBeGreaterThan(1)
    expect(coordinator.search('fallback')).toBeNull()
    await coordinator.stop()
  })

  test('keeps a populated projection on fallback when the projects root disappears', async () => {
    const scope = await createTempScope()
    const source = join(scope, 'projects', '-repo', 'session.jsonl')
    const databasePath = join(scope, 'cc-haha', 'db', 'search-index-v1.sqlite')
    await mkdir(join(source, '..'), { recursive: true })
    await writeFile(source, userLine('persisted root missing needle'))

    const first = createSearchContentCoordinator({
      resolveScope: () => scope,
      resolveDatabasePath: () => databasePath,
      createWatcher: () => noOpWatcher(),
    })
    await first.start()
    await waitForStatus(first.getStatus, 'ready')
    await first.stop()
    await rm(join(scope, 'projects'), { recursive: true, force: true })

    const reopened = createSearchContentCoordinator({
      resolveScope: () => scope,
      resolveDatabasePath: () => databasePath,
      createWatcher: () => noOpWatcher(),
    })
    await reopened.start()
    const status = await waitForStatus(reopened.getStatus, 'degraded')
    expect(status.lastErrorCode).toBe('SEARCH_CONTENT_PROJECTS_ROOT_MISSING')
    expect(status.discovered).toBe(1)
    expect(reopened.search('needle')).toBeNull()
    await reopened.stop()
  })

  test('requires an openable owner for nested sources and retains the source mtime', async () => {
    const scope = await createTempScope()
    const project = join(scope, 'projects', '-repo')
    const owner = join(project, 'owner.jsonl')
    const nested = join(project, 'owner', 'subagents', 'agent.jsonl')
    await mkdir(join(nested, '..'), { recursive: true })
    await writeFile(owner, userLine('owner'))
    await writeFile(nested, userLine('nested'))
    const ownerTime = new Date('2026-01-01T00:00:00.000Z')
    const nestedTime = new Date('2026-02-01T00:00:00.000Z')
    await utimes(owner, ownerTime, ownerTime)
    await utimes(nested, nestedTime, nestedTime)

    const candidates: Parameters<Parameters<typeof discoverSearchContentSources>[2]>[0] = []
    const complete = await discoverSearchContentSources(
      scope,
      new AbortController().signal,
      async batch => candidates.push(...batch),
    )
    expect(complete).toEqual({ complete: true })
    expect(candidates.find(candidate => candidate.path === nested)?.modifiedAtMs)
      .toBe(nestedTime.getTime())

    const coordinator = createSearchContentCoordinator({
      resolveScope: () => scope,
      resolveDatabasePath: () => join(scope, 'cc-haha', 'db', 'search-index-v1.sqlite'),
      createWatcher: () => noOpWatcher(),
    })
    await coordinator.start()
    await waitForStatus(coordinator.getStatus, 'ready')
    expect(coordinator.search('nested', {
      modifiedAfterMs: new Date('2026-01-15T00:00:00.000Z').getTime(),
    })?.sessions[0]?.ownerSessionId).toBe('owner')
    await coordinator.stop()

    await rm(owner)
    candidates.length = 0
    const missingOwner = await discoverSearchContentSources(
      scope,
      new AbortController().signal,
      async batch => candidates.push(...batch),
    )
    expect(missingOwner).toEqual({ complete: false })
    expect(candidates.some(candidate => candidate.path === nested)).toBe(false)
  })

  test('removes nested projections and falls back when their owner is deleted', async () => {
    const scope = await createTempScope()
    const project = join(scope, 'projects', '-repo')
    const owner = join(project, 'owner.jsonl')
    const nested = join(project, 'owner', 'subagents', 'agent.jsonl')
    await mkdir(join(nested, '..'), { recursive: true })
    await writeFile(owner, userLine('owner'))
    await writeFile(nested, userLine('nested owner deletion needle'))
    let watcherOptions: ReconciliationWatcherOptions | undefined
    const coordinator = createSearchContentCoordinator({
      resolveScope: () => scope,
      resolveDatabasePath: () => join(scope, 'cc-haha', 'db', 'search-index-v1.sqlite'),
      createWatcher: options => {
        watcherOptions = options
        return noOpWatcher()
      },
    })
    await coordinator.start()
    await waitForStatus(coordinator.getStatus, 'ready')
    expect(coordinator.search('needle')?.sessions[0]?.ownerTranscriptPath).toBe(owner)

    await rm(owner)
    watcherOptions?.onDirty?.()
    await watcherOptions?.onBatch({ paths: [owner], fullSweep: false })
    const degraded = await waitForStatus(coordinator.getStatus, 'degraded')
    expect(degraded.lastErrorCode).toBe('SEARCH_CONTENT_OWNER_MISSING')
    expect(coordinator.search('needle')).toBeNull()

    await writeFile(owner, userLine('restored owner'))
    watcherOptions?.onDirty?.()
    await watcherOptions?.onBatch({ paths: [owner], fullSweep: false })
    await waitForStatus(coordinator.getStatus, 'ready')
    expect(coordinator.search('needle')?.sessions[0]?.ownerTranscriptPath).toBe(owner)
    await coordinator.stop()
  })

  test('serializes restart behind stop so an old stop cannot close the new connection', async () => {
    const scope = await createTempScope()
    const source = join(scope, 'projects', '-repo', 'session.jsonl')
    await mkdir(join(source, '..'), { recursive: true })
    await writeFile(source, userLine('restart lifecycle needle'))
    let releaseStop!: () => void
    const stopGate = new Promise<void>(resolve => {
      releaseStop = resolve
    })
    let stopEntered!: () => void
    const entered = new Promise<void>(resolve => {
      stopEntered = resolve
    })
    let watcherCount = 0
    const coordinator = createSearchContentCoordinator({
      resolveScope: () => scope,
      resolveDatabasePath: () => join(scope, 'cc-haha', 'db', 'search-index-v1.sqlite'),
      createWatcher: () => {
        watcherCount += 1
        const current = watcherCount
        return noOpWatcher({
          stop: async () => {
            if (current !== 1) return
            stopEntered()
            await stopGate
          },
        })
      },
    })
    await coordinator.start()
    await waitForStatus(coordinator.getStatus, 'ready')

    const stopping = coordinator.stop()
    await entered
    const restarting = coordinator.start()
    await Bun.sleep(10)
    expect(watcherCount).toBe(1)
    releaseStop()
    await Promise.all([stopping, restarting])
    await waitForStatus(coordinator.getStatus, 'ready')
    expect(watcherCount).toBe(2)
    expect(coordinator.search('needle')?.sessions).toHaveLength(1)
    await coordinator.stop()
  })

  test('fully cleans a failed start and allows the next start to retry', async () => {
    const scope = await createTempScope()
    const source = join(scope, 'projects', '-repo', 'session.jsonl')
    await mkdir(join(source, '..'), { recursive: true })
    await writeFile(source, userLine('retry start needle'))
    let watcherStarts = 0
    let watcherStops = 0
    const coordinator = createSearchContentCoordinator({
      resolveScope: () => scope,
      resolveDatabasePath: () => join(scope, 'cc-haha', 'db', 'search-index-v1.sqlite'),
      createWatcher: () => noOpWatcher({
        start: async () => {
          watcherStarts += 1
          if (watcherStarts === 1) {
            throw Object.assign(new Error('watch start failed'), {
              code: 'SEARCH_CONTENT_TEST_START_FAILED',
            })
          }
        },
        stop: async () => {
          watcherStops += 1
        },
      }),
    })

    await coordinator.start()
    expect(coordinator.getStatus()).toMatchObject({
      state: 'degraded',
      lastErrorCode: 'SEARCH_CONTENT_TEST_START_FAILED',
    })
    expect(watcherStops).toBe(1)

    await coordinator.start()
    await waitForStatus(coordinator.getStatus, 'ready')
    expect(watcherStarts).toBe(2)
    expect(coordinator.search('needle')?.sessions).toHaveLength(1)
    await coordinator.stop()
  })

  test.each(['SQLITE_CORRUPT', 'SQLITE_NOTADB'])(
    'rebuilds the disposable database after a query-time %s failure',
    async (failureCode) => {
      const scope = await createTempScope()
      const source = join(scope, 'projects', '-repo', 'session.jsonl')
      const databasePath = join(scope, 'cc-haha', 'db', 'search-index-v1.sqlite')
      await mkdir(join(source, '..'), { recursive: true })
      await writeFile(source, userLine('query recovery needle'))
      let opens = 0
      let removals = 0
      let failNextQuery = true
      const coordinator = createSearchContentCoordinator({
        resolveScope: () => scope,
        resolveDatabasePath: () => databasePath,
        openDatabase: (path, activeScope) => {
          opens += 1
          return openSearchContentDatabase({ path, scope: activeScope })
        },
        createIndex: (database, activeScope) => {
          const actual = createSearchContentIndex(database, { scope: activeScope })
          return {
            ...actual,
            query(query, options) {
              if (failNextQuery) {
                failNextQuery = false
                throw Object.assign(new Error('query database corrupt'), {
                  code: failureCode,
                })
              }
              return actual.query(query, options)
            },
          }
        },
        removeDatabaseFamily: async path => {
          removals += 1
          await Promise.all(['', '-wal', '-shm'].map(suffix =>
            rm(`${path}${suffix}`, { force: true })))
        },
        createWatcher: () => noOpWatcher(),
      })
      await coordinator.start()
      await waitForStatus(coordinator.getStatus, 'ready')

      expect(coordinator.search('needle')).toBeNull()
      expect(coordinator.getStatus()).toMatchObject({
        state: 'degraded',
        lastErrorCode: 'SQLITE_CORRUPT',
      })
      await waitFor(() => opens === 2)
      await waitForStatus(coordinator.getStatus, 'ready')
      expect(removals).toBe(1)
      expect(coordinator.search('needle')?.sessions).toHaveLength(1)
      await coordinator.stop()
    },
  )

  test('does not delete the database for an unconfirmed query failure', async () => {
    const scope = await createTempScope()
    const source = join(scope, 'projects', '-repo', 'session.jsonl')
    const databasePath = join(scope, 'cc-haha', 'db', 'search-index-v1.sqlite')
    await mkdir(join(source, '..'), { recursive: true })
    await writeFile(source, userLine('non corrupt query needle'))
    let removals = 0
    const coordinator = createSearchContentCoordinator({
      resolveScope: () => scope,
      resolveDatabasePath: () => databasePath,
      createIndex: (database, activeScope) => {
        const actual = createSearchContentIndex(database, { scope: activeScope })
        return {
          ...actual,
          query() {
            throw Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' })
          },
        }
      },
      removeDatabaseFamily: async () => {
        removals += 1
      },
      createWatcher: () => noOpWatcher(),
    })
    await coordinator.start()
    await waitForStatus(coordinator.getStatus, 'ready')

    expect(coordinator.search('needle')).toBeNull()
    expect(coordinator.getStatus()).toMatchObject({
      state: 'degraded',
      lastErrorCode: 'SQLITE_BUSY',
    })
    await Bun.sleep(20)
    expect(removals).toBe(0)
    await coordinator.stop()
  })
})


describe('worker write-lock coordination', () => {
  test.each(['finish', 'shutdown'] as const)('coalesces dirty notifications outside the worker lock during %s', async mode => {
    const scope = await createTempScope()
    const source = join(scope, 'projects', '-repo', 'session.jsonl')
    await mkdir(join(source, '..'), { recursive: true })
    await writeFile(source, userLine('lock fixture'))
    const databasePath = join(scope, 'cc-haha', 'db', 'search-index-v1.sqlite')
    let watcherOptions: ReconciliationWatcherOptions | undefined
    let worker: Worker | undefined
    let locked!: () => void
    const lockHeld = new Promise<void>(resolve => { locked = resolve })
    let writes = 0
    let activeIndex: ReturnType<typeof createSearchContentIndex> | undefined
    const coordinator = createSearchContentCoordinator({
      resolveScope: () => scope,
      resolveDatabasePath: () => databasePath,
      createIndex: (database, owner) => {
        const index = createSearchContentIndex(database, { scope: owner })
        activeIndex = index
        return { ...index, setReadiness(value) { writes++; index.setReadiness(value) } }
      },
      createWatcher: options => { watcherOptions = options; return noOpWatcher() },
      createProjector: ({ signal }) => ({
        async projectSource() {
          worker = new Worker(`
            const { parentPort, workerData } = require('node:worker_threads');
            const { Database } = require('bun:sqlite');
            const database = new Database(workerData);
            database.exec('BEGIN IMMEDIATE');
            parentPort.postMessage('locked');
            parentPort.once('message', () => { database.exec('ROLLBACK'); database.close(); parentPort.close() });
          `, { eval: true, workerData: databasePath })
          const current = worker
          const abort = () => { void current.terminate() }
          signal.addEventListener('abort', abort, { once: true })
          current.once('message', locked)
          try { await new Promise<void>((resolve, reject) => { current.once('exit', () => resolve()); current.once('error', reject) }) }
          finally { signal.removeEventListener('abort', abort) }
          return { kind: 'indexed', action: 'full', state: 'ready', indexedBytes: 0, indexedLines: 0, documentCount: 0 }
        },
        deleteSource: () => ({ kind: 'deleted' }),
      }),
    })
    try {
      await coordinator.start()
      await lockHeld
      const before = writes
      const started = performance.now()
      for (let event = 0; event < 20; event++) watcherOptions!.onDirty!()
      expect(writes).toBe(before)
      expect(performance.now() - started).toBeLessThan(100)
      expect(coordinator.getStatus()).toMatchObject({ state: 'building', lastErrorCode: null })
      expect(coordinator.search('lock')).toBeNull()
      if (mode === 'shutdown') {
        await coordinator.stop()
        expect(writes).toBe(before)
      } else {
        worker!.postMessage('release')
        await waitFor(() => writes === before + 2) // old sweep status + one coalesced dirty persistence
        expect(activeIndex!.getReadiness()).toMatchObject({ state: 'building', generation: 21 })
        await watcherOptions!.onBatch({ paths: [], fullSweep: false })
        expect(coordinator.getStatus()).toMatchObject({ state: 'ready', lastErrorCode: null })
        expect(activeIndex!.getReadiness()?.state).toBe('ready')
      }
    } finally {
      await coordinator.stop()
    }
  })
})
