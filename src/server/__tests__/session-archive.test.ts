import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { handleSessionsApi } from '../api/sessions.js'
import { handleSettingsApi } from '../api/settings.js'
import { SessionService } from '../services/sessionService.js'
import { conversationService } from '../services/conversationService.js'
import { clearLegacySessionChatState, markSessionChatQueued } from '../ws/handler.js'
import * as socketHandler from '../ws/handler.js'
import { sessionService } from '../services/sessionService.js'
import type { IndexedSessionRow, LocalIndexGateway } from '../services/localIndex/sessionIndex.js'
import { activeBackgroundTaskIds, activeNonAgentTasks } from '../ws/agentTaskState.js'
import * as teamRuntime from '../services/teamPlanRuntime.js'
import { cleanupOldSessionFiles } from '../../utils/cleanup.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { sanitizePath } from '../../utils/sessionStoragePortable.js'

let configDir: string
let projectRoot: string
let previousConfigDir: string | undefined
const idFor = (n: number) => `${String(n).padStart(8, '0')}-aaaa-bbbb-cccc-dddddddddddd`

beforeEach(async () => {
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-archive-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
  projectRoot = path.join(await fs.realpath(configDir), 'project')
  await fs.mkdir(projectRoot)
})
afterEach(async () => {
  clearLegacySessionChatState(idFor(0))
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  await fs.rm(configDir, { recursive: true, force: true })
})

async function seed(n: number, root = projectRoot) {
  const filePath = path.join(configDir, 'projects', sanitizePath(root), `${idFor(n)}.jsonl`)
  const timestamp = new Date(Date.UTC(2020, 0, 1, 0, n)).toISOString()
  const entries = [
    { type: 'session-meta', workDir: root, future: { preserve: true } },
    { type: 'user', uuid: `user-${n}`, timestamp, message: { role: 'user', content: `Archive fixture ${n}` } },
    { type: 'assistant', uuid: `assistant-${n}`, timestamp, message: { role: 'assistant', content: [{ type: 'text', text: 'Preserved reply' }] } },
  ]
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n')
  return filePath
}

function request(resource = '', method = 'GET', body?: unknown) {
  const url = new URL(`http://127.0.0.1/api/sessions${resource}`)
  return handleSessionsApi(new Request(url, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  }), url, url.pathname.split('/').filter(Boolean))
}

