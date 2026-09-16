import { afterEach, describe, expect, it } from 'bun:test'
import { getEventListeners } from 'node:events'
import { appendFile, chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { LocalIndexDatabase } from './database.js'
import {
  createLocalIndexCoordinator,
  discoverActivityTranscriptSources,
  discoverTranscriptSources,
  type LocalIndexCoordinator,
} from './coordinator.js'
import type {
  IndexedSessionRow,
  PersistedBackfillState,
  SessionIndex,
  SessionSourceRecord,
} from './sessionIndex.js'
import {
  createSessionProjector,
  type ProjectionProgress,
  type SessionProjector,
  type SessionSourceCandidate,
  SESSION_SUMMARY_PARSER_VERSION,
} from './sessionProjector.js'
import { LOCAL_INDEX_SCHEMA_VERSION } from './migrations.js'
import type {
  ReconciliationWatcher,
  ReconciliationWatcherOptions,
} from './reconciliationWatcher.js'
import { aggregateActivityStatsForMode } from '../../api/activityStats.js'

type EnvironmentName = 'HOME' | 'CLAUDE_CONFIG_DIR' | 'CC_HAHA_LOCAL_INDEX'

const tempDirs: string[] = []
const originalEnvironment: Partial<Record<EnvironmentName, string>> = {}

async function createTempDir(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `cc-haha-${label}-`))
  tempDirs.push(directory)
  return directory
}

function restoreEnvironment(name: EnvironmentName): void {
  const value = originalEnvironment[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

afterEach(async () => {
  for (const name of ['HOME', 'CLAUDE_CONFIG_DIR', 'CC_HAHA_LOCAL_INDEX'] as const) {
    restoreEnvironment(name)
  }
  await Promise.all(tempDirs.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true }),
  ))
})

