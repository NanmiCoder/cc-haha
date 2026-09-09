import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { SessionService } from '../services/sessionService.js'
import type {
  IndexedSessionRow,
  LocalIndexGateway,
  SessionFileMatch,
  SessionIndexPage,
} from '../services/localIndex/sessionIndex.js'
import type {
  LocalIndexMode,
  LocalIndexStatus,
  SessionListSummary,
} from '../services/localIndex/types.js'
import { sanitizePath } from '../../utils/sessionStoragePortable.js'

const SESSION_A = '11111111-1111-4111-8111-111111111111'
const SESSION_B = '22222222-2222-4222-8222-222222222222'

class FakeLocalIndexGateway implements LocalIndexGateway {
  mode: LocalIndexMode = 'off'
  ready = false
  status: LocalIndexStatus = {
    mode: 'off',
    state: 'off',
    discovered: 0,
    indexed: 0,
    degradedSources: 0,
    databaseBytes: 0,
    walBytes: 0,
    lastUpdatedAt: null,
    lastErrorCode: null,
  }
  page: SessionIndexPage = { sessions: [], total: 0 }
  matches: SessionFileMatch[] = []
  listError: Error | null = null
  degradeOnList = false
  buildOnList = false
  listCalls = 0
  findCalls = 0
  lastListOptions: { project?: string; limit?: number; offset?: number } | undefined

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async rebuild(): Promise<LocalIndexStatus> { return this.status }
  getMode(): LocalIndexMode { return this.mode }
  getPublicStatus(): LocalIndexStatus { return { ...this.status, mode: this.mode } }
  isSessionScopeReady(): boolean { return this.ready }
  listSessions(options?: { project?: string; limit?: number; offset?: number }): SessionIndexPage {
    this.listCalls += 1
    this.lastListOptions = options
    if (this.listError) throw this.listError
    if (this.degradeOnList) {
      this.status = { ...this.status, state: 'degraded', lastErrorCode: 'LOCAL_INDEX_READ_FAILED' }
    }
    if (this.buildOnList) {
      this.status = { ...this.status, state: 'building' }
    }
    return this.page
  }
  findSessionFiles(): SessionFileMatch[] {
    this.findCalls += 1
    return this.matches
  }

  setReady(mode: LocalIndexMode = 'on'): void {
    this.mode = mode
    this.ready = true
    this.status = {
      ...this.status,
      mode,
      state: 'ready',
      lastUpdatedAt: '2026-07-15T00:00:00.000Z',
    }
  }
}