describe('reversible session archive', () => {
  it('archives through the actual API, survives service reload, and restores unchanged transcripts', async () => {
    const file = await seed(0)
    await seed(1)
    const original = await fs.readFile(file, 'utf8')
    const archive = await request(`/${idFor(0)}/archive`, 'PATCH', { archived: true })
    expect(archive.status).toBe(200)
    expect(await archive.json()).toEqual({ success: true, archived: true })
    expect((await (await request()).json()).sessions.map((s: { id: string }) => s.id)).toEqual([idFor(1)])
    const reloaded = new SessionService()
    expect((await reloaded.listSessions()).sessions.map(s => s.id)).toEqual([idFor(1)])
    const archives = await (await request('?archived=true')).json()
    expect(archives).toMatchObject({ sessions: [{ id: idFor(0), archived: true }], total: 1 })
    const detail = await (await request(`/${idFor(0)}`)).json()
    expect(detail).toMatchObject({ id: idFor(0), archived: true })
    expect(detail.messages).toHaveLength(2)
    expect((await request(`/${idFor(0)}/archive`, 'PATCH', { archived: false })).status).toBe(200)
    expect((await reloaded.listSessions()).sessions.map(s => s.id)).toEqual([idFor(1), idFor(0)])
    expect((await (await request('?archived=true')).json()).total).toBe(0)
    expect(await fs.readFile(file, 'utf8')).toBe(original)
  })

  it('keeps an archived-only project discoverable and filters before pagination', async () => {
    await seed(0)
    await seed(1)
    const anotherRoot = path.join(configDir, 'another-project')
    await seed(2, anotherRoot)
    await request(`/${idFor(0)}/archive`, 'PATCH', { archived: true })
    await request(`/${idFor(1)}/archive`, 'PATCH', { archived: true })
    const sidebar = await (await request('?view=sidebar')).json()
    expect(sidebar.sessions.map((s: { id: string }) => s.id)).toEqual([idFor(2)])
    expect(sidebar.projects).toContainEqual({ projectRoot, total: 0, archivedTotal: 2 })
    expect(sidebar.archivedSessionIds.sort()).toEqual([idFor(0), idFor(1)])
    const first = await (await request(`/project-history?${new URLSearchParams({ projectRoot, archived: 'true', limit: '1' })}`)).json()
    expect(first.sessions.map((s: { id: string }) => s.id)).toEqual([idFor(1)])
    expect(first.nextCursor).toBeString()
    await request(`/${idFor(0)}/archive`, 'PATCH', { archived: false })
    const second = await (await request(`/project-history?${new URLSearchParams({ projectRoot, archived: 'true', cursor: first.nextCursor })}`)).json()
    expect(second.sessions).toEqual([])
    expect(second.nextCursor).toBeNull()
    expect((await request(`/project-history?${new URLSearchParams({ projectRoot, cursor: first.nextCursor })}`)).status).toBe(400)
    expect((await (await request(`?${new URLSearchParams({ archived: 'true', project: anotherRoot })}`)).json()).total).toBe(0)
    expect((await (await request('?limit=1')).json()).sessions.map((s: { id: string }) => s.id)).toEqual([idFor(2)])
    expect((await (await request('?limit=1&offset=1')).json()).sessions.map((s: { id: string }) => s.id)).toEqual([idFor(0)])
  })

  it('refuses active or waiting sessions without stopping them or writing archive state', async () => {
    await seed(0)
    const stop = spyOn(conversationService, 'stopSession')
    try {
      markSessionChatQueued(idFor(0))
      expect(await (await request(`/${idFor(0)}/archive`, 'PATCH', { archived: true })).json()).toMatchObject({ error: 'SESSION_ACTIVE' })
      clearLegacySessionChatState(idFor(0))
      const permission = spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([{ requestId: 'pending', toolName: 'Bash', input: {} }] as any)
      try {
        expect((await request(`/${idFor(0)}/archive`, 'PATCH', { archived: true })).status).toBe(409)
      } finally { permission.mockRestore() }
      expect(stop).not.toHaveBeenCalled()
      expect((await (await request()).json()).total).toBe(1)
      await expect(fs.access(path.join(configDir, 'cc-haha', 'session-archives.json'))).rejects.toThrow()
    } finally { stop.mockRestore() }
  })

  it('validates archive bodies, methods, filters and missing sessions', async () => {
    await seed(0)
    for (const body of [{}, { archived: 'true' }, null, []]) {
      expect((await request(`/${idFor(0)}/archive`, 'PATCH', body)).status).toBe(400)
    }
    expect((await request(`/${idFor(0)}/archive`, 'POST', { archived: true })).status).toBe(405)
    expect((await request(`/${idFor(9)}/archive`, 'PATCH', { archived: true })).status).toBe(404)
    expect((await request('?archived=maybe')).status).toBe(400)
  })

  it('checks activity after asynchronous preparation and leaves later activity independent of archive metadata', async () => {
    await seed(0)
    const find = sessionService.findSessionFile.bind(sessionService)
    const lookup = spyOn(sessionService, 'findSessionFile').mockImplementation(async id => {
      const found = await find(id)
      markSessionChatQueued(id)
      return found
    })
    try {
      expect((await request(`/${idFor(0)}/archive`, 'PATCH', { archived: true })).status).toBe(409)
    } finally { lookup.mockRestore(); clearLegacySessionChatState(idFor(0)) }
    expect((await request(`/${idFor(0)}/archive`, 'PATCH', { archived: true })).status).toBe(200)
    markSessionChatQueued(idFor(0))
    expect(socketHandler.getSessionChatActivityState(idFor(0))).toBe('running')
    // Later work can still start and be inspected; archiving only organizes lists.
    expect((await (await request(`/${idFor(0)}/summary`)).json()).archived).toBe(true)
    expect((await request(`/${idFor(0)}/archive`, 'PATCH', { archived: false })).status).toBe(200)
    expect(socketHandler.getSessionChatActivityState(idFor(0))).toBe('running')
  })

  it('refuses background work and idle team leaders until their work is finished', async () => {
    await seed(0)
    activeNonAgentTasks.set(idFor(0), new Map([['background', { taskId: 'background', toolUseId: 'tool', taskType: 'local_bash' }]]))
    activeBackgroundTaskIds.set(idFor(0), new Set(['background']))
    try {
      expect((await request(`/${idFor(0)}/archive`, 'PATCH', { archived: true })).status).toBe(409)
      expect(activeNonAgentTasks.get(idFor(0))?.has('background')).toBe(true)
    } finally { activeNonAgentTasks.delete(idFor(0)); activeBackgroundTaskIds.delete(idFor(0)) }
    const team = spyOn(teamRuntime, 'hasActiveTeamWorkForParent').mockReturnValue(true)
    try {
      expect((await request(`/${idFor(0)}/archive`, 'PATCH', { archived: true })).status).toBe(409)
    } finally { team.mockRestore() }
    expect((await request(`/${idFor(0)}/archive`, 'PATCH', { archived: true })).status).toBe(200)
  })

  it('preserves independent archives during concurrent writes from multiple service instances', async () => {
    await seed(0)
    await seed(1)
    await Promise.all([new SessionService().setSessionArchived(idFor(0), true), new SessionService().setSessionArchived(idFor(1), true)])
    expect((await (await request('?archived=true')).json()).total).toBe(2)
    await Promise.all([new SessionService().setSessionArchived(idFor(0), false), new SessionService().setSessionArchived(idFor(1), true)])
    expect((await (await request('?archived=true')).json()).sessions.map((s: { id: string }) => s.id)).toEqual([idFor(1)])
  })

  it('retries a list when another client archives during workspace hydration', async () => {
    await seed(0)
    await seed(1)
    const service = new SessionService()
    const internals = service as unknown as { resolveWorkspaceAvailability: (...args: unknown[]) => Promise<unknown> }
    const hydrate = internals.resolveWorkspaceAvailability.bind(internals)
    let changed = false
    const hydration = spyOn(internals, 'resolveWorkspaceAvailability').mockImplementation(async (...args) => {
      if (!changed) {
        changed = true
        await new SessionService().setSessionArchived(idFor(0), true)
      }
      return hydrate(...args)
    })
    try {
      expect(await service.listSessions()).toMatchObject({ total: 1, sessions: [{ id: idFor(1) }] })
    } finally { hydration.mockRestore() }
  })

  it.each(['on', 'shadow', 'degraded'] as const)('filters indexed metadata before pagination and only hydrates returned rows in %s mode', async mode => {
    const files = await Promise.all([0, 1, 2].map(n => seed(n)))
    const rows: IndexedSessionRow[] = files.map((file, n) => ({
      transcriptPath: file, id: idFor(n), title: `Archive fixture ${n}`, createdAt: new Date(Date.UTC(2020, 0, 1, 0, n)).toISOString(),
      modifiedAt: new Date(Date.UTC(2020, 0, 1, 0, n)).toISOString(), messageCount: 2, projectPath: sanitizePath(projectRoot), workDir: projectRoot,
    })).reverse()
    const status = { mode: mode === 'shadow' ? 'shadow' as const : 'on' as const, state: mode === 'degraded' ? 'degraded' as const : 'ready' as const, discovered: 3, indexed: 3, degradedSources: mode === 'degraded' ? 1 : 0, databaseBytes: 0, walBytes: 0, lastUpdatedAt: '2026-01-01T00:00:00.000Z', lastErrorCode: null }
    const gateway: LocalIndexGateway = {
      getMode: () => status.mode, getPublicStatus: () => status, isSessionScopeReady: () => mode !== 'degraded',
      start: async () => {}, stop: async () => {}, rebuild: async () => status,
      listSessions: options => ({ sessions: rows.slice(options?.offset ?? 0, (options?.offset ?? 0) + (options?.limit ?? 50)), total: 3 }),
      findSessionFiles: id => rows.filter(row => row.id === id).map(row => ({ filePath: row.transcriptPath, projectDir: row.projectPath })),
      getSession: id => rows.find(row => row.id === id) ?? null,
      getSourceScopedFailurePaths: () => [files[1]!],
    }
    await request(`/${idFor(2)}/archive`, 'PATCH', { archived: true })
    const service = new SessionService(gateway)
    const internals = service as unknown as { hydrateIndexedSession: (...args: unknown[]) => Promise<unknown> }
    const hydrate = spyOn(internals, 'hydrateIndexedSession')
    try {
      expect(await service.listSessions({ limit: 1, offset: 1 })).toMatchObject({ total: 2, sessions: [{ id: idFor(0) }] })
      expect(hydrate).toHaveBeenCalledTimes(1)
      expect(await service.listSessions({ archived: true, limit: 1 })).toMatchObject({ total: 1, sessions: [{ id: idFor(2), archived: true }] })
      expect(await service.listSessions({ archived: true, offset: 1 })).toMatchObject({ total: 1, sessions: [] })
    } finally { hydrate.mockRestore() }
  })

  it('preserves unsupported or corrupt archive files instead of overwriting them', async () => {
    await seed(0)
    const archivePath = path.join(configDir, 'cc-haha', 'session-archives.json')
    await fs.mkdir(path.dirname(archivePath))
    const unsupported = JSON.stringify({ schemaVersion: 2, sessions: { [idFor(0)]: { archived: true } }, future: 'keep' })
    for (const fixture of [unsupported, '{broken']) {
      await fs.writeFile(archivePath, fixture)
      await expect(new SessionService().setSessionArchived(idFor(0), false)).rejects.toThrow()
      expect(await fs.readFile(archivePath, 'utf8')).toBe(fixture)
    }
  })

  it('keeps archived history when the settings API previews and runs retention cleanup', async () => {
    const archivedFile = await seed(0)
    const ordinaryFile = await seed(1)
    const original = await fs.readFile(archivedFile, 'utf8')
    const old = new Date('2000-01-01T00:00:00.000Z')
    await fs.utimes(archivedFile, old, old)
    await fs.utimes(ordinaryFile, old, old)
    await request(`/${idFor(0)}/archive`, 'PATCH', { archived: true })
    for (const dryRun of [true, false]) {
      const url = new URL('http://127.0.0.1/api/settings/session-cleanup')
      const response = await handleSettingsApi(new Request(url, {
        method: 'POST', body: JSON.stringify({ days: 0, dryRun }), headers: { 'content-type': 'application/json' },
      }), url, ['api', 'settings', 'session-cleanup'])
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ ok: true, files: 1, errors: 0 })
      expect(await fs.readFile(archivedFile, 'utf8')).toBe(original)
    }
    await expect(fs.access(ordinaryFile)).rejects.toThrow()
    expect((await (await request('?archived=true')).json()).sessions.map((s: { id: string }) => s.id)).toEqual([idFor(0)])
  })

  it('serializes an already dispatched cleanup deletion with archive admission', async () => {
    const file = await seed(0)
    const old = new Date('2000-01-01T00:00:00.000Z')
    await fs.utimes(file, old, old)
    const fsImpl = getFsImplementation()
    const unlink = fsImpl.unlink.bind(fsImpl)
    let began!: () => void
    const beganDeleting = new Promise<void>(resolve => { began = resolve })
    let resume!: () => void
    const resumeDeleting = new Promise<void>(resolve => { resume = resolve })
    const deletion = spyOn(fsImpl, 'unlink').mockImplementation(async target => {
      if (target === file) { began(); await resumeDeleting }
      return unlink(target)
    })
    try {
      const cleanup = cleanupOldSessionFiles(new Date())
      await beganDeleting
      let settled = false
      const archive = request(`/${idFor(0)}/archive`, 'PATCH', { archived: true }).then(response => { settled = true; return response })
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(settled).toBe(false)
      resume()
      expect(await cleanup).toEqual({ messages: 1, errors: 0 })
      // Cleanup won the lock: the archive checks existence afterwards and must
      // not claim that it preserved a transcript which was already removed.
      expect((await archive).status).toBe(404)
      expect(sessionService.listArchivedSessionIds()).toEqual([])
    } finally { resume(); deletion.mockRestore() }
  })

  it('migrates unversioned archive metadata, preserving unknown fields and old transcript fixtures', async () => {
    const transcript = await seed(0)
    const original = await fs.readFile(transcript, 'utf8')
    const archivePath = path.join(configDir, 'cc-haha', 'session-archives.json')
    await fs.mkdir(path.dirname(archivePath))
    await fs.writeFile(archivePath, JSON.stringify({ future: { keep: true }, sessions: { [idFor(0)]: { archived: true, futureRecord: 'keep' } } }))
    expect((await (await request()).json()).total).toBe(0)
    expect((await request(`/${idFor(0)}/archive`, 'PATCH', { archived: false })).status).toBe(200)
    expect(JSON.parse(await fs.readFile(archivePath, 'utf8'))).toEqual({ schemaVersion: 1, future: { keep: true }, sessions: { [idFor(0)]: { archived: false, futureRecord: 'keep' } } })
    expect(await fs.readFile(transcript, 'utf8')).toBe(original)
  })
})