function rememberEnvironment(): void {
  for (const name of ['HOME', 'CLAUDE_CONFIG_DIR', 'CC_HAHA_LOCAL_INDEX'] as const) {
    originalEnvironment[name] = process.env[name]
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function candidate(index: number, root = '/tmp/config'): SessionSourceCandidate {
  const projectPath = `-project-${index % 3}`
  return {
    path: join(root, 'projects', projectPath, `session-${index}.jsonl`),
    sessionId: `session-${index}`,
    projectPath,
    fallbackCreatedAt: '2026-01-01T00:00:00.000Z',
    fallbackModifiedAt: new Date(1_700_000_000_000 + index).toISOString(),
    fallbackWorkDir: `/project/${index % 3}`,
    modifiedAtMs: 1_700_000_000_000 + index,
  }
}

function sourceFromCandidate(item: SessionSourceCandidate): SessionSourceRecord {
  return {
    path: item.path,
    size: 1,
    mtimeMs: item.modifiedAtMs,
    fileIdentity: null,
    fingerprint: 'test-fingerprint',
    indexedBytes: 1,
    parserVersion: 1,
    state: 'ready',
    lastErrorCode: null,
    updatedAtMs: item.modifiedAtMs,
  }
}

function rowFromCandidate(item: SessionSourceCandidate): IndexedSessionRow {
  return {
    transcriptPath: item.path,
    id: item.sessionId,
    title: item.sessionId,
    createdAt: item.fallbackCreatedAt,
    modifiedAt: item.fallbackModifiedAt,
    messageCount: 1,
    projectPath: item.projectPath,
    workDir: item.fallbackWorkDir,
  }
}

function createFakeIndex(seed: SessionSourceCandidate[] = []): SessionIndex {
  const sources = new Map(seed.map(item => [item.path, sourceFromCandidate(item)]))
  const rows = new Map(seed.map(item => [item.path, rowFromCandidate(item)]))
  const backfill = new Map<string, PersistedBackfillState>()

  return {
    listSessions(options) {
      const all = [...rows.values()]
        .filter(row => options?.project === undefined || row.projectPath === options.project)
        .sort((left, right) => Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt))
      const offset = options?.offset ?? 0
      const limit = options?.limit ?? 50
      return { sessions: all.slice(offset, offset + limit), total: all.length }
    },
    findSessionFiles(sessionId) {
      return [...rows.values()]
        .filter(row => row.id === sessionId)
        .map(row => ({ filePath: row.transcriptPath, projectDir: row.projectPath }))
    },
    getSource(path) {
      return sources.get(path) ?? null
    },
    listSources() {
      return [...sources.values()]
    },
    countSources() {
      return sources.size
    },
    getProjectionSeed() {
      return null
    },
    getBackfillState(scope) {
      return backfill.get(scope) ?? null
    },
    // Test-only mutable seams used by the fake projector.
    _upsert(item: SessionSourceCandidate, progress: ProjectionProgress) {
      sources.set(item.path, sourceFromCandidate(item))
      rows.set(item.path, rowFromCandidate(item))
      backfill.set('/tmp/config', {
        scope: '/tmp/config',
        state: progress.state ?? 'building',
        watermark: item.path,
        discovered: progress.discovered,
        indexed: progress.indexed,
        degraded: progress.degraded ?? 0,
        lastErrorCode: progress.lastErrorCode ?? null,
        updatedAtMs: Date.now(),
      })
    },
    _delete(path: string) {
      sources.delete(path)
      rows.delete(path)
    },
  } as SessionIndex
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function fakeDatabase(onClose: () => void): LocalIndexDatabase {
  return {
    read: () => {
      throw new Error('fake database read should not be called')
    },
    write: () => {
      throw new Error('fake database write should not be called')
    },
    transaction: () => {
      throw new Error('fake database transaction should not be called')
    },
    close: onClose,
  }
}

describe('local index coordinator', () => {
  it('enters a busy cooldown after the first indexed read failure', async () => {
    let clock = 1_000
    let indexedReads = 0
    const index = createFakeIndex([candidate(1)])
    index.listSessions = () => {
      indexedReads += 1
      throw Object.assign(new Error('locked'), { code: 'SQLITE_BUSY' })
    }
    const coordinator = createLocalIndexCoordinator({
      resolveMode: () => ({ mode: 'on', warningCode: null }),
      resolveScope: () => '/tmp/config',
      resolveDatabasePath: () => '/tmp/config/cc-haha/db/index-v1.sqlite',
      openDatabase: () => fakeDatabase(() => {}),
      createIndex: () => index,
      discoverSources: async () => [],
      schedule: () => {},
      now: () => clock,
      busyCooldownMs: 5_000,
    })

    await coordinator.start()
    expect(coordinator.isSessionScopeReady()).toBe(false)
    expect(coordinator.listSessions()).toEqual({ sessions: [], total: 0 })
    expect(indexedReads).toBe(1)
    expect(coordinator.getPublicStatus()).toMatchObject({
      state: 'degraded',
      lastErrorCode: 'SQLITE_BUSY',
    })

    clock += 5_001
    expect(coordinator.listSessions()).toEqual({ sessions: [], total: 0 })
    expect(indexedReads).toBe(2)
    await coordinator.stop()
  })

  it('does not issue a second synchronous storage call after a busy checkpoint', async () => {
    let checkpoints = 0
    let storageReads = 0
    const database: LocalIndexDatabase = {
      ...fakeDatabase(() => {}),
      checkpointPassive() {
        checkpoints += 1
        return { busy: 1, logFrames: 1, checkpointedFrames: 0 }
      },
      getStorageStats() {
        storageReads += 1
        return { databaseBytes: 1, walBytes: 1 }
      },
    }
    const coordinator = createLocalIndexCoordinator({
      resolveMode: () => ({ mode: 'on', warningCode: null }),
      resolveScope: () => '/tmp/config',
      resolveDatabasePath: () => '/tmp/config/cc-haha/db/index-v1.sqlite',
      openDatabase: () => database,
      createIndex: () => createFakeIndex(),
      discoverSources: async () => [],
      schedule: () => {},
    })

    await coordinator.start()

    expect(checkpoints).toBe(1)
    expect(storageReads).toBe(0)
    expect(coordinator.getPublicStatus()).toMatchObject({
      state: 'degraded',
      lastErrorCode: 'SQLITE_BUSY',
    })
    await coordinator.stop()
  })

  it('stops serving an active index when runtime configuration switches off', async () => {
    let currentMode: 'on' | 'off' = 'on'
    let closes = 0
    const coordinator = createLocalIndexCoordinator({
      resolveMode: () => ({ mode: currentMode, warningCode: null }),
      resolveScope: () => '/tmp/config',
      resolveDatabasePath: () => '/tmp/config/cc-haha/db/index-v1.sqlite',
      openDatabase: () => fakeDatabase(() => { closes += 1 }),
      createIndex: () => createFakeIndex([candidate(1)]),
      discoverSources: async () => [],
      schedule: () => {},
    })
    await coordinator.start()
    expect(coordinator.listSessions().total).toBe(1)

    currentMode = 'off'

    expect(coordinator.getMode()).toBe('off')
    expect(coordinator.getPublicStatus()).toMatchObject({ mode: 'off', state: 'off' })
    expect(coordinator.listSessions()).toEqual({ sessions: [], total: 0 })
    await waitFor(() => closes === 1)
    await coordinator.stop()
  })

  it('stops serving scope A before reopening the runtime index for scope B', async () => {
    let activeScope = '/tmp/config-a'
    let activePath = '/tmp/config-a/cc-haha/db/index-v1.sqlite'
    let opens = 0
    let closes = 0
    const indexes = new Map([
      [activePath, createFakeIndex([candidate(1, activeScope)])],
      ['/tmp/config-b/cc-haha/db/index-v1.sqlite', createFakeIndex([
        candidate(2, '/tmp/config-b'),
      ])],
    ])
    let openingPath = activePath
    const coordinator = createLocalIndexCoordinator({
      resolveMode: () => ({ mode: 'on', warningCode: null }),
      resolveScope: () => activeScope,
      resolveDatabasePath: () => activePath,
      openDatabase: path => {
        opens += 1
        openingPath = path
        return fakeDatabase(() => { closes += 1 })
      },
      createIndex: () => indexes.get(openingPath)!,
      discoverSources: async () => [],
      schedule: () => {},
    })
    await coordinator.start()
    expect(coordinator.listSessions().sessions.map(row => row.id)).toEqual(['session-1'])

    activeScope = '/tmp/config-b'
    activePath = '/tmp/config-b/cc-haha/db/index-v1.sqlite'

    expect(coordinator.getPublicStatus().state).toBe('building')
    expect(coordinator.listSessions()).toEqual({ sessions: [], total: 0 })
    await waitFor(() => opens === 2)
    expect(coordinator.listSessions().sessions.map(row => row.id)).toEqual(['session-2'])
    expect(closes).toBe(1)
    await coordinator.stop()
  })

  it('converges external append, create, and delete events through the serial writer pump', async () => {
    const root = await createTempDir('coordinator-watch-convergence')
    const configDir = join(root, 'config')
    const databasePath = join(configDir, 'cc-haha', 'db', 'index-v1.sqlite')
    const first = await createRealTranscript(configDir, '-repo', 'first', 'First')
    let watcherOptions!: ReconciliationWatcherOptions
    let watcherStops = 0
    const watcher: ReconciliationWatcher = {
      async start() {},
      async stop() {
        watcherStops += 1
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
    const coordinator = createLocalIndexCoordinator({
      resolveMode: () => ({ mode: 'on', warningCode: null }),
      resolveScope: () => configDir,
      resolveDatabasePath: () => databasePath,
      createWatcher: options => {
        watcherOptions = options
        return watcher
      },
    })

    await coordinator.start()
    await waitFor(() => coordinator.getPublicStatus().state === 'ready')
    expect(coordinator.listSessions({ limit: 10 }).sessions[0]?.messageCount).toBe(1)
    expect(coordinator.getSessionEntryLocators?.(first.path, ['user']))
      .toMatchObject({
        source: { path: first.path, parserVersion: SESSION_SUMMARY_PARSER_VERSION },
        entries: [{ ordinal: 0, jsonlLine: 1, entryType: 'user' }],
      })

    await appendFile(first.path, `${JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'updated' }] },
      timestamp: '2026-01-01T00:00:01.000Z',
    })}\n`)
    await watcherOptions.onBatch({ paths: [first.path], fullSweep: false })
    expect(coordinator.listSessions({ limit: 10 }).sessions[0]?.messageCount).toBe(2)

    const second = await createRealTranscript(configDir, '-repo', 'second', 'Second')
    await watcherOptions.onBatch({ paths: [second.path], fullSweep: false })
    expect(coordinator.listSessions({ limit: 10 }).total).toBe(2)

    const outside = join(configDir, 'outside.jsonl')
    const linked = join(configDir, 'projects', '-repo', 'linked.jsonl')
    await writeFile(outside, await Bun.file(second.path).text())
    await symlink(outside, linked)
    await watcherOptions.onBatch({ paths: [linked], fullSweep: false })
    expect(coordinator.listSessions({ limit: 10 }).total).toBe(2)

    await rm(first.path)
    await watcherOptions.onBatch({ paths: [first.path], fullSweep: false })
    expect(coordinator.listSessions({ limit: 10 }).sessions.map(row => row.id)).toEqual(['second'])
    await coordinator.stop()
    expect(watcherStops).toBe(1)
  })

  it('keeps a failed exact path degraded across unrelated successful batches until that path converges', async () => {
    const root = await createTempDir('coordinator-persistent-target-failure')
    const configDir = join(root, 'config')
    const good = await createRealTranscript(configDir, '-repo', 'good', 'Good')
    const other = await createRealTranscript(configDir, '-repo', 'other', 'Other')
    const index = createFakeIndex()
    let watcherOptions!: ReconciliationWatcherOptions
    const projector: SessionProjector = {
      async projectSource(item, progress = { discovered: 0, indexed: 0 }) {
        if (item.sessionId === 'bad') {
          throw Object.assign(new Error('/private/index-v1.sqlite'), {
            code: 'SQLITE_FULL',
          })
        }
        ;(index as unknown as {
          _upsert(item: SessionSourceCandidate, progress: ProjectionProgress): void
        })._upsert(item, progress)
        return {
          kind: 'indexed',
          action: 'full',
          projection: {
            summary: {
              title: item.sessionId,
              createdAt: item.fallbackCreatedAt,
              modifiedAt: item.fallbackModifiedAt,
              messageCount: 1,
              workDir: item.fallbackWorkDir,
            },
            indexedBytes: 1,
            pendingTailBytes: 0,
            malformedLineCount: 0,
          },
          work: { maxBufferedChunks: 1, maxBufferedBytes: 1 },
        }
      },
      async deleteSource(path) {
        ;(index as unknown as { _delete(path: string): void })._delete(path)
        return { kind: 'deleted' }
      },
    }
    const coordinator = createLocalIndexCoordinator({
      resolveMode: () => ({ mode: 'on', warningCode: null }),
      resolveScope: () => configDir,
      resolveDatabasePath: () => join(configDir, 'cc-haha', 'db', 'index-v1.sqlite'),
      openDatabase: () => fakeDatabase(() => {}),
      createIndex: () => index,
      createProjector: () => projector,
      discoverSources: async () => [good, other],
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
    await waitFor(() => coordinator.getPublicStatus().state === 'ready')
    const bad = await createRealTranscript(configDir, '-repo', 'bad', 'Bad')
    await watcherOptions.onBatch({ paths: [bad.path], fullSweep: false })
    expect(coordinator.getPublicStatus()).toMatchObject({
      state: 'degraded',
      degradedSources: 1,
      lastErrorCode: 'DISK_WRITE_FAILED',
    })

    await appendFile(good.path, `${JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: 'unrelated success' },
      timestamp: '2026-01-01T00:00:01.000Z',
    })}\n`)
    await watcherOptions.onBatch({ paths: [good.path], fullSweep: false })

    expect(coordinator.getPublicStatus()).toMatchObject({
      state: 'degraded',
      degradedSources: 1,
      lastErrorCode: 'DISK_WRITE_FAILED',
    })
    expect(coordinator.listSessions({ limit: 10 }).total).toBe(2)
    rememberEnvironment()
    process.env.CLAUDE_CONFIG_DIR = configDir
    const { SessionService } = await import('../sessionService.js')
    expect((await new SessionService(coordinator).listSessions({ limit: 10 })).total).toBe(3)

    await rm(bad.path)
    await watcherOptions.onBatch({ paths: [bad.path], fullSweep: false })
    expect(coordinator.getPublicStatus()).toMatchObject({
      state: 'ready',
      degradedSources: 0,
      lastErrorCode: null,
    })
    await coordinator.stop()
  })

  it('withholds activity readiness while main-source or full-sweep failures can leave stale rows', async () => {
    const root = await createTempDir('coordinator-activity-stale-gate')
    const configDir = join(root, 'config')
    const databasePath = join(configDir, 'cc-haha', 'db', 'index-v1.sqlite')
    const source = await createRealTranscript(
      configDir,
      '-repo',
      'activity-stale',
      'Initial',
    )
    await writeFile(source.path, `${JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'Initial' },
      timestamp: '2026-07-15T00:00:00.000Z',
    })}\n`)
    rememberEnvironment()
    process.env.CLAUDE_CONFIG_DIR = configDir

    let watcherOptions!: ReconciliationWatcherOptions
    let failProjection = false
    let failDiscovery = false
    const coordinator = createLocalIndexCoordinator({
      resolveMode: () => ({ mode: 'on', warningCode: null }),
      resolveScope: () => configDir,
      resolveDatabasePath: () => databasePath,
      createProjector: options => {
        const delegate = createSessionProjector(options)
        return {
          ...delegate,
          async projectSource(item, progress) {
            if (failProjection) return { kind: 'retry', reason: 'transient-io' }
            return delegate.projectSource(item, progress)
          },
        }
      },
      discoverSources: (scope, signal, emit) => failDiscovery
        ? Promise.resolve({ complete: false })
        : discoverTranscriptSources(scope, signal, emit),
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
    const now = new Date('2026-07-15T12:00:00.000Z')

    try {
      await coordinator.start()
      await waitFor(() => coordinator.isActivityScopeReady())
      expect(coordinator.getActivityStats('7d', now)?.totalMessages).toBe(1)

      await appendFile(source.path, `${JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [] },
        timestamp: '2026-07-15T00:01:00.000Z',
      })}\n`)
      failProjection = true
      await watcherOptions.onBatch({ paths: [source.path], fullSweep: false })

      expect(coordinator.getPublicStatus()).toMatchObject({
        state: 'degraded',
        degradedSources: 1,
      })
      expect(coordinator.isActivityScopeReady()).toBe(false)
      expect(coordinator.getActivityStats('7d', now)).toBeNull()
      expect((await aggregateActivityStatsForMode('7d', now, coordinator)).totalMessages)
        .toBe(2)

      failProjection = false
      await watcherOptions.onBatch({ paths: [source.path], fullSweep: false })
      expect(coordinator.isActivityScopeReady()).toBe(true)
      expect(coordinator.getActivityStats('7d', now)?.totalMessages).toBe(2)

      failDiscovery = true
      await watcherOptions.onBatch({ paths: [], fullSweep: true })
      expect(coordinator.getPublicStatus()).toMatchObject({
        state: 'degraded',
        lastErrorCode: 'LOCAL_INDEX_DISCOVERY_INCOMPLETE',
      })
      expect(coordinator.isActivityScopeReady()).toBe(false)

      failDiscovery = false
      await watcherOptions.onBatch({ paths: [], fullSweep: true })
      expect(coordinator.isActivityScopeReady()).toBe(true)
    } finally {
      await coordinator.stop()
    }
  })

  it('withholds persisted activity totals while a parser upgrade is waiting to rebuild', async () => {
    const root = await createTempDir('coordinator-activity-parser-upgrade')
    const configDir = join(root, 'config')
    const databasePath = join(configDir, 'cc-haha', 'db', 'index-v1.sqlite')
    const source = await createRealTranscript(
      configDir,
      '-repo',
      'activity-upgrade',
      'Initial',
    )

    const createIdleWatcher = (): ReconciliationWatcher => ({
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
    })
    const previousVersion = SESSION_SUMMARY_PARSER_VERSION - 1
    const previousCoordinator = createLocalIndexCoordinator({
      resolveMode: () => ({ mode: 'on', warningCode: null }),
      resolveScope: () => configDir,
      resolveDatabasePath: () => databasePath,
      createProjector: options => createSessionProjector({
        ...options,
        parserVersion: previousVersion,
      }),
      createWatcher: createIdleWatcher,
    })

    await previousCoordinator.start()
    await waitFor(() => previousCoordinator.isActivityScopeReady())
    await previousCoordinator.stop()

    let runScheduledDiscovery: (() => void) | undefined
    const upgradedCoordinator = createLocalIndexCoordinator({
      resolveMode: () => ({ mode: 'on', warningCode: null }),
      resolveScope: () => configDir,
      resolveDatabasePath: () => databasePath,
      schedule: operation => { runScheduledDiscovery = operation },
      createWatcher: createIdleWatcher,
    })

    try {
      await upgradedCoordinator.start()

      expect(runScheduledDiscovery).toBeDefined()
      expect(upgradedCoordinator.isActivityScopeReady()).toBe(false)
      expect(upgradedCoordinator.getActivityStats('all')).toBeNull()

      runScheduledDiscovery?.()
      await waitFor(() => upgradedCoordinator.isActivityScopeReady())
      expect(upgradedCoordinator.getActivityStats('all')?.totalMessages).toBe(1)
      expect(upgradedCoordinator.getSessionEntryLocators?.(source.path)?.source.parserVersion)
        .toBe(SESSION_SUMMARY_PARSER_VERSION)
    } finally {
      await upgradedCoordinator.stop()
    }
  })

  it('keeps retained rows degraded after watch failure and ignores late batches after stop', async () => {
    const index = createFakeIndex([candidate(1)])
    let watcherOptions!: ReconciliationWatcherOptions
    let projectCalls = 0
    const watcher: ReconciliationWatcher = {
      async start() {},
      async stop() {},
      queueTranscriptPath() {},
      queueFullSweep() {},
      getMetrics: () => ({
        queuedPaths: 0,
        maxBatchSize: 0,
        yielded: 0,
        fullSweeps: 0,
        watchFailures: 1,
      }),
    }
    const coordinator = createLocalIndexCoordinator({
      resolveMode: () => ({ mode: 'on', warningCode: null }),
      resolveScope: () => '/tmp/config',
      resolveDatabasePath: () => '/tmp/config/index.sqlite',
      openDatabase: () => fakeDatabase(() => {}),
      createIndex: () => index,
      createProjector: () => ({
        async projectSource() {
          projectCalls += 1
          return { kind: 'retry', reason: 'transient-io' }
        },
        async deleteSource() {
          return { kind: 'deleted' }
        },
      }),
      discoverSources: async () => [candidate(1)],
      createWatcher: options => {
        watcherOptions = options
        return watcher
      },
    })

    await coordinator.start()
    await waitFor(() => coordinator.getPublicStatus().state !== 'building')
    watcherOptions.onWatchFailure?.('LOCAL_INDEX_WATCH_FAILED')
    expect(coordinator.getPublicStatus()).toMatchObject({
      state: 'degraded',
      lastErrorCode: 'LOCAL_INDEX_WATCH_FAILED',
    })
    expect(coordinator.listSessions().total).toBe(1)
    await coordinator.stop()
    await watcherOptions.onBatch({ paths: [candidate(2).path], fullSweep: false })
    expect(projectCalls).toBe(1)
  })

  it('sanitizes a simulated projection write failure and keeps file fallback available', async () => {
    const coordinator = createLocalIndexCoordinator({
      resolveMode: () => ({ mode: 'on', warningCode: null }),
      resolveScope: () => '/tmp/config',
      resolveDatabasePath: () => '/tmp/config/index.sqlite',
      openDatabase: () => fakeDatabase(() => {}),
      createIndex: () => createFakeIndex(),
      createProjector: () => ({
        async projectSource() {
          throw Object.assign(new Error('/private/write.sql'), { code: 'SQLITE_FULL' })
        },
        async deleteSource() {
          return { kind: 'deleted' }
        },
      }),
      discoverSources: async () => [candidate(1)],
      createWatcher: () => ({
        async start() {},
        async stop() {},
        queueTranscriptPath() {},
        queueFullSweep() {},
        getMetrics: () => ({ queuedPaths: 0, maxBatchSize: 0, yielded: 0, fullSweeps: 0, watchFailures: 0 }),
      }),
    })

    await coordinator.start()
    await waitFor(() => coordinator.getPublicStatus().state === 'degraded')
    expect(coordinator.getPublicStatus()).toMatchObject({
      lastErrorCode: 'DISK_WRITE_FAILED',
      indexed: 0,
      degradedSources: 1,
    })
    expect(JSON.stringify(coordinator.getPublicStatus())).not.toContain('/private')
    expect(coordinator.isSessionScopeReady()).toBe(false)
    await coordinator.stop()
  })

  it.each([
    ['SQLITE_CORRUPT', true, 'ready'],
    ['SQLITE_BUSY', false, 'degraded'],
    ['SQLITE_READONLY', false, 'degraded'],
    ['SQLITE_FULL', false, 'degraded'],
    ['LOCAL_INDEX_SCHEMA_UNSUPPORTED', false, 'degraded'],
  ] as const)(
    'backs up only confirmed %s startup failures',
    async (failureCode, shouldBackup, expectedState) => {
      let opens = 0
      let backups = 0
      const coordinator = createLocalIndexCoordinator({
        resolveMode: () => ({ mode: 'on', warningCode: null }),
        resolveScope: () => '/tmp/config',
        resolveDatabasePath: () => '/tmp/config/cc-haha/db/index-v1.sqlite',
        openDatabase: () => {
          opens += 1
          if (!shouldBackup || opens === 1) {
            throw Object.assign(new Error('/private/index.sqlite'), { code: failureCode })
          }
          return fakeDatabase(() => {})
        },
        backupDatabaseFamily: async () => {
          backups += 1
          return { backupPath: '/managed/backup', movedFiles: 3, removedBackups: 0 }
        },
        createIndex: () => createFakeIndex(),
        createProjector: () => ({
          async projectSource() {
            throw new Error('not reached')
          },
          async deleteSource() {
            return { kind: 'deleted' }
          },
        }),
        discoverSources: async () => [],
        createWatcher: () => ({
          async start() {},
          async stop() {},
          queueTranscriptPath() {},
          queueFullSweep() {},
          getMetrics: () => ({ queuedPaths: 0, maxBatchSize: 0, yielded: 0, fullSweeps: 0, watchFailures: 0 }),
        }),
      })

      await coordinator.start()
      if (expectedState === 'ready') {
        await waitFor(() => coordinator.getPublicStatus().state === 'ready')
        await coordinator.stop()
      }
      expect(backups).toBe(shouldBackup ? 1 : 0)
      expect(coordinator.getPublicStatus().state).toBe(expectedState)
      if (!shouldBackup) {
        expect(coordinator.getPublicStatus().lastErrorCode).toBe(
          failureCode === 'LOCAL_INDEX_SCHEMA_UNSUPPORTED'
            ? 'SCHEMA_UNSUPPORTED'
            : failureCode === 'SQLITE_BUSY'
              ? 'SQLITE_BUSY'
              : 'DISK_WRITE_FAILED',
        )
      }
    },
  )

  it('coalesces concurrent explicit rebuilds and applies the storage soft cap', async () => {
    const backupEntered = deferred<void>()
    const backupRelease = deferred<void>()
    let backups = 0
    let checkpoints = 0
    const database: LocalIndexDatabase = {
      ...fakeDatabase(() => {}),
      checkpointPassive: () => {
        checkpoints += 1
        return { busy: 0, logFrames: 0, checkpointedFrames: 0 }
      },
      getStorageStats: () => ({ databaseBytes: 90, walBytes: 20 }),
    }
    const coordinator = createLocalIndexCoordinator({
      resolveMode: () => ({ mode: 'on', warningCode: null }),
      resolveScope: () => '/tmp/config',
      resolveDatabasePath: () => '/tmp/config/cc-haha/db/index-v1.sqlite',
      openDatabase: () => database,
      createIndex: () => createFakeIndex(),
      createProjector: () => ({
        async projectSource() {
          throw new Error('not reached')
        },
        async deleteSource() {
          return { kind: 'deleted' }
        },
      }),
      discoverSources: async () => [],
      storageLimitBytes: 100,
      backupDatabaseFamily: async () => {
        backups += 1
        backupEntered.resolve()
        await backupRelease.promise
        return { backupPath: '/managed/backup', movedFiles: 1, removedBackups: 0 }
      },
      createWatcher: () => ({
        async start() {},
        async stop() {},
        queueTranscriptPath() {},
        queueFullSweep() {},
        getMetrics: () => ({ queuedPaths: 0, maxBatchSize: 0, yielded: 0, fullSweeps: 0, watchFailures: 0 }),
      }),
    })

    await coordinator.start()
    expect(coordinator.getPublicStatus()).toMatchObject({
      state: 'degraded',
      lastErrorCode: 'LOCAL_INDEX_SIZE_LIMIT',
      databaseBytes: 90,
      walBytes: 20,
    })
    const first = coordinator.rebuild()
    const second = coordinator.rebuild()
    await backupEntered.promise
    expect(backups).toBe(1)
    backupRelease.resolve()
    await Promise.all([first, second])
    expect(backups).toBe(1)
    expect(checkpoints).toBeGreaterThan(0)
    await coordinator.stop()
  })

  it('auto-recovers a corrupt header once and requires explicit rebuild for a future schema', async () => {
    const root = await createTempDir('coordinator-real-recovery')
    const configDir = join(root, 'config')
    const databasePath = join(configDir, 'cc-haha', 'db', 'index-v1.sqlite')
    const source = await createRealTranscript(configDir, '-repo', 'source', 'Canonical')
    const sourceBefore = await Bun.file(source.path).text()
    await mkdir(dirname(databasePath), { recursive: true })
    await writeFile(databasePath, 'not a sqlite database')
    const fakeWatcher = (): ReconciliationWatcher => ({
      async start() {},
      async stop() {},
      queueTranscriptPath() {},
      queueFullSweep() {},
      getMetrics: () => ({ queuedPaths: 0, maxBatchSize: 0, yielded: 0, fullSweeps: 0, watchFailures: 0 }),
    })
    const createCoordinator = () => createLocalIndexCoordinator({
      resolveMode: () => ({ mode: 'on', warningCode: null }),
      resolveScope: () => configDir,
      resolveDatabasePath: () => databasePath,
      createWatcher: fakeWatcher,
    })

    const recovered = createCoordinator()
    await recovered.start()
    await waitFor(() => recovered.getPublicStatus().state === 'ready')
    await recovered.stop()
    expect(await Bun.file(source.path).text()).toBe(sourceBefore)
    expect((await readdir(join(configDir, 'cc-haha', 'db', 'backups'))).length).toBe(1)

    const { Database } = await import('bun:sqlite')
    const future = new Database(databasePath)
    future.exec(`PRAGMA user_version = ${LOCAL_INDEX_SCHEMA_VERSION + 1}`)
    future.close(true)
    const unsupported = createCoordinator()
    await unsupported.start()
    expect(unsupported.getPublicStatus()).toMatchObject({
      state: 'degraded',
      lastErrorCode: 'SCHEMA_UNSUPPORTED',
    })
    expect((await readdir(join(configDir, 'cc-haha', 'db', 'backups'))).length).toBe(1)

    await unsupported.rebuild()
    await waitFor(() => unsupported.getPublicStatus().state === 'ready')
    expect((await readdir(join(configDir, 'cc-haha', 'db', 'backups'))).length).toBe(2)
    expect(await Bun.file(source.path).text()).toBe(sourceBefore)
    await unsupported.stop()
  })

  it('returns before discovery and processes recent sources with one bounded writer', async () => {
    const discovery = deferred<SessionSourceCandidate[]>()
    const index = createFakeIndex()
    const processed: string[] = []
    const statusSamples: number[] = []
    let activeWriters = 0
    let maxActiveWriters = 0
    let foregroundReads = 0
    let coordinator!: LocalIndexCoordinator
    const projector: SessionProjector = {
      async projectSource(item, progress = { discovered: 0, indexed: 0 }) {
        activeWriters += 1
        maxActiveWriters = Math.max(maxActiveWriters, activeWriters)
        statusSamples.push(coordinator.getPublicStatus().indexed)
        processed.push(item.path)
        ;(index as unknown as {
          _upsert(item: SessionSourceCandidate, progress: ProjectionProgress): void
        })._upsert(item, progress)
        await Promise.resolve()
        activeWriters -= 1
        return {
          kind: 'indexed',
          action: 'full',
          projection: {
            summary: {
              title: item.sessionId,
              createdAt: item.fallbackCreatedAt,
              modifiedAt: item.fallbackModifiedAt,
              messageCount: 1,
              workDir: item.fallbackWorkDir,
            },
            indexedBytes: 1,
            pendingTailBytes: 0,
            malformedLineCount: 0,
          },
          work: { maxBufferedChunks: 1, maxBufferedBytes: 1 },
        }
      },
      async deleteSource(path) {
        ;(index as unknown as { _delete(path: string): void })._delete(path)
        return { kind: 'deleted' }
      },
    }
    coordinator = createLocalIndexCoordinator({
      resolveMode: () => ({ mode: 'on', warningCode: null }),
      resolveScope: () => '/tmp/config',
      resolveDatabasePath: () => '/tmp/config/index.sqlite',
      openDatabase: () => fakeDatabase(() => {}),
      createIndex: () => index,
      createProjector: () => projector,
      discoverSources: () => discovery.promise,
      yieldToForeground: async () => {
        foregroundReads += 1
        coordinator.listSessions({ limit: 1 })
        await Promise.resolve()
      },
    })

    const start = coordinator.start()
    await expect(start).resolves.toBeUndefined()
    expect(coordinator.getPublicStatus().state).toBe('building')
    expect(processed).toEqual([])

    const corpus = Array.from({ length: 51 }, (_, index) => candidate(index))
    discovery.resolve(corpus)
    await waitFor(() => coordinator.getPublicStatus().state === 'ready')

    expect(processed).toEqual([...corpus]
      .sort((left, right) => right.modifiedAtMs - left.modifiedAtMs)
      .map(item => item.path))
    expect(maxActiveWriters).toBe(1)
    expect(coordinator.getSchedulingMetrics()).toEqual({
      maxBatchSize: 25,
      yieldCount: 2,
    })
    expect(foregroundReads).toBe(2)
    expect(statusSamples.every((value, index) =>
      index === 0 || value >= statusSamples[index - 1]!,
    )).toBe(true)
    expect(coordinator.getPublicStatus()).toMatchObject({
      state: 'ready',
      discovered: 51,
      indexed: 51,
    })
    await coordinator.stop()
  })

  it('removes abort listeners after every normal foreground yield', async () => {
    const index = createFakeIndex()
    const corpus = Array.from({ length: 301 }, (_, index) => candidate(index))
    let coordinatorSignal: AbortSignal | undefined
    const coordinator = createLocalIndexCoordinator({
      resolveMode: () => ({ mode: 'on', warningCode: null }),
      resolveScope: () => '/tmp/config',
      resolveDatabasePath: () => '/tmp/config/index.sqlite',
      openDatabase: () => fakeDatabase(() => {}),
      createIndex: () => index,
      createProjector: ({ signal }) => {
        coordinatorSignal = signal
        return {
          async projectSource(item, progress = { discovered: 0, indexed: 0 }) {
            ;(index as unknown as {
              _upsert(item: SessionSourceCandidate, progress: ProjectionProgress): void
            })._upsert(item, progress)
            return {
              kind: 'indexed',
              action: 'full',
              projection: {
                summary: {
                  title: item.sessionId,
                  createdAt: item.fallbackCreatedAt,
                  modifiedAt: item.fallbackModifiedAt,
                  messageCount: 1,
                  workDir: item.fallbackWorkDir,
                },
                indexedBytes: 1,
                pendingTailBytes: 0,
                malformedLineCount: 0,
              },
              work: { maxBufferedChunks: 1, maxBufferedBytes: 1 },
            }
          },
          async deleteSource() {
            return { kind: 'deleted' }
          },
        }
      },
      discoverSources: async () => corpus,
    })

    await coordinator.start()
    await waitFor(() => coordinator.getPublicStatus().state === 'ready')

    expect(coordinator.getSchedulingMetrics().yieldCount).toBe(12)
    expect(getEventListeners(coordinatorSignal!, 'abort')).toHaveLength(0)
    await coordinator.stop()
  })

  it('publishes recent bounded batches before discovery completes', async () => {
    const index = createFakeIndex()
    const discoveryGate = deferred<void>()
    const processed: string[] = []
    const projector: SessionProjector = {
      async projectSource(item, progress = { discovered: 0, indexed: 0 }) {
        processed.push(item.sessionId)
        ;(index as unknown as {
          _upsert(item: SessionSourceCandidate, progress: ProjectionProgress): void
        })._upsert(item, progress)
        return {
          kind: 'indexed',
          action: 'full',
          projection: {
            summary: {
              title: item.sessionId,
              createdAt: item.fallbackCreatedAt,
              modifiedAt: item.fallbackModifiedAt,
              messageCount: 1,
              workDir: item.fallbackWorkDir,
            },
            indexedBytes: 1,
            pendingTailBytes: 0,
            malformedLineCount: 0,
          },
          work: { maxBufferedChunks: 1, maxBufferedBytes: 1 },
        }
      },
      async deleteSource() {
        return { kind: 'deleted' }
      },
    }
    const coordinator = createLocalIndexCoordinator({
      resolveMode: () => ({ mode: 'on', warningCode: null }),
      resolveScope: () => '/tmp/config',
      resolveDatabasePath: () => '/tmp/config/index.sqlite',
      openDatabase: () => fakeDatabase(() => {}),
      createIndex: () => index,
      createProjector: () => projector,
      discoverSources: async (_scope, _signal, emit) => {
        await emit([candidate(1), candidate(9)])
        await discoveryGate.promise
        await emit([candidate(2)])
        return { complete: true }
      },
    })

    await coordinator.start()
    await waitFor(() => coordinator.listSessions({ limit: 10 }).total === 2)

    expect(processed).toEqual(['session-9', 'session-1'])
    expect(coordinator.getPublicStatus()).toMatchObject({
      state: 'building',
      discovered: 2,
      indexed: 2,
    })
    discoveryGate.resolve()
    await waitFor(() => coordinator.getPublicStatus().state === 'ready')
    expect(coordinator.listSessions({ limit: 10 }).total).toBe(3)
    await coordinator.stop()
  })

  it('retains committed rows across restart and resolves a changed config scope at start time', async () => {
    rememberEnvironment()
    const firstRoot = await createTempDir('coordinator-scope-a')
    const secondRoot = await createTempDir('coordinator-scope-b')
    process.env.HOME = join(firstRoot, 'home')
    process.env.CLAUDE_CONFIG_DIR = join(firstRoot, 'config')
    process.env.CC_HAHA_LOCAL_INDEX = 'on'
    const firstCandidate = await createRealTranscript(
      process.env.CLAUDE_CONFIG_DIR,
      '-repo-a',
      'first',
      'First scope',
    )
    const first = createLocalIndexCoordinator()
    await first.start()
    await waitFor(() => first.getPublicStatus().state === 'ready')
    expect(first.listSessions().sessions.map(row => row.id)).toEqual([firstCandidate.sessionId])
    await first.stop()

    const restarted = createLocalIndexCoordinator()
    await restarted.start()
    expect(restarted.listSessions().sessions.map(row => row.id)).toEqual(['first'])
    expect(restarted.getPublicStatus().state).toBe('building')
    await waitFor(() => restarted.getPublicStatus().state === 'ready')
    await restarted.stop()

    process.env.CLAUDE_CONFIG_DIR = join(secondRoot, 'config')
    await createRealTranscript(
      process.env.CLAUDE_CONFIG_DIR,
      '-repo-b',
      'second',
      'Second scope',
    )
    await restarted.start()
    expect(restarted.listSessions()).toEqual({ sessions: [], total: 0 })
    await waitFor(() => restarted.getPublicStatus().state === 'ready')
    expect(restarted.listSessions().sessions.map(row => row.id)).toEqual(['second'])
    await restarted.stop()
  })

  it('resumes a killed backfill from committed source progress', async () => {
    const root = await createTempDir('coordinator-resume')
    const configDir = join(root, 'config')
    const databasePath = join(configDir, 'cc-haha', 'db', 'index-v1.sqlite')
    const candidates: SessionSourceCandidate[] = []
    for (let index = 0; index < 30; index += 1) {
      candidates.push(await createRealTranscript(
        configDir,
        `-repo-${index % 2}`,
        `resume-${index}`,
        `Resume ${index}`,
      ))
    }
    const foregroundGate = deferred<void>()
    const first = createLocalIndexCoordinator({
      resolveMode: () => ({ mode: 'on', warningCode: null }),
      resolveScope: () => configDir,
      resolveDatabasePath: () => databasePath,
      discoverSources: async () => candidates,
      yieldToForeground: () => foregroundGate.promise,
    })

    await first.start()
    await waitFor(() =>
      first.getSchedulingMetrics().yieldCount === 1 &&
      first.listSessions({ limit: 100 }).total === 25,
    )
    await first.stop()
    foregroundGate.resolve()

    const restarted = createLocalIndexCoordinator({
      resolveMode: () => ({ mode: 'on', warningCode: null }),
      resolveScope: () => configDir,
      resolveDatabasePath: () => databasePath,
      discoverSources: async () => candidates,
    })
    await restarted.start()

    expect(restarted.listSessions({ limit: 100 }).total).toBe(25)
    expect(restarted.getPublicStatus()).toMatchObject({
      state: 'building',
      indexed: 25,
      discovered: 25,
    })
    await waitFor(() => restarted.getPublicStatus().state === 'ready')
    expect(restarted.listSessions({ limit: 100 }).total).toBe(30)
    await restarted.stop()
  })

  it('keeps old rows when discovery fails transiently and exposes a sanitized degraded state', async () => {
    const existing = candidate(1)
    const index = createFakeIndex([existing])
    let deleteCalls = 0
    const coordinator = createLocalIndexCoordinator({
      resolveMode: () => ({ mode: 'on', warningCode: null }),
      resolveScope: () => '/tmp/config',
      resolveDatabasePath: () => '/tmp/config/index.sqlite',
      openDatabase: () => fakeDatabase(() => {}),
      createIndex: () => index,
      createProjector: () => ({
        async projectSource() {
          throw new Error('not reached')
        },
        async deleteSource() {
          deleteCalls += 1
          return { kind: 'deleted' }
        },
      }),
      discoverSources: async () => {
        const error = new Error('/private/transcripts should not leak') as NodeJS.ErrnoException
        error.code = 'EACCES'
        throw error
      },
    })

    await coordinator.start()
    await waitFor(() => coordinator.getPublicStatus().state === 'degraded')

    expect(deleteCalls).toBe(0)
    expect(coordinator.listSessions().sessions.map(row => row.id)).toEqual([existing.sessionId])
    expect(coordinator.getPublicStatus()).toMatchObject({
      state: 'degraded',
      lastErrorCode: 'EACCES',
    })
    expect(JSON.stringify(coordinator.getPublicStatus())).not.toContain('/private/transcripts')
    await coordinator.stop()
  })

  it('never deletes unseen rows after an explicitly incomplete discovery', async () => {
    const existing = [candidate(1), candidate(2)]
    const index = createFakeIndex(existing)
    let deleteCalls = 0
    const coordinator = createLocalIndexCoordinator({
      resolveMode: () => ({ mode: 'on', warningCode: null }),
      resolveScope: () => '/tmp/config',
      resolveDatabasePath: () => '/tmp/config/index.sqlite',
      openDatabase: () => fakeDatabase(() => {}),
      createIndex: () => index,
      createProjector: () => ({
        async projectSource() {
          return {
            kind: 'indexed',
            action: 'unchanged',
            projection: {
              summary: {
                title: 'existing',
                createdAt: '2026-01-01T00:00:00.000Z',
                modifiedAt: '2026-01-01T00:00:00.000Z',
                messageCount: 1,
                workDir: null,
              },
              indexedBytes: 1,
              pendingTailBytes: 0,
              malformedLineCount: 0,
            },
            work: { maxBufferedChunks: 0, maxBufferedBytes: 0 },
          }
        },
        async deleteSource() {
          deleteCalls += 1
          return { kind: 'deleted' }
        },
      }),
      discoverSources: async (_scope, _signal, emit) => {
        await emit([existing[0]!])
        return { complete: false }
      },
    })

    await coordinator.start()
    await waitFor(() => coordinator.getPublicStatus().state === 'degraded')

    expect(deleteCalls).toBe(0)
    expect(coordinator.listSessions({ limit: 10 }).total).toBe(2)
    expect(coordinator.getPublicStatus().lastErrorCode).toBe(
      'LOCAL_INDEX_DISCOVERY_INCOMPLETE',
    )
    await coordinator.stop()
  })

  it('does not count a retry hole as successfully indexed work', async () => {
    const index = createFakeIndex()
    const corpus = [candidate(1), candidate(2), candidate(3)]
    const coordinator = createLocalIndexCoordinator({
      resolveMode: () => ({ mode: 'on', warningCode: null }),
      resolveScope: () => '/tmp/config',
      resolveDatabasePath: () => '/tmp/config/index.sqlite',
      openDatabase: () => fakeDatabase(() => {}),
      createIndex: () => index,
      createProjector: () => ({
        async projectSource(item, progress = { discovered: 0, indexed: 0 }) {
          if (item.sessionId === 'session-3') {
            return { kind: 'retry', reason: 'transient-io' }
          }
          ;(index as unknown as {
            _upsert(item: SessionSourceCandidate, progress: ProjectionProgress): void
          })._upsert(item, progress)
          return {
            kind: 'indexed',
            action: 'full',
            projection: {
              summary: {
                title: item.sessionId,
                createdAt: item.fallbackCreatedAt,
                modifiedAt: item.fallbackModifiedAt,
                messageCount: 1,
                workDir: item.fallbackWorkDir,
              },
              indexedBytes: 1,
              pendingTailBytes: 0,
              malformedLineCount: 0,
            },
            work: { maxBufferedChunks: 1, maxBufferedBytes: 1 },
          }
        },
        async deleteSource() {
          return { kind: 'deleted' }
        },
      }),
      discoverSources: async () => corpus,
    })

    await coordinator.start()
    await waitFor(() => coordinator.getPublicStatus().state === 'degraded')

    expect(coordinator.getPublicStatus()).toMatchObject({
      discovered: 3,
      indexed: 2,
      degradedSources: 1,
    })
    expect(coordinator.listSessions({ limit: 10 }).total).toBe(2)
    await coordinator.stop()
  })

  it('does no database or file work in off mode', async () => {
    let opens = 0
    let discoveries = 0
    let scopeResolutions = 0
    let pathResolutions = 0
    const coordinator = createLocalIndexCoordinator({
      resolveMode: () => ({ mode: 'off', warningCode: null }),
      resolveScope: () => {
        scopeResolutions += 1
        return '/must-not-resolve-home'
      },
      resolveDatabasePath: () => {
        pathResolutions += 1
        return '/must-not-open.sqlite'
      },
      openDatabase: () => {
        opens += 1
        return fakeDatabase(() => {})
      },
      discoverSources: async () => {
        discoveries += 1
        return []
      },
    })

    await coordinator.start()
    await coordinator.rebuild()

    expect(opens).toBe(0)
    expect(discoveries).toBe(0)
    expect(scopeResolutions).toBe(0)
    expect(pathResolutions).toBe(0)
    expect(coordinator.getPublicStatus()).toMatchObject({ mode: 'off', state: 'off' })
    expect(coordinator.isSessionScopeReady()).toBe(false)
    await coordinator.stop()
  })

  it('aborts pending discovery and closes the database exactly once on shutdown', async () => {
    const discovery = deferred<SessionSourceCandidate[]>()
    let closeCount = 0
    let observedAbort = false
    const coordinator = createLocalIndexCoordinator({
      resolveMode: () => ({ mode: 'on', warningCode: null }),
      resolveScope: () => '/tmp/config',
      resolveDatabasePath: () => '/tmp/config/index.sqlite',
      openDatabase: () => fakeDatabase(() => {
        closeCount += 1
      }),
      createIndex: () => createFakeIndex(),
      createProjector: () => ({
        async projectSource() {
          throw new Error('not reached')
        },
        async deleteSource() {
          throw new Error('not reached')
        },
      }),
      discoverSources: async (_scope, signal) => {
        signal.addEventListener('abort', () => {
          observedAbort = true
          discovery.resolve([])
        }, { once: true })
        return discovery.promise
      },
    })

    await coordinator.start()
    await Promise.resolve()
    await coordinator.stop()
    await coordinator.stop()

    expect(observedAbort).toBe(true)
    expect(closeCount).toBe(1)
  })

  it('cancels a pending corrupt-start backup before stop can return or a database can reopen', async () => {
    const backupEntered = deferred<void>()
    const backupRelease = deferred<void>()
    let opens = 0
    let scheduled = 0
    const coordinator = createLocalIndexCoordinator({
      resolveMode: () => ({ mode: 'on', warningCode: null }),
      resolveScope: () => '/tmp/config',
      resolveDatabasePath: () => '/tmp/config/cc-haha/db/index-v1.sqlite',
      openDatabase: () => {
        opens += 1
        if (opens === 1) {
          throw Object.assign(new Error('/private/corrupt.sqlite'), {
            code: 'SQLITE_CORRUPT',
          })
        }
        return fakeDatabase(() => {})
      },
      backupDatabaseFamily: async () => {
        backupEntered.resolve()
        await backupRelease.promise
        return { backupPath: '/managed/backup', movedFiles: 1, removedBackups: 0 }
      },
      createIndex: () => createFakeIndex(),
      createProjector: () => ({
        async projectSource() {
          throw new Error('not reached')
        },
        async deleteSource() {
          return { kind: 'deleted' }
        },
      }),
      createWatcher: () => ({
        async start() {},
        async stop() {},
        queueTranscriptPath() {},
        queueFullSweep() {},
        getMetrics: () => ({ queuedPaths: 0, maxBatchSize: 0, yielded: 0, fullSweeps: 0, watchFailures: 0 }),
      }),
      schedule: () => {
        scheduled += 1
      },
    })

    const starting = coordinator.start()
    await backupEntered.promise
    let stopSettled = false
    const stopping = coordinator.stop().then(() => {
      stopSettled = true
    })
    await Promise.resolve()
    expect(stopSettled).toBe(false)
    backupRelease.resolve()
    await Promise.all([starting, stopping])

    expect(opens).toBe(1)
    expect(scheduled).toBe(0)
    expect(coordinator.getPublicStatus().state).not.toBe('ready')
  })

  it('coalesces concurrent starts while corrupt recovery is pending', async () => {
    const backupEntered = deferred<void>()
    const backupRelease = deferred<void>()
    let opens = 0
    let backups = 0
    let closes = 0
    const coordinator = createLocalIndexCoordinator({
      resolveMode: () => ({ mode: 'on', warningCode: null }),
      resolveScope: () => '/tmp/config',
      resolveDatabasePath: () => '/tmp/config/cc-haha/db/index-v1.sqlite',
      openDatabase: () => {
        opens += 1
        if (opens === 1) {
          throw Object.assign(new Error('/private/corrupt.sqlite'), {
            code: 'SQLITE_CORRUPT',
          })
        }
        return fakeDatabase(() => {
          closes += 1
        })
      },
      backupDatabaseFamily: async () => {
        backups += 1
        backupEntered.resolve()
        await backupRelease.promise
        return { backupPath: '/managed/backup', movedFiles: 1, removedBackups: 0 }
      },
      createIndex: () => createFakeIndex(),
      createProjector: () => ({
        async projectSource() {
          throw new Error('not reached')
        },
        async deleteSource() {
          return { kind: 'deleted' }
        },
      }),
      discoverSources: async () => [],
      createWatcher: () => ({
        async start() {},
        async stop() {},
        queueTranscriptPath() {},
        queueFullSweep() {},
        getMetrics: () => ({ queuedPaths: 0, maxBatchSize: 0, yielded: 0, fullSweeps: 0, watchFailures: 0 }),
      }),
    })

    const first = coordinator.start()
    await backupEntered.promise
    const second = coordinator.start()
    await Promise.resolve()
    expect(opens).toBe(1)
    expect(backups).toBe(1)
    backupRelease.resolve()
    await Promise.all([first, second])
    await waitFor(() => coordinator.getPublicStatus().state === 'ready')

    expect(opens).toBe(2)
    expect(backups).toBe(1)
    await coordinator.stop()
    expect(closes).toBe(1)
  })

  it('serializes rebuild behind a pending corrupt start instead of opening concurrently', async () => {
    const backupEntered = deferred<void>()
    const backupRelease = deferred<void>()
    let opens = 0
    let manualBackups = 0
    const coordinator = createLocalIndexCoordinator({
      resolveMode: () => ({ mode: 'on', warningCode: null }),
      resolveScope: () => '/tmp/config',
      resolveDatabasePath: () => '/tmp/config/cc-haha/db/index-v1.sqlite',
      openDatabase: () => {
        opens += 1
        if (opens === 1) {
          throw Object.assign(new Error('/private/corrupt.sqlite'), {
            code: 'SQLITE_CORRUPT',
          })
        }
        return fakeDatabase(() => {})
      },
      backupDatabaseFamily: async ({ reason }) => {
        if (reason === 'SQLITE_CORRUPT') {
          backupEntered.resolve()
          await backupRelease.promise
        } else {
          manualBackups += 1
        }
        return { backupPath: '/managed/backup', movedFiles: 1, removedBackups: 0 }
      },
      createIndex: () => createFakeIndex(),
      createProjector: () => ({
        async projectSource() {
          throw new Error('not reached')
        },
        async deleteSource() {
          return { kind: 'deleted' }
        },
      }),
      discoverSources: async () => [],
      createWatcher: () => ({
        async start() {},
        async stop() {},
        queueTranscriptPath() {},
        queueFullSweep() {},
        getMetrics: () => ({ queuedPaths: 0, maxBatchSize: 0, yielded: 0, fullSweeps: 0, watchFailures: 0 }),
      }),
    })

    const starting = coordinator.start()
    await backupEntered.promise
    const rebuilding = coordinator.rebuild()
    await Promise.resolve()
    expect(opens).toBe(1)
    expect(manualBackups).toBe(0)
    backupRelease.resolve()
    await Promise.all([starting, rebuilding])
    await waitFor(() => coordinator.getPublicStatus().state === 'ready')

    expect(opens).toBe(2)
    expect(manualBackups).toBe(1)
    await coordinator.stop()
  })

  it('does not let a delete-phase generation commit or overwrite status after stop', async () => {
    const existing = candidate(1)
    const index = createFakeIndex([existing])
    const deleteEntered = deferred<void>()
    const deleteRelease = deferred<void>()
    let closeCount = 0
    let deleteCommits = 0
    let observedAbort = false
    const coordinator = createLocalIndexCoordinator({
      resolveMode: () => ({ mode: 'on', warningCode: null }),
      resolveScope: () => '/tmp/config',
      resolveDatabasePath: () => '/tmp/config/index.sqlite',
      openDatabase: () => fakeDatabase(() => {
        closeCount += 1
      }),
      createIndex: () => index,
      createProjector: ({ canCommit, signal }) => ({
        async projectSource() {
          throw new Error('not reached')
        },
        async deleteSource(path) {
          deleteEntered.resolve()
          signal.addEventListener('abort', () => {
            observedAbort = true
          }, { once: true })
          await deleteRelease.promise
          if (!canCommit()) return { kind: 'retry', reason: 'changed-during-read' }
          deleteCommits += 1
          ;(index as unknown as { _delete(path: string): void })._delete(path)
          return { kind: 'deleted' }
        },
      }),
      discoverSources: async () => [],
    })

    await coordinator.start()
    await deleteEntered.promise
    const stopping = coordinator.stop()
    await waitFor(() => observedAbort)
    const stoppedStatus = coordinator.getPublicStatus()
    deleteRelease.resolve()
    await stopping

    expect(deleteCommits).toBe(0)
    expect(index.getSource(existing.path)).not.toBeNull()
    expect(coordinator.getPublicStatus()).toEqual(stoppedStatus)
    expect(coordinator.getPublicStatus().state).not.toBe('ready')
    expect(closeCount).toBe(1)
  })

  it('stops an active generation before honoring a newly disabled rebuild', async () => {
    let currentMode: 'on' | 'off' = 'on'
    let closeCount = 0
    let discoveryCalls = 0
    let observedAbort = false
    const discoveryEntered = deferred<void>()
    const discovery = deferred<SessionSourceCandidate[]>()
    const coordinator = createLocalIndexCoordinator({
      resolveMode: () => ({ mode: currentMode, warningCode: null }),
      resolveScope: () => '/tmp/config',
      resolveDatabasePath: () => '/tmp/config/index.sqlite',
      openDatabase: () => fakeDatabase(() => {
        closeCount += 1
      }),
      createIndex: () => createFakeIndex(),
      createProjector: () => ({
        async projectSource() {
          throw new Error('not reached')
        },
        async deleteSource() {
          throw new Error('not reached')
        },
      }),
      discoverSources: async (_scope, signal) => {
        discoveryCalls += 1
        discoveryEntered.resolve()
        signal.addEventListener('abort', () => {
          observedAbort = true
          discovery.resolve([])
        }, { once: true })
        return discovery.promise
      },
    })

    try {
      await coordinator.start()
      await discoveryEntered.promise
      currentMode = 'off'
      await coordinator.rebuild()

      expect(observedAbort).toBe(true)
      expect(closeCount).toBe(1)
      expect(discoveryCalls).toBe(1)
      expect(coordinator.getPublicStatus()).toMatchObject({ mode: 'off', state: 'off' })
    } finally {
      discovery.resolve([])
      await coordinator.stop()
    }
  })

  it('resolves a fresh stopped-scope path and rebuilds only that derived database family', async () => {
    const root = await createTempDir('coordinator-rebuild-scope')
    const firstScope = join(root, 'scope-a')
    const secondScope = join(root, 'scope-b')
    const firstPath = join(firstScope, 'cc-haha', 'db', 'index-v1.sqlite')
    const secondPath = join(secondScope, 'cc-haha', 'db', 'index-v1.sqlite')
    let currentScope = firstScope
    let currentPath = firstPath
    const coordinator = createLocalIndexCoordinator({
      resolveMode: () => ({ mode: 'on', warningCode: null }),
      resolveScope: () => currentScope,
      resolveDatabasePath: () => currentPath,
      openDatabase: () => fakeDatabase(() => {}),
      createIndex: () => createFakeIndex(),
      createProjector: () => ({
        async projectSource() {
          throw new Error('not reached')
        },
        async deleteSource() {
          return { kind: 'deleted' }
        },
      }),
      discoverSources: async () => [],
    })

    try {
      await coordinator.start()
      await waitFor(() => coordinator.getPublicStatus().state === 'ready')
      await coordinator.stop()
      for (const path of [
        firstPath,
        `${firstPath}-wal`,
        `${firstPath}-shm`,
        secondPath,
        `${secondPath}-wal`,
        `${secondPath}-shm`,
      ]) {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, path.includes('scope-a') ? 'keep-a' : 'delete-b')
      }

      currentScope = secondScope
      currentPath = secondPath
      await coordinator.rebuild()

      expect(await Promise.all([
        pathExists(firstPath),
        pathExists(`${firstPath}-wal`),
        pathExists(`${firstPath}-shm`),
      ])).toEqual([true, true, true])
      expect(await Promise.all([
        pathExists(secondPath),
        pathExists(`${secondPath}-wal`),
        pathExists(`${secondPath}-shm`),
      ])).toEqual([false, false, false])
    } finally {
      await coordinator.stop()
    }
  })

  it.each(['openDatabase', 'createIndex'] as const)(
    'keeps the active mode when %s fails during startup',
    async (failureAt) => {
      let closeCount = 0
      const coordinator = createLocalIndexCoordinator({
        resolveMode: () => ({ mode: 'on', warningCode: null }),
        resolveScope: () => '/tmp/config',
        resolveDatabasePath: () => '/tmp/config/index.sqlite',
        openDatabase: () => {
          if (failureAt === 'openDatabase') {
            throw new Error('/private/index.sqlite must not leak')
          }
          return fakeDatabase(() => {
            closeCount += 1
          })
        },
        createIndex: () => {
          throw new Error('/private/schema.sql must not leak')
        },
      })

      await coordinator.start()

      expect(coordinator.getMode()).toBe('on')
      expect(coordinator.getPublicStatus()).toMatchObject({
        mode: 'on',
        state: 'degraded',
        lastErrorCode: 'LOCAL_INDEX_START_FAILED',
      })
      expect(JSON.stringify(coordinator.getPublicStatus())).not.toContain('/private')
      expect(closeCount).toBe(failureAt === 'createIndex' ? 1 : 0)
    },
  )

  it.skipIf(process.platform === 'win32')(
    'sanitizes an actual read-only database create failure as a disk write failure',
    async () => {
      const configDir = await createTempDir('readonly-create')
      const databaseDir = join(configDir, 'cc-haha', 'db')
      await mkdir(databaseDir, { recursive: true })
      await chmod(databaseDir, 0o500)
      const coordinator = createLocalIndexCoordinator({
        resolveMode: () => ({ mode: 'on', warningCode: null }),
        resolveScope: () => configDir,
        resolveDatabasePath: () => join(databaseDir, 'index-v1.sqlite'),
      })

      try {
        await coordinator.start()
        const publicStatus = coordinator.getPublicStatus()
        expect(publicStatus).toMatchObject({
          mode: 'on',
          state: 'degraded',
          lastErrorCode: 'DISK_WRITE_FAILED',
        })
        expect(JSON.stringify(publicStatus)).not.toContain(configDir)
      } finally {
        await chmod(databaseDir, 0o700)
        await coordinator.stop()
      }
    },
  )

  it('resets prior-scope counters before a new scope fails to open', async () => {
    const firstScope = '/tmp/config-a'
    const secondScope = '/tmp/config-b'
    const existing = candidate(1, firstScope)
    let currentScope = firstScope
    let failOpen = false
    let nowValue = Date.parse('2026-01-01T00:00:00.000Z')
    const coordinator = createLocalIndexCoordinator({
      resolveMode: () => ({ mode: 'on', warningCode: null }),
      resolveScope: () => currentScope,
      resolveDatabasePath: () => join(currentScope, 'index.sqlite'),
      openDatabase: () => {
        if (failOpen) throw new Error('/private/config-b/index.sqlite must not leak')
        return fakeDatabase(() => {})
      },
      createIndex: () => createFakeIndex([existing]),
      createProjector: () => ({
        async projectSource() {
          return {
            kind: 'indexed',
            action: 'unchanged',
            projection: {
              summary: {
                title: existing.sessionId,
                createdAt: existing.fallbackCreatedAt,
                modifiedAt: existing.fallbackModifiedAt,
                messageCount: 1,
                workDir: existing.fallbackWorkDir,
              },
              indexedBytes: 1,
              pendingTailBytes: 0,
              malformedLineCount: 0,
            },
            work: { maxBufferedChunks: 0, maxBufferedBytes: 0 },
          }
        },
        async deleteSource() {
          return { kind: 'deleted' }
        },
      }),
      discoverSources: async () => [existing],
      now: () => nowValue,
    })

    await coordinator.start()
    await waitFor(() => coordinator.getPublicStatus().state === 'ready')
    expect(coordinator.getPublicStatus()).toMatchObject({ discovered: 1, indexed: 1 })
    await coordinator.stop()

    currentScope = secondScope
    failOpen = true
    nowValue = Date.parse('2026-01-02T00:00:00.000Z')
    await coordinator.start()

    expect(coordinator.getPublicStatus()).toMatchObject({
      mode: 'on',
      state: 'degraded',
      discovered: 0,
      indexed: 0,
      lastUpdatedAt: '2026-01-02T00:00:00.000Z',
      lastErrorCode: 'LOCAL_INDEX_START_FAILED',
    })
  })

  it('degrades and returns false when a building readiness probe cannot read sessions', async () => {
    const discovery = deferred<SessionSourceCandidate[]>()
    const index = createFakeIndex()
    const coordinator = createLocalIndexCoordinator({
      resolveMode: () => ({ mode: 'on', warningCode: null }),
      resolveScope: () => '/tmp/config',
      resolveDatabasePath: () => '/tmp/config/index.sqlite',
      openDatabase: () => fakeDatabase(() => {}),
      createIndex: () => ({
        ...index,
        listSessions() {
          throw new Error('/private/index.sqlite must not leak')
        },
      }),
      createProjector: () => ({
        async projectSource() {
          throw new Error('not reached')
        },
        async deleteSource() {
          throw new Error('not reached')
        },
      }),
      discoverSources: async (_scope, signal) => {
        signal.addEventListener('abort', () => discovery.resolve([]), { once: true })
        return discovery.promise
      },
    })

    try {
      await coordinator.start()
      expect(() => coordinator.isSessionScopeReady()).not.toThrow()
      expect(coordinator.isSessionScopeReady()).toBe(false)
      expect(coordinator.getPublicStatus()).toMatchObject({
        mode: 'on',
        state: 'degraded',
        lastErrorCode: 'LOCAL_INDEX_READ_FAILED',
      })
    } finally {
      discovery.resolve([])
      await coordinator.stop()
    }
  })

  it('waits for an in-flight projector to observe abort before closing the database', async () => {
    const entered = deferred<void>()
    let closeCount = 0
    let oldGenerationWrites = 0
    const coordinator = createLocalIndexCoordinator({
      resolveMode: () => ({ mode: 'on', warningCode: null }),
      resolveScope: () => '/tmp/config',
      resolveDatabasePath: () => '/tmp/config/index.sqlite',
      openDatabase: () => fakeDatabase(() => {
        closeCount += 1
      }),
      createIndex: () => createFakeIndex(),
      createProjector: ({ signal }) => ({
        async projectSource() {
          entered.resolve()
          await new Promise<void>(resolve => {
            signal.addEventListener('abort', () => resolve(), { once: true })
          })
          if (!signal.aborted) oldGenerationWrites += 1
          return { kind: 'retry', reason: 'transient-io' }
        },
        async deleteSource() {
          return { kind: 'deleted' }
        },
      }),
      discoverSources: async () => [candidate(1)],
    })

    await coordinator.start()
    await entered.promise
    await coordinator.stop()

    expect(oldGenerationWrites).toBe(0)
    expect(closeCount).toBe(1)
  })

  it('waits for an in-flight stop to close the old database before restarting', async () => {
    const entered = deferred<void>()
    const release = deferred<void>()
    let observedAbort = false
    let openCount = 0
    let closeCount = 0
    const coordinator = createLocalIndexCoordinator({
      resolveMode: () => ({ mode: 'on', warningCode: null }),
      resolveScope: () => '/tmp/config',
      resolveDatabasePath: () => '/tmp/config/index.sqlite',
      openDatabase: () => {
        openCount += 1
        return fakeDatabase(() => {
          closeCount += 1
        })
      },
      createIndex: () => createFakeIndex(),
      createProjector: ({ signal }) => ({
        async projectSource() {
          entered.resolve()
          signal.addEventListener('abort', () => {
            observedAbort = true
          }, { once: true })
          await release.promise
          return { kind: 'retry', reason: 'transient-io' }
        },
        async deleteSource() {
          return { kind: 'deleted' }
        },
      }),
      discoverSources: async () => [candidate(1)],
    })

    await coordinator.start()
    await entered.promise
    const stopping = coordinator.stop()
    await waitFor(() => observedAbort)
    const restarting = coordinator.start()
    await Promise.resolve()

    expect(openCount).toBe(1)
    expect(closeCount).toBe(0)
    release.resolve()
    await Promise.all([stopping, restarting])
    expect(openCount).toBe(2)
    expect(closeCount).toBe(1)
    await coordinator.stop()
    expect(closeCount).toBe(2)
  })

  it('safely ignores a queued generation when stopped before its callback runs', async () => {
    const scheduled: Array<() => void> = []
    let closeCount = 0
    let discoveryCalls = 0
    const coordinator = createLocalIndexCoordinator({
      resolveMode: () => ({ mode: 'on', warningCode: null }),
      resolveScope: () => '/tmp/config',
      resolveDatabasePath: () => '/tmp/config/index.sqlite',
      openDatabase: () => fakeDatabase(() => {
        closeCount += 1
      }),
      createIndex: () => createFakeIndex(),
      createProjector: () => ({
        async projectSource() {
          throw new Error('not reached')
        },
        async deleteSource() {
          throw new Error('not reached')
        },
      }),
      discoverSources: async () => {
        discoveryCalls += 1
        return []
      },
      schedule: operation => scheduled.push(operation),
    })

    await coordinator.start()
    expect(scheduled).toHaveLength(1)
    await coordinator.stop()
    expect(() => scheduled[0]!()).not.toThrow()
    await Promise.resolve()

    expect(discoveryCalls).toBe(0)
    expect(closeCount).toBe(1)
  })

  it.each(['project-directory', 'transcript-stat'] as const)(
    'marks default discovery incomplete for a disappearing %s',
    async (raceAt) => {
      const missing = Object.assign(new Error('gone'), { code: 'ENOENT' })
      const projectEntry = {
        name: '-repo',
        isDirectory: () => true,
        isFile: () => false,
      }
      const fileEntry = {
        name: 'session.jsonl',
        isDirectory: () => false,
        isFile: () => true,
      }
      let reads = 0
      const emitted: SessionSourceCandidate[] = []

      const result = await discoverTranscriptSources(
        '/tmp/config',
        new AbortController().signal,
        async candidates => {
          emitted.push(...candidates)
        },
        {
          async readdirWithFileTypes() {
            reads += 1
            if (reads === 1) return [projectEntry]
            if (raceAt === 'project-directory') throw missing
            return [fileEntry]
          },
          async statPath() {
            throw missing
          },
        },
      )

      expect(result).toEqual({ complete: false })
      expect(emitted).toEqual([])
    },
  )
})

async function createRealTranscript(
  configDir: string,
  projectPath: string,
  sessionId: string,
  title: string,
): Promise<SessionSourceCandidate> {
  const path = join(configDir, 'projects', projectPath, `${sessionId}.jsonl`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: title },
    timestamp: '2026-01-01T00:00:00.000Z',
  })}\n`)
  const snapshot = await stat(path)
  return {
    path,
    sessionId,
    projectPath,
    fallbackCreatedAt: snapshot.birthtime.toISOString(),
    fallbackModifiedAt: snapshot.mtime.toISOString(),
    fallbackWorkDir: null,
    modifiedAtMs: snapshot.mtimeMs,
  }
}

describe('discoverActivityTranscriptSources', () => {
  async function seedSubagentTree(root: string): Promise<void> {
    const project = join(root, 'projects', '-repo')
    const session = join(project, 'session-a')
    await mkdir(join(session, 'subagents', 'workflows', 'wf_abc123'), { recursive: true })
    await mkdir(join(session, 'subagents', 'nested', 'deeper', 'too-deep'), { recursive: true })
    await writeFile(join(project, 'session-a.jsonl'), '')
    await writeFile(join(session, 'subagents', 'agent-plain.jsonl'), '')
    await writeFile(join(session, 'subagents', 'workflows', 'wf_abc123', 'agent-wf.jsonl'), '')
    await writeFile(join(session, 'subagents', 'nested', 'agent-nested.jsonl'), '')
    await writeFile(join(session, 'subagents', 'nested', 'deeper', 'too-deep', 'agent-x.jsonl'), '')
    // Neither of these is a subagent transcript and both must stay out of the index.
    await writeFile(join(session, 'subagents', 'notes.txt'), '')
    await writeFile(join(session, 'subagents', 'summary.jsonl'), '')
  }

  it('finds workflow agent transcripts nested under subagents/', async () => {
    const root = await createTempDir('activity-discovery')
    await seedSubagentTree(root)

    const result = await discoverActivityTranscriptSources(root, new AbortController().signal)

    const names = result.candidates.map(candidate => basename(candidate.path)).sort()
    // agent-wf.jsonl lives at subagents/workflows/<wf_id>/ — the level that used to be skipped
    // entirely, leaving every workflow agent's tokens and tool calls out of the stats.
    expect(names).toEqual([
      'agent-nested.jsonl',
      'agent-plain.jsonl',
      'agent-wf.jsonl',
      'session-a.jsonl',
    ])
    expect(result.complete).toBe(true)
  })

  it('attributes nested workflow agents to their owning session', async () => {
    const root = await createTempDir('activity-discovery-owner')
    await seedSubagentTree(root)

    const result = await discoverActivityTranscriptSources(root, new AbortController().signal)

    const workflowAgent = result.candidates.find(candidate =>
      candidate.path.endsWith('agent-wf.jsonl'))
    expect(workflowAgent).toMatchObject({
      sessionId: 'session-a',
      projectPath: '-repo',
      isSubagent: true,
    })
    expect(result.candidates.find(candidate => candidate.path.endsWith('session-a.jsonl')))
      .toMatchObject({ isSubagent: false })
  })

  it('stops walking below the bounded subagent depth', async () => {
    const root = await createTempDir('activity-discovery-depth')
    await seedSubagentTree(root)

    const result = await discoverActivityTranscriptSources(root, new AbortController().signal)

    // A deeper tree than workflows need is a sign of something unexpected; discovery must not turn
    // into a full filesystem walk.
    expect(result.candidates.some(candidate => candidate.path.endsWith('agent-x.jsonl')))
      .toBe(false)
  })
})
