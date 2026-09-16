import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { handleSessionsApi } from '../api/sessions.js'
import { SessionService } from '../services/sessionService.js'
import type { IndexedSessionRow, LocalIndexGateway } from '../services/localIndex/sessionIndex.js'
import type { LocalIndexMode, LocalIndexStatus } from '../services/localIndex/types.js'
import { sanitizePath } from '../../utils/sessionStoragePortable.js'

let configDir: string
let projectRoot: string
let previousConfigDir: string | undefined
const idFor = (n: number) => `${String(n).padStart(8, '0')}-bbbb-cccc-dddd-eeeeeeeeeeee`

beforeEach(async () => {
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'project-history-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
  projectRoot = path.join(await fs.realpath(configDir), 'project')
  await fs.mkdir(projectRoot, { recursive: true })
})
afterEach(async () => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  await fs.rm(configDir, { recursive: true, force: true })
})

async function seed(n: number, options: { root?: string; workDir?: string; timestamp?: string } = {}): Promise<IndexedSessionRow> {
  const root = options.root ?? projectRoot
  const workDir = options.workDir ?? root
  const projectPath = sanitizePath(workDir)
  const transcriptPath = path.join(configDir, 'projects', projectPath, `${idFor(n)}.jsonl`)
  const timestamp = options.timestamp ?? new Date(Date.UTC(2020, 0, 1, 0, 0, 1000 - n)).toISOString()
  const worktreeSession = workDir !== root ? {
    originalCwd: root, worktreePath: workDir, worktreeName: 'old', sessionId: idFor(n),
  } : undefined
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true })
  await fs.writeFile(transcriptPath, [
    { type: 'session-meta', workDir, permissionMode: 'plan', runtimeProviderId: 'fixture', runtimeModelId: 'fixture-model' },
    ...(worktreeSession ? [{ type: 'worktree-state', worktreeSession }] : []),
    { type: 'user', timestamp, uuid: `message-${n}`, message: { role: 'user', content: `History ${n}` } },
  ].map(entry => JSON.stringify(entry)).join('\n') + '\n')
  return { transcriptPath, id: idFor(n), title: `History ${n}`, createdAt: timestamp, modifiedAt: timestamp, messageCount: 1, projectPath, workDir, worktreeSession, permissionMode: 'plan', runtimeProviderId: 'fixture', runtimeModelId: 'fixture-model' }
}

function gateway(rows: IndexedSessionRow[], mode: LocalIndexMode, state: LocalIndexStatus['state'] = 'ready'): LocalIndexGateway {
  const status = { mode, state, discovered: rows.length, indexed: rows.length, degradedSources: 0, databaseBytes: 0, walBytes: 0, lastUpdatedAt: '2026-01-01T00:00:00.000Z', lastErrorCode: null }
  return {
    getMode: () => mode, getPublicStatus: () => status, isSessionScopeReady: () => state === 'ready',
    start: async () => {}, stop: async () => {}, rebuild: async () => status,
    listSessions: (options) => ({ sessions: rows.slice(options?.offset ?? 0, (options?.offset ?? 0) + (options?.limit ?? 50)), total: rows.length }),
    findSessionFiles: (id) => rows.filter(row => row.id === id).map(row => ({ filePath: row.transcriptPath, projectDir: row.projectPath })),
  }
}

function request(params: Record<string, string>, method = 'GET') {
  const url = new URL(`http://127.0.0.1/api/sessions/project-history?${new URLSearchParams(params)}`)
  return handleSessionsApi(new Request(url, { method }), url, ['api', 'sessions', 'project-history'])
}