describe('SessionService local-index routing parity', () => {
  let configDir: string
  let previousHome: string | undefined
  let previousConfigDir: string | undefined

  beforeEach(async () => {
    previousHome = process.env.HOME
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-index-session-parity-'))
    process.env.HOME = configDir
    process.env.CLAUDE_CONFIG_DIR = configDir
    await fs.mkdir(path.join(configDir, 'projects'), { recursive: true })
  })

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    await fs.rm(configDir, { recursive: true, force: true })
  })

  async function writeSession(
    projectDir: string,
    sessionId: string,
    title: string,
    modifiedAt: string,
  ): Promise<string> {
    const directory = path.join(configDir, 'projects', projectDir)
    await fs.mkdir(directory, { recursive: true })
    const filePath = path.join(directory, `${sessionId}.jsonl`)
    await fs.writeFile(filePath, `${JSON.stringify({
      type: 'custom-title',
      sessionId,
      customTitle: title,
      timestamp: modifiedAt,
    })}\n${JSON.stringify({
      type: 'user',
      uuid: `${sessionId}-user`,
      sessionId,
      cwd: configDir,
      timestamp: modifiedAt,
      message: { role: 'user', content: title },
    })}\n`)
    const time = new Date(modifiedAt)
    await fs.utimes(filePath, time, time)
    return filePath
  }

  function indexedRow(
    filePath: string,
    projectPath: string,
    id: string,
    title: string,
  ): IndexedSessionRow {
    return {
      transcriptPath: filePath,
      id,
      title,
      createdAt: '2026-07-15T00:00:00.000Z',
      modifiedAt: '2026-07-15T00:01:00.000Z',
      messageCount: 1,
      projectPath,
      workDir: configDir,
    }
  }

  it('does not reuse a file-cache result after mode and readiness switch to on', async () => {
    const projectDir = '-tmp-project'
    const filePath = await writeSession(
      projectDir,
      SESSION_A,
      'File title',
      '2026-07-15T00:00:00.000Z',
    )
    const gateway = new FakeLocalIndexGateway()
    const service = new SessionService(gateway)

    expect((await service.listSessions()).sessions[0]?.title).toBe('File title')
    expect(gateway.listCalls).toBe(0)

    gateway.setReady()
    gateway.page = {
      sessions: [indexedRow(filePath, projectDir, SESSION_A, 'Indexed title')],
      total: 1,
    }

    const indexed = await service.listSessions()
    expect(indexed.sessions[0]?.title).toBe('Indexed title')
    expect(gateway.listCalls).toBe(1)
  })

  it('falls back the entire page when indexed hydration cannot preserve row count', async () => {
    const projectDir = '-tmp-project'
    const fileA = await writeSession(
      projectDir,
      SESSION_A,
      'File A',
      '2026-07-15T00:02:00.000Z',
    )
    const fileB = await writeSession(
      projectDir,
      SESSION_B,
      'File B',
      '2026-07-15T00:01:00.000Z',
    )
    const gateway = new FakeLocalIndexGateway()
    gateway.setReady()
    const broken = indexedRow(fileB, projectDir, SESSION_B, 'Indexed B')
    Object.defineProperty(broken, 'workDir', {
      get() { throw new Error('hydrate failed') },
    })
    gateway.page = {
      sessions: [indexedRow(fileA, projectDir, SESSION_A, 'Indexed A'), broken],
      total: 2,
    }
    const service = new SessionService(gateway)

    const result = await service.listSessions()
    expect(gateway.listCalls).toBe(1)
    expect(result.total).toBe(2)
    expect(result.sessions.map((session) => session.title)).toEqual(['File A', 'File B'])
  })

  it('stats every indexed find match, drops stale paths, and sorts by actual mtime', async () => {
    const oldPath = await writeSession(
      '-tmp-old',
      SESSION_A,
      'Old',
      '2026-07-15T00:01:00.000Z',
    )
    const newPath = await writeSession(
      '-tmp-new',
      SESSION_A,
      'New',
      '2026-07-15T00:02:00.000Z',
    )
    const gateway = new FakeLocalIndexGateway()
    gateway.setReady()
    gateway.matches = [
      { filePath: oldPath, projectDir: '-tmp-old' },
      { filePath: path.join(configDir, 'projects', '-missing', `${SESSION_A}.jsonl`), projectDir: '-missing' },
      { filePath: newPath, projectDir: '-tmp-new' },
    ]
    const service = new SessionService(gateway)

    const matches = await (service as unknown as {
      findSessionFiles(id: string): Promise<SessionFileMatch[]>
    }).findSessionFiles(SESSION_A)

    expect(gateway.findCalls).toBe(1)
    expect(matches).toEqual([
      { filePath: newPath, projectDir: '-tmp-new' },
      { filePath: oldPath, projectDir: '-tmp-old' },
    ])
  })

  it('falls back after an indexed read failure and suppresses retries during cooldown', async () => {
    await writeSession(
      '-tmp-project',
      SESSION_A,
      'File fallback',
      '2026-07-15T00:00:00.000Z',
    )
    let now = 1_000
    const gateway = new FakeLocalIndexGateway()
    gateway.setReady()
    gateway.listError = new Error('SQLITE_BUSY')
    const service = new SessionService(gateway, {
      now: () => now,
      indexFailureCooldownMs: 500,
    })

    expect((await service.listSessions()).sessions[0]?.title).toBe('File fallback')
    expect((await service.listSessions()).sessions[0]?.title).toBe('File fallback')
    expect(gateway.listCalls).toBe(1)

    now += 501
    await service.listSessions()
    expect(gateway.listCalls).toBe(2)
  })

  it('keeps invalid direct pagination inputs on the legacy file path', async () => {
    const projectDir = '-tmp-project'
    const filePath = await writeSession(
      projectDir,
      SESSION_A,
      'File title',
      '2026-07-15T00:00:00.000Z',
    )
    const invalidOptions = [
      { limit: -1 },
      { limit: Number.NaN },
      { offset: Number.POSITIVE_INFINITY },
      { offset: 0.5 },
    ]

    for (const options of invalidOptions) {
      const gateway = new FakeLocalIndexGateway()
      gateway.setReady()
      gateway.page = {
        sessions: [indexedRow(filePath, projectDir, SESSION_A, 'Indexed title')],
        total: 1,
      }
      const service = new SessionService(gateway)

      await service.listSessions(options)
      expect(gateway.listCalls).toBe(0)
    }
  })

  it('hydrates dynamic fields after pagination and preserves indexed duplicates and order', async () => {
    const existingWorkDir = await fs.mkdtemp(path.join(configDir, 'existing-workdir-'))
    const missingWorkDir = path.join(configDir, 'missing-workdir')
    const secondPath = await writeSession(
      '-project-b',
      SESSION_A,
      'Second physical row',
      '2026-07-15T00:03:00.456Z',
    )
    const firstPath = await writeSession(
      '-project-a',
      SESSION_A,
      'First physical row',
      '2026-07-15T00:02:00.000Z',
    )
    const gateway = new FakeLocalIndexGateway()
    gateway.setReady()
    gateway.page = {
      sessions: [
        {
          ...indexedRow(secondPath, '-project-b', SESSION_A, 'Second physical row'),
          createdAt: '2026-07-15T00:00:00.123Z',
          modifiedAt: '2026-07-15T00:03:00.456Z',
          workDir: missingWorkDir,
          runtimeProviderId: null,
          repository: {
            requestedWorkDir: missingWorkDir,
            repoRoot: configDir,
            branch: 'main',
            worktree: false,
            baseRef: 'main',
          },
        },
        {
          ...indexedRow(firstPath, '-project-a', SESSION_A, 'First physical row'),
          workDir: existingWorkDir,
          worktreeSession: {
            originalCwd: configDir,
            worktreePath: existingWorkDir,
            worktreeName: 'feature',
            sessionId: SESSION_A,
          },
        },
      ],
      total: 9,
    }
    const service = new SessionService(gateway)
    const project = path.join(configDir, 'project filter')
    const canonicalConfigDir = await fs.realpath(configDir)

    const result = await service.listSessions({ project, limit: 2, offset: 3 })

    expect(gateway.lastListOptions).toEqual({
      project: sanitizePath(project),
      limit: 2,
      offset: 3,
    })
    expect(result.total).toBe(9)
    expect(result.sessions.map((session) => session.title)).toEqual([
      'Second physical row',
      'First physical row',
    ])
    expect(result.sessions[0]?.createdAt).toBe('2026-07-15T00:00:00.123Z')
    expect(result.sessions[0]?.modifiedAt).toBe('2026-07-15T00:03:00.456Z')
    expect(result.sessions[0]?.projectRoot).toBe(canonicalConfigDir)
    expect(result.sessions[0]?.workDirExists).toBe(false)
    expect(Object.hasOwn(result.sessions[0]!, 'runtimeProviderId')).toBe(true)
    expect(result.sessions[0]?.runtimeProviderId).toBeNull()
    expect(result.sessions[1]?.projectRoot).toBe(canonicalConfigDir)
    expect(result.sessions[1]?.workDirExists).toBe(true)
  })

  it('returns files in shadow mode and records only bounded hashes for mismatch', async () => {
    const projectDir = '-tmp-project'
    const filePath = await writeSession(
      projectDir,
      SESSION_A,
      'Private file title',
      '2026-07-15T00:00:00.000Z',
    )
    const gateway = new FakeLocalIndexGateway()
    gateway.setReady('shadow')
    gateway.page = {
      sessions: [indexedRow(filePath, projectDir, SESSION_A, 'Private indexed title')],
      total: 1,
    }
    const comparisons: unknown[] = []
    const service = new SessionService(gateway, {
      recordShadowComparison: comparison => comparisons.push(comparison),
      shadowComparisonMinIntervalMs: 0,
    })

    const result = await service.listSessions()

    expect(result.sessions[0]?.title).toBe('Private file title')
    expect(gateway.listCalls).toBe(1)
    expect(comparisons).toHaveLength(1)
    const serialized = JSON.stringify(comparisons[0])
    expect(serialized).not.toContain('Private file title')
    expect(serialized).not.toContain('Private indexed title')
    expect(serialized).not.toContain(configDir)
    expect((comparisons[0] as { matched: boolean }).matched).toBe(false)
    expect((comparisons[0] as { fieldHashes: unknown[] }).fieldHashes.length).toBeLessThanOrEqual(16)

    const fileSession = result.sessions[0]!
    const explicitNullRow: IndexedSessionRow = {
      transcriptPath: filePath,
      id: fileSession.id,
      title: fileSession.title,
      createdAt: fileSession.createdAt,
      modifiedAt: fileSession.modifiedAt,
      messageCount: fileSession.messageCount,
      projectPath: fileSession.projectPath,
      workDir: fileSession.workDir,
      runtimeProviderId: null,
      sessionApiFormat: fileSession.sessionApiFormat,
    }
    gateway.page = { sessions: [explicitNullRow], total: 1 }
    await service.listSessions()
    expect((comparisons[1] as { matched: boolean }).matched).toBe(false)
    expect((comparisons[1] as { fieldHashes: Array<{ field: string }> }).fieldHashes)
      .toContainEqual(expect.objectContaining({ field: 'session_0.runtimeProviderId' }))

    delete explicitNullRow.runtimeProviderId
    await service.listSessions()
    expect((comparisons[2] as { matched: boolean }).matched).toBe(true)
  })

  it('does not compare partial building pages in shadow mode', async () => {
    const projectDir = '-tmp-project'
    const filePath = await writeSession(
      projectDir,
      SESSION_A,
      'File title',
      '2026-07-15T00:00:00.000Z',
    )
    const gateway = new FakeLocalIndexGateway()
    gateway.mode = 'shadow'
    gateway.ready = true
    gateway.status = {
      ...gateway.status,
      mode: 'shadow',
      state: 'building',
      discovered: 2,
      indexed: 1,
    }
    gateway.page = {
      sessions: [indexedRow(filePath, projectDir, SESSION_A, 'Partial indexed title')],
      total: 1,
    }
    const comparisons: unknown[] = []
    const service = new SessionService(gateway, {
      recordShadowComparison: comparison => comparisons.push(comparison),
    })

    expect((await service.listSessions()).sessions[0]?.title).toBe('File title')
    expect(gateway.listCalls).toBe(0)
    expect(comparisons).toEqual([])

    gateway.status = { ...gateway.status, state: 'ready' }
    gateway.buildOnList = true
    await service.listSessions()
    expect(gateway.listCalls).toBe(1)
    expect(comparisons).toEqual([])
  })

  it('deduplicates and rate-limits shadow comparison records', async () => {
    const projectDir = '-tmp-project'
    const filePath = await writeSession(
      projectDir,
      SESSION_A,
      'File title',
      '2026-07-15T00:00:00.000Z',
    )
    let now = 1_000
    const gateway = new FakeLocalIndexGateway()
    gateway.setReady('shadow')
    gateway.page = {
      sessions: [indexedRow(filePath, projectDir, SESSION_A, 'First mismatch')],
      total: 1,
    }
    const comparisons: unknown[] = []
    const service = new SessionService(gateway, {
      now: () => now,
      recordShadowComparison: comparison => comparisons.push(comparison),
    })

    await service.listSessions()
    await service.listSessions()
    expect(comparisons).toHaveLength(1)

    gateway.page = {
      sessions: [indexedRow(filePath, projectDir, SESSION_A, 'Second mismatch')],
      total: 1,
    }
    await service.listSessions()
    expect(comparisons).toHaveLength(1)

    now += 30_001
    await service.listSessions()
    expect(comparisons).toHaveLength(2)
  })

  it('falls back for not-ready, empty building, degraded, and swallowed read failures', async () => {
    await writeSession(
      '-tmp-project',
      SESSION_A,
      'File fallback',
      '2026-07-15T00:00:00.000Z',
    )
    const gateway = new FakeLocalIndexGateway()
    gateway.mode = 'on'
    gateway.status = { ...gateway.status, mode: 'on', state: 'building' }
    const service = new SessionService(gateway)

    expect((await service.listSessions()).sessions[0]?.title).toBe('File fallback')
    expect(gateway.listCalls).toBe(0)

    gateway.ready = true
    expect((await service.listSessions()).sessions[0]?.title).toBe('File fallback')
    expect(gateway.listCalls).toBe(1)

    gateway.status = { ...gateway.status, state: 'ready' }
    gateway.degradeOnList = true
    expect((await service.listSessions()).sessions[0]?.title).toBe('File fallback')
    expect(gateway.listCalls).toBe(2)
  })

  it('keeps list and find on files after mutation until the status marker changes', async () => {
    const projectDir = '-tmp-project'
    const filePath = await writeSession(
      projectDir,
      SESSION_A,
      'Original file title',
      '2026-07-15T00:00:00.000Z',
    )
    let now = 1_000
    const gateway = new FakeLocalIndexGateway()
    gateway.setReady()
    gateway.page = {
      sessions: [indexedRow(filePath, projectDir, SESSION_A, 'Stale indexed title')],
      total: 1,
    }
    gateway.matches = [{ filePath, projectDir }]
    const service = new SessionService(gateway, { now: () => now })

    expect((await service.listSessions()).sessions[0]?.title).toBe('Stale indexed title')
    await service.renameSession(SESSION_A, 'Renamed in file')
    const findCallsAfterRename = gateway.findCalls

    now += 6_000
    expect((await service.listSessions()).sessions[0]?.title).toBe('Renamed in file')
    expect((await service.findSessionFile(SESSION_A))?.filePath).toBe(filePath)
    expect(gateway.listCalls).toBe(1)
    expect(gateway.findCalls).toBe(findCallsAfterRename)

    gateway.status = {
      ...gateway.status,
      state: 'building',
      discovered: 10,
      indexed: 2,
      lastUpdatedAt: '2026-07-15T00:03:00.000Z',
    }
    now += 6_000
    expect((await service.listSessions()).sessions[0]?.title).toBe('Renamed in file')
    expect(gateway.listCalls).toBe(1)

    gateway.status = {
      ...gateway.status,
      state: 'ready',
      lastUpdatedAt: '2026-07-15T00:05:00.000Z',
    }
    gateway.page = {
      sessions: [indexedRow(filePath, projectDir, SESSION_A, 'Reconciled indexed title')],
      total: 1,
    }
    expect((await service.listSessions()).sessions[0]?.title).toBe('Reconciled indexed title')

    await service.deleteSession(SESSION_A)
    now += 6_000
    expect(await service.listSessions()).toEqual({ sessions: [], total: 0 })
    expect(await service.findSessionFile(SESSION_A)).toBeNull()
  })

  it('keeps a newly created session visible after the file TTL expires while the index is stale', async () => {
    const projectDir = '-tmp-project'
    const filePath = await writeSession(
      projectDir,
      SESSION_A,
      'Existing indexed session',
      '2026-07-15T00:00:00.000Z',
    )
    let now = 1_000
    const gateway = new FakeLocalIndexGateway()
    gateway.setReady()
    gateway.page = {
      sessions: [indexedRow(filePath, projectDir, SESSION_A, 'Existing indexed session')],
      total: 1,
    }
    const service = new SessionService(gateway, { now: () => now })
    expect((await service.listSessions()).sessions.map(session => session.id)).toEqual([SESSION_A])

    const created = await service.createSession(configDir)
    now += 6_000
    const afterTtl = await service.listSessions({ limit: 50 })

    expect(afterTtl.sessions.map(session => session.id)).toContain(created.sessionId)
    expect(gateway.listCalls).toBe(1)
  })

  it('shares mutation invalidation across service instances using the same gateway', async () => {
    const projectDir = '-tmp-project'
    const filePath = await writeSession(
      projectDir,
      SESSION_A,
      'Original file title',
      '2026-07-15T00:00:00.000Z',
    )
    let now = 1_000
    const gateway = new FakeLocalIndexGateway()
    gateway.setReady()
    gateway.page = {
      sessions: [indexedRow(filePath, projectDir, SESSION_A, 'Stale indexed title')],
      total: 1,
    }
    gateway.matches = [{ filePath, projectDir }]
    const reader = new SessionService(gateway, { now: () => now })
    const writer = new SessionService(gateway, { now: () => now })

    expect((await reader.listSessions()).sessions[0]?.title).toBe('Stale indexed title')
    await writer.renameSession(SESSION_A, 'Renamed by writer')
    const indexedFindCallsAfterRename = gateway.findCalls

    expect((await reader.listSessions()).sessions[0]?.title).toBe('Renamed by writer')
    expect((await reader.findSessionFile(SESSION_A))?.filePath).toBe(filePath)
    expect(gateway.listCalls).toBe(1)
    expect(gateway.findCalls).toBe(indexedFindCallsAfterRename)

    const created = await writer.createSession(configDir)
    expect((await reader.listSessions()).sessions.map(session => session.id)).toContain(created.sessionId)

    await writer.deleteSession(SESSION_A)
    expect((await reader.listSessions()).sessions.map(session => session.id)).toEqual([created.sessionId])
    expect(await reader.findSessionFile(SESSION_A)).toBeNull()

    now += 6_000
    expect((await reader.listSessions()).sessions.map(session => session.id)).toEqual([created.sessionId])
    expect(gateway.listCalls).toBe(1)

    const createdFile = await writer.findSessionFile(created.sessionId)
    expect(createdFile).not.toBeNull()
    gateway.status = {
      ...gateway.status,
      state: 'ready',
      lastUpdatedAt: '2026-07-15T00:10:00.000Z',
    }
    gateway.page = {
      sessions: [indexedRow(
        createdFile!.filePath,
        createdFile!.projectDir,
        created.sessionId,
        'Reconciled indexed title',
      )],
      total: 1,
    }
    expect((await reader.listSessions()).sessions[0]?.title).toBe('Reconciled indexed title')
    expect(gateway.listCalls).toBe(2)
  })

  it('isolates shared mutation epochs between different gateways', async () => {
    const projectDir = '-tmp-project'
    const filePath = await writeSession(
      projectDir,
      SESSION_A,
      'Original file title',
      '2026-07-15T00:00:00.000Z',
    )
    const writerGateway = new FakeLocalIndexGateway()
    writerGateway.setReady()
    writerGateway.matches = [{ filePath, projectDir }]
    const isolatedGateway = new FakeLocalIndexGateway()
    isolatedGateway.setReady()
    isolatedGateway.page = {
      sessions: [indexedRow(filePath, projectDir, SESSION_A, 'Isolated indexed title')],
      total: 1,
    }
    const writer = new SessionService(writerGateway)
    const isolatedReader = new SessionService(isolatedGateway)

    await writer.renameSession(SESSION_A, 'Writer gateway mutation')
    const isolatedResult = await isolatedReader.listSessions()

    expect(isolatedResult.sessions[0]?.title).toBe('Isolated indexed title')
    expect(isolatedGateway.listCalls).toBe(1)
  })

  it('requires a second completed generation after a mutation observed during building', async () => {
    const projectDir = '-tmp-project'
    const filePath = await writeSession(
      projectDir,
      SESSION_A,
      'Original file title',
      '2026-07-15T00:00:00.000Z',
    )
    const gateway = new FakeLocalIndexGateway()
    gateway.setReady()
    gateway.page = {
      sessions: [indexedRow(filePath, projectDir, SESSION_A, 'Stale indexed title')],
      total: 1,
    }
    gateway.matches = [{ filePath, projectDir }]
    const reader = new SessionService(gateway)
    const writer = new SessionService(gateway)
    expect((await reader.listSessions()).sessions[0]?.title).toBe('Stale indexed title')

    gateway.status = {
      ...gateway.status,
      state: 'building',
      lastUpdatedAt: '2026-07-15T00:01:00.000Z',
    }
    await writer.renameSession(SESSION_A, 'Renamed while building')

    gateway.status = {
      ...gateway.status,
      state: 'ready',
      lastUpdatedAt: '2026-07-15T00:02:00.000Z',
    }
    expect((await reader.listSessions()).sessions[0]?.title).toBe('Renamed while building')
    expect(gateway.listCalls).toBe(1)

    gateway.status = {
      ...gateway.status,
      state: 'building',
      lastUpdatedAt: '2026-07-15T00:03:00.000Z',
    }
    expect((await reader.listSessions()).sessions[0]?.title).toBe('Renamed while building')

    gateway.status = {
      ...gateway.status,
      state: 'ready',
      lastUpdatedAt: '2026-07-15T00:04:00.000Z',
    }
    gateway.page = {
      sessions: [indexedRow(filePath, projectDir, SESSION_A, 'Second-generation indexed title')],
      total: 1,
    }
    expect((await reader.listSessions()).sessions[0]?.title).toBe('Second-generation indexed title')
    expect(gateway.listCalls).toBe(2)
  })

  it('does not cache an old file-list request across a mutation from another instance', async () => {
    const projectDir = '-tmp-project'
    const filePath = await writeSession(
      projectDir,
      SESSION_A,
      'Original file title',
      '2026-07-15T00:00:00.000Z',
    )
    const gateway = new FakeLocalIndexGateway()
    const reader = new SessionService(gateway)
    const writer = new SessionService(gateway)
    const readerInternals = reader as unknown as {
      getCachedSessionListSummary(
        targetPath: string,
        targetProject: string,
        stat: unknown,
      ): Promise<SessionListSummary>
    }
    const originalSummaryLoader = readerInternals.getCachedSessionListSummary.bind(reader)
    let signalStarted!: () => void
    const started = new Promise<void>(resolve => { signalStarted = resolve })
    let releaseSummary!: (summary: SessionListSummary) => void
    const delayedSummary = new Promise<SessionListSummary>(resolve => {
      releaseSummary = resolve
    })
    readerInternals.getCachedSessionListSummary = async () => {
      signalStarted()
      return delayedSummary
    }

    const oldRequest = reader.listSessions()
    await started
    await writer.renameSession(SESSION_A, 'Renamed during old request')
    releaseSummary({
      title: 'Old in-flight title',
      createdAt: '2026-07-15T00:00:00.000Z',
      modifiedAt: '2026-07-15T00:00:00.000Z',
      messageCount: 1,
      workDir: configDir,
    })
    expect((await oldRequest).sessions[0]?.title).toBe('Old in-flight title')

    readerInternals.getCachedSessionListSummary = originalSummaryLoader
    const fresh = await reader.listSessions()
    expect(fresh.sessions[0]?.title).toBe('Renamed during old request')
    expect((await fs.stat(filePath)).isFile()).toBe(true)
  })

  it('falls back when the shared mutation epoch changes during indexed hydration', async () => {
    const projectDir = '-tmp-project'
    const filePath = await writeSession(
      projectDir,
      SESSION_A,
      'Original file title',
      '2026-07-15T00:00:00.000Z',
    )
    const gateway = new FakeLocalIndexGateway()
    gateway.setReady()
    gateway.page = {
      sessions: [indexedRow(filePath, projectDir, SESSION_A, 'Stale indexed title')],
      total: 1,
    }
    gateway.matches = [{ filePath, projectDir }]
    const reader = new SessionService(gateway)
    const writer = new SessionService(gateway)
    const readerInternals = reader as unknown as {
      validateIndexedTranscriptPath(): Promise<Awaited<ReturnType<typeof fs.stat>>>
    }
    let signalStarted!: () => void
    const started = new Promise<void>(resolve => { signalStarted = resolve })
    let releaseHydration!: (stat: Awaited<ReturnType<typeof fs.stat>>) => void
    const delayedHydration = new Promise<Awaited<ReturnType<typeof fs.stat>>>(resolve => {
      releaseHydration = resolve
    })
    readerInternals.validateIndexedTranscriptPath = async () => {
      signalStarted()
      return delayedHydration
    }

    const oldIndexedRequest = reader.listSessions()
    await started
    await writer.renameSession(SESSION_A, 'Renamed during indexed hydration')
    releaseHydration(await fs.stat(filePath))

    expect((await oldIndexedRequest).sessions[0]?.title).toBe('Renamed during indexed hydration')
  })

  it('falls back when the shared mutation epoch changes during indexed find hydration', async () => {
    const oldProjectDir = '-tmp-old'
    const newProjectDir = '-tmp-new'
    const oldPath = await writeSession(
      oldProjectDir,
      SESSION_A,
      'Old indexed copy',
      '2026-07-15T00:00:00.000Z',
    )
    const newPath = await writeSession(
      newProjectDir,
      SESSION_A,
      'Filesystem fallback copy',
      '2026-07-15T00:01:00.000Z',
    )
    const oldStat = await fs.stat(oldPath)
    const gateway = new FakeLocalIndexGateway()
    gateway.setReady()
    gateway.matches = [{ filePath: oldPath, projectDir: oldProjectDir }]
    const reader = new SessionService(gateway)
    const writer = new SessionService(gateway)
    const readerInternals = reader as unknown as {
      validateIndexedTranscriptPath(): Promise<Awaited<ReturnType<typeof fs.stat>>>
    }
    let signalStarted!: () => void
    const started = new Promise<void>(resolve => { signalStarted = resolve })
    let releaseHydration!: (stat: Awaited<ReturnType<typeof fs.stat>>) => void
    const delayedHydration = new Promise<Awaited<ReturnType<typeof fs.stat>>>(resolve => {
      releaseHydration = resolve
    })
    readerInternals.validateIndexedTranscriptPath = async () => {
      signalStarted()
      return delayedHydration
    }

    const oldIndexedRequest = reader.findSessionFile(SESSION_A)
    await started
    await writer.deleteSession(SESSION_A)
    releaseHydration(oldStat)

    expect((await oldIndexedRequest)?.filePath).toBe(newPath)
    expect(await fs.stat(oldPath).then(() => true, () => false)).toBe(false)
  })

  it('uses the SQL tie-break order for equal modified timestamps in file and indexed modes', async () => {
    const projectDir = '-tmp-project'
    const tiedAt = '2026-07-15T00:00:00.000Z'
    const fileB = await writeSession(projectDir, SESSION_B, 'Session B', tiedAt)
    const fileA = await writeSession(projectDir, SESSION_A, 'Session A', tiedAt)

    const fileGateway = new FakeLocalIndexGateway()
    const fileService = new SessionService(fileGateway)
    const fileOrder = (await fileService.listSessions()).sessions.map(session => session.id)

    const indexedGateway = new FakeLocalIndexGateway()
    indexedGateway.setReady()
    indexedGateway.page = {
      sessions: [
        indexedRow(fileA, projectDir, SESSION_A, 'Session A'),
        indexedRow(fileB, projectDir, SESSION_B, 'Session B'),
      ],
      total: 2,
    }
    const indexedService = new SessionService(indexedGateway)
    const indexedOrder = (await indexedService.listSessions()).sessions.map(session => session.id)

    expect(fileOrder).toEqual([SESSION_A, SESSION_B])
    expect(indexedOrder).toEqual(fileOrder)

    const duplicateB = await writeSession('-tie-b', SESSION_A, 'Tie B', tiedAt)
    const duplicateA = await writeSession('-tie-a', SESSION_A, 'Tie A', tiedAt)
    const fileFind = await fileService.findSessionFile(SESSION_A)
    expect(fileFind?.filePath).toBe(duplicateA)

    indexedGateway.matches = [
      { filePath: duplicateA, projectDir: '-tie-a' },
      { filePath: duplicateB, projectDir: '-tie-b' },
      { filePath: fileA, projectDir },
    ]
    const indexedFind = await indexedService.findSessionFile(SESSION_A)
    expect(indexedFind?.filePath).toBe(duplicateA)
  })

  it('rejects indexed list and find paths outside the current projects scope', async () => {
    const projectDir = '-tmp-project'
    const filePath = await writeSession(
      projectDir,
      SESSION_A,
      'Canonical file title',
      '2026-07-15T00:00:00.000Z',
    )
    const outsidePath = path.join(configDir, `${SESSION_A}.jsonl`)
    await fs.copyFile(filePath, outsidePath)

    const listGateway = new FakeLocalIndexGateway()
    listGateway.setReady()
    listGateway.page = {
      sessions: [indexedRow(outsidePath, projectDir, SESSION_A, 'Ghost indexed title')],
      total: 1,
    }
    const listService = new SessionService(listGateway)
    expect((await listService.listSessions()).sessions[0]?.title).toBe('Canonical file title')

    const findGateway = new FakeLocalIndexGateway()
    findGateway.setReady()
    findGateway.matches = [{ filePath: outsidePath, projectDir }]
    const findService = new SessionService(findGateway)
    expect((await findService.findSessionFile(SESSION_A))?.filePath).toBe(filePath)
  })

  it('retains partial building rows across restart, avoids an empty page, then reaches file parity', async () => {
    const projectDir = '-tmp-project'
    const fileA = await writeSession(
      projectDir,
      SESSION_A,
      'File A',
      '2026-07-15T00:02:00.000Z',
    )
    const fileB = await writeSession(
      projectDir,
      SESSION_B,
      'File B',
      '2026-07-15T00:01:00.000Z',
    )
    const gateway = new FakeLocalIndexGateway()
    gateway.mode = 'on'
    gateway.ready = true
    gateway.status = {
      ...gateway.status,
      mode: 'on',
      state: 'building',
      discovered: 2,
      indexed: 1,
      lastUpdatedAt: '2026-07-15T00:00:00.000Z',
    }
    gateway.page = {
      sessions: [indexedRow(fileA, projectDir, SESSION_A, 'File A')],
      total: 1,
    }

    const restarted = new SessionService(gateway)
    expect((await restarted.listSessions()).sessions.map(session => session.title)).toEqual(['File A'])

    gateway.page = { sessions: [], total: 0 }
    expect((await restarted.listSessions()).sessions.map(session => session.title)).toEqual(['File A', 'File B'])

    gateway.status = {
      ...gateway.status,
      state: 'ready',
      indexed: 2,
      lastUpdatedAt: '2026-07-15T00:01:00.000Z',
    }
    gateway.page = {
      sessions: [
        indexedRow(fileA, projectDir, SESSION_A, 'File A'),
        indexedRow(fileB, projectDir, SESSION_B, 'File B'),
      ],
      total: 2,
    }
    expect((await restarted.listSessions()).sessions.map(session => session.title)).toEqual(['File A', 'File B'])
  })
})