describe('logical project session history', () => {
  it.each(['off', 'on', 'shadow'] as const)('groups root, external and removed worktree transcripts in %s mode', async (mode) => {
    const rows = [
      await seed(0),
      await seed(1, { workDir: path.join(configDir, 'external-worktree') }),
      await seed(2, { workDir: path.join(projectRoot, '.claude', 'worktrees', 'removed') }),
      await seed(3, { root: path.join(configDir, 'another-project') }),
    ]
    const service = new SessionService(gateway(rows, mode))
    const fullDetail = spyOn(service, 'getSession')
    const internals = service as unknown as { readJsonlFile: (...args: unknown[]) => Promise<unknown>; hydrateIndexedSession: (...args: unknown[]) => Promise<unknown> }
    const fullRead = spyOn(internals, 'readJsonlFile')
    const hydrate = spyOn(internals, 'hydrateIndexedSession')
    try {
      const first = await service.listProjectHistory({ projectRoot, limit: 2 })
      expect(first.sessions.map(session => session.id)).toEqual([idFor(0), idFor(1)])
      expect(hydrate).toHaveBeenCalledTimes(2)
      const second = await service.listProjectHistory({ projectRoot, limit: 2, cursor: first.nextCursor! })
      expect(second.sessions.map(session => session.id)).toEqual([idFor(2)])
      expect(second.sessions[0]).toMatchObject({ projectRoot, workspaceState: 'worktree_removed', runtimeModelId: 'fixture-model' })
      expect(second.nextCursor).toBeNull()
      expect(fullDetail).not.toHaveBeenCalled()
      expect(fullRead).not.toHaveBeenCalled()
    } finally { fullDetail.mockRestore(); fullRead.mockRestore(); hydrate.mockRestore() }
  })

  it('keeps snapshot ordering across insertions and reordering while omitting deleted rows', async () => {
    const rows = await Promise.all([0, 1, 2, 3, 4].map(n => seed(n)))
    const service = new SessionService(gateway(rows, 'off'))
    const first = await service.listProjectHistory({ projectRoot, limit: 2 })
    await seed(9, { timestamp: '2026-01-01T00:00:00.000Z' })
    await fs.appendFile(rows[3]!.transcriptPath, `${JSON.stringify({ type: 'user', timestamp: '2026-02-01T00:00:00.000Z', message: { role: 'user', content: 'Updated' } })}\n`)
    await service.deleteSession(idFor(2))
    const second = await service.listProjectHistory({ projectRoot, limit: 2, cursor: first.nextCursor! })
    expect(second.sessions.map(session => session.id)).toEqual([idFor(3), idFor(4)])
    expect(second.nextCursor).toBeNull()
  })

  it('bounds work across a deleted snapshot tail and advances empty pages', async () => {
    const rows = await Promise.all(Array.from({ length: 8 }, (_, n) => seed(n)))
    const service = new SessionService(gateway(rows, 'on'))
    const first = await service.listProjectHistory({ projectRoot, limit: 1 })
    await Promise.all(rows.slice(1, 6).map(row => fs.unlink(row.transcriptPath)))
    const internals = service as unknown as { validateIndexedTranscriptPath: (...args: unknown[]) => Promise<unknown> }
    const validate = spyOn(internals, 'validateIndexedTranscriptPath')
    try {
      const second = await service.listProjectHistory({ projectRoot, limit: 2, cursor: first.nextCursor! })
      expect(second.sessions).toEqual([])
      expect(second.nextCursor).not.toBeNull()
      expect(validate).toHaveBeenCalledTimes(4)
      const third = await service.listProjectHistory({ projectRoot, limit: 2, cursor: second.nextCursor! })
      expect(third.sessions.map(session => session.id)).toEqual([idFor(6), idFor(7)])
      expect(third.nextCursor).toBeNull()
    } finally { validate.mockRestore() }
  })

  it.each(['building', 'degraded'] as const)('uses complete file metadata while the on index is %s', async (state) => {
    const rows = await Promise.all([0, 1, 2].map(n => seed(n)))
    const index = gateway(rows.slice(0, 1), 'on', state)
    const readIndex = spyOn(index, 'listSessions')
    try {
      const page = await new SessionService(index).listProjectHistory({ projectRoot })
      expect(page.sessions.map(session => session.id)).toEqual(rows.map(row => row.id))
      expect(readIndex).not.toHaveBeenCalled()
    } finally { readIndex.mockRestore() }
  })

  it('discards a catalog built across a metadata mutation from another service', async () => {
    const rows = [await seed(0)]
    const index = gateway(rows, 'off')
    const reader = new SessionService(index)
    const writer = new SessionService(index)
    const internals = reader as unknown as { resolveProjectRootFromSessionMetadata: (...args: unknown[]) => Promise<string> }
    let release!: () => void
    let started!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    const blocked = new Promise<void>(resolve => { release = resolve })
    const root = spyOn(internals, 'resolveProjectRootFromSessionMetadata').mockImplementationOnce(async () => {
      started()
      await blocked
      return projectRoot
    })
    try {
      const pending = reader.listProjectHistory({ projectRoot })
      await entered
      await writer.renameSession(idFor(0), 'New authoritative title')
      release()
      const page = await pending
      expect(page.sessions[0]?.title).toBe('New authoritative title')
    } finally { release(); root.mockRestore() }
  })

  it('coalesces concurrent catalog scans and does not fully scan ready indexed transcripts', async () => {
    const rows = await Promise.all([0, 1, 2].map(n => seed(n)))
    const index = gateway(rows, 'on')
    const service = new SessionService(index)
    const readIndex = spyOn(index, 'listSessions')
    const internals = service as unknown as { scanSessionListSummary: (...args: unknown[]) => Promise<unknown> }
    const scan = spyOn(internals, 'scanSessionListSummary')
    try {
      const [first, second] = await Promise.all([
        service.listProjectHistory({ projectRoot, limit: 1 }),
        service.listProjectHistory({ projectRoot, limit: 1 }),
      ])
      expect(first.sessions).toEqual(second.sessions)
      expect(readIndex).toHaveBeenCalledTimes(1)
      expect(scan).not.toHaveBeenCalled()
    } finally { readIndex.mockRestore(); scan.mockRestore() }
  })

  it('skips a known recent prefix using activity time and ascending id ties', async () => {
    const timestamp = '2020-01-01T00:00:00.000Z'
    const rows = await Promise.all([0, 1, 2, 3].map(n => seed(n, { timestamp })))
    await seed(1, { workDir: path.join(configDir, 'duplicate-old-worktree'), timestamp: '2019-01-01T00:00:00.000Z' })
    const service = new SessionService(gateway(rows, 'off'))
    const page = await service.listProjectHistory({ projectRoot, limit: 2, beforeModifiedAt: timestamp, beforeId: idFor(1) })
    expect(page.sessions.map(session => session.id)).toEqual([idFor(2), idFor(3)])
    expect(page.nextCursor).toBeNull()
  })

  it('rejects expired and cross-project cursors and returns an empty terminal page', async () => {
    let now = 0
    const rows = await Promise.all([0, 1].map(n => seed(n)))
    const service = new SessionService(gateway(rows, 'off'), { now: () => now })
    const first = await service.listProjectHistory({ projectRoot, limit: 1 })
    await expect(service.listProjectHistory({ projectRoot: '/other', cursor: first.nextCursor! })).rejects.toMatchObject({ statusCode: 400 })
    now = 300_001
    await expect(service.listProjectHistory({ projectRoot, cursor: first.nextCursor! })).rejects.toMatchObject({ statusCode: 409 })
    expect(await service.listProjectHistory({ projectRoot: '/empty' })).toEqual({ sessions: [], nextCursor: null })
  })

  it('evicts old snapshot cursors without truncating a newer project history', async () => {
    const rows = await Promise.all([0, 1].map(n => seed(n)))
    const service = new SessionService(gateway(rows, 'off'))
    const first = await service.listProjectHistory({ projectRoot, limit: 1 })
    let newest = first
    for (let count = 0; count < 16; count += 1) newest = await service.listProjectHistory({ projectRoot, limit: 1 })
    await expect(service.listProjectHistory({ projectRoot, cursor: first.nextCursor! })).rejects.toMatchObject({ statusCode: 409 })
    expect((await service.listProjectHistory({ projectRoot, cursor: newest.nextCursor! })).sessions.map(session => session.id)).toEqual([idFor(1)])
  })

  it('clamps API pages, validates inputs and shares distinct-root resolution work', async () => {
    await Promise.all(Array.from({ length: 102 }, (_, n) => seed(n)))
    const result = await request({ projectRoot, limit: '1000' })
    expect(result.status).toBe(200)
    expect((await result.json()).sessions).toHaveLength(100)
    for (const params of [
      {}, { projectRoot: '' }, { projectRoot, limit: '-1' }, { projectRoot, limit: '2junk' },
      { projectRoot, cursor: 'not-a-cursor' }, { projectRoot, beforeId: idFor(0) },
    ]) expect((await request(params)).status).toBe(400)
    expect((await request({ projectRoot }, 'POST')).status).toBe(405)
    const service = new SessionService()
    const internals = service as unknown as { resolveProjectRootFromSessionMetadata: (...args: unknown[]) => Promise<unknown> }
    const roots = spyOn(internals, 'resolveProjectRootFromSessionMetadata')
    try {
      await service.listProjectHistory({ projectRoot, limit: 1 })
      // One catalog root resolution, plus hydration of the single returned row.
      expect(roots).toHaveBeenCalledTimes(2)
      await service.listProjectHistory({ projectRoot, limit: 1 })
      expect(roots).toHaveBeenCalledTimes(3)
    } finally { roots.mockRestore() }
  })
})
