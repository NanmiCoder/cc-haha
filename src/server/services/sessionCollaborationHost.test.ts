import { afterEach, beforeEach, expect, test, spyOn, mock } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { SessionCollaborationService, type CollaborationMessage } from './sessionCollaborationService.js'
import { handleSessionCollaborationEvent, configureSessionCollaborationHost, getSessionCollaborationService, hasSessionCollaborationPowerActivity } from './sessionCollaborationHost.js'
import { sessionService } from './sessionService.js'
import { admitSessionUserTurn, emitSessionTurnEvent } from './sessionTurnEvents.js'
import { SearchService } from './searchService.js'
import { ApiError } from '../middleware/errorHandler.js'
import { migrationMaintenance } from '../migrationMaintenance.js'

let directory: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'collaboration-host-fixture-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

async function saveReview(callerSessionId: string) {
  const runtime = { providerId: 'fixture-provider', modelId: 'fixture-model' }
  const seed = new SessionCollaborationService({
    statePath: join(directory, 'cc-haha', 'session-collaboration', 'state.json'),
    sessions: { exists: async () => true, list: async () => [], read: async () => [], create: async () => { throw new Error('Review must not create sessions') } },
    models: { list: async () => [], parentRuntime: async () => runtime, resolve: async () => runtime, validate: async value => value },
    runtime: { start: async () => { throw new Error('Recovery must not start work') }, enqueue: async () => {}, stop: async () => {} },
  })
  const proposal = await seed.propose(callerSessionId, { requestId: 'saved-review', sessions: [{ prompt: 'Wait for user approval' }] })
  await seed.onSessionState(callerSessionId, 'completed', 'Please confirm the allocation', 'saved-result')
  return proposal
}

test('collaboration startup stays read-only throughout migration validation', async () => {
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  const stateDirectory = join(directory, 'cc-haha', 'session-collaboration')
  await mkdir(stateDirectory, { recursive: true })
  const statePath = join(stateDirectory, 'state.json')
  const before = JSON.stringify({ version: 1, revision: 1, members: {
    root: { sessionId: 'root', rootSessionId: 'root', parentSessionId: null, state: 'running', stopped: false },
  }, messages: [] })
  await writeFile(statePath, before)
  const create = spyOn(sessionService, 'createSession').mockRejectedValue(new Error('Validation cannot create sessions'))
  const recovery = spyOn(SessionCollaborationService.prototype, 'recover')
  migrationMaintenance.beginValidation()
  const dispose = configureSessionCollaborationHost('127.0.0.1', 1234)
  try {
    const service = await getSessionCollaborationService()
    expect(await readFile(statePath, 'utf8')).toBe(before)
    expect(recovery).not.toHaveBeenCalled()
    expect((await service.status()).members[0]).toMatchObject({ state: 'running', stopped: false })
    expect(create).not.toHaveBeenCalled()
    migrationMaintenance.activateValidation()
    await getSessionCollaborationService()
    expect(recovery).toHaveBeenCalledTimes(1)
    expect((await service.status()).members[0]).toMatchObject({ state: 'stopped', stopped: true })
  } finally {
    dispose()
    migrationMaintenance.resetForTests()
    mock.restore()
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
  }
})

test.each(['single', 'batch'] as const)('successful %s deletion cancels the deleted caller’s unreachable review', async mode => {
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  const { sessionId } = await sessionService.createSession(directory)
  await saveReview(sessionId)
  const dispose = configureSessionCollaborationHost('127.0.0.1', 1234)
  try {
    const service = await getSessionCollaborationService()
    const { getPowerActivitySnapshot } = await import('./powerActivityRuntime.js')
    const { handleSessionsApi } = await import('../api/sessions.js')
    expect((await getPowerActivitySnapshot()).busy).toBe(true)
    const target = mode === 'single' ? sessionId : 'batch-delete'
    const url = new URL(`http://127.0.0.1/api/sessions/${target}`)
    const response = await handleSessionsApi(new Request(url, mode === 'single' ? { method: 'DELETE' } : {
      method: 'POST', body: JSON.stringify({ sessionIds: [sessionId] }),
    }), url, ['api', 'sessions', target])
    expect(response.status).toBe(200)
    for (let attempt = 0; attempt < 200 && (await getPowerActivitySnapshot()).busy; attempt++) await Bun.sleep(5)
    expect((await getPowerActivitySnapshot()).busy).toBe(false)
    expect((await service.listBatches(sessionId))[0]?.state).toBe('cancelled')
    expect(await sessionService.findSessionFile(sessionId)).toBeNull()
  } finally {
    dispose()
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
  }
})

test('archiving and restoring a caller preserves its pending allocation review and power ownership', async () => {
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  const { sessionId } = await sessionService.createSession(directory)
  const caller = (await sessionService.findSessionFile(sessionId))!
  const transcript = await readFile(caller.filePath, 'utf8')
  const catalog = await import('./sessionModelCatalog.js')
  const handler = await import('../ws/handler.js')
  const { handleSessionsApi } = await import('../api/sessions.js')
  const { handleSessionCollaborationApi, handleSessionCollaborationUiApi } = await import('../api/sessionCollaboration.js')
  const runtime = { providerId: 'fixture-provider', modelId: 'fixture-model' }
  spyOn(catalog, 'resolveSessionRuntime').mockResolvedValue(runtime)
  spyOn(catalog, 'listSessionModels').mockResolvedValue([])
  const create = spyOn(sessionService, 'createSession').mockRejectedValue(new Error('Review must not create sessions'))
  const start = spyOn(handler, 'submitSessionTurn').mockRejectedValue(new Error('Review must not start work'))
  let dispose = configureSessionCollaborationHost('127.0.0.1', 1234)
  try {
    let service = await getSessionCollaborationService()
    async function sessions(resource = '', method = 'GET', body?: unknown) {
      const url = new URL(`http://127.0.0.1/api/sessions${resource}`)
      const response = await handleSessionsApi(new Request(url, {
        method,
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      }), url, url.pathname.split('/').filter(Boolean))
      expect(response.status).toBe(200)
      return response.json()
    }
    async function delegation() {
      const url = new URL(`http://127.0.0.1/api/session-collaboration/${sessionId}/delegation`)
      const response = await handleSessionCollaborationUiApi(new Request(url), url, service)
      expect(response.status).toBe(200)
      return response.json()
    }
    const response = await handleSessionCollaborationApi(new Request('http://127.0.0.1/api/sessions/collaboration/create-batch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: 'archive-review', sessions: [{ prompt: 'Wait for user approval', runtime }] }),
    }), 'create-batch', sessionId, service)
    expect(response.status).toBe(200)
    const proposal = await response.json()
    expect(proposal).toMatchObject({ state: 'review', requiresReview: true })
    await service.onSessionState(sessionId, 'completed', 'Please confirm the allocation', 'archive-review-result')
    const before = (await delegation()).batches
    expect(before).toHaveLength(1)
    expect(before[0]).toMatchObject({ id: proposal.id, state: 'review', revision: proposal.revision })
    expect((await sessions()).sessions.map((session: { id: string }) => session.id)).toContain(sessionId)
    expect((await sessions('/power-activity')).busy).toBe(true)

    expect(await sessions(`/${sessionId}/archive`, 'PATCH', { archived: true })).toEqual({ success: true, archived: true })
    expect((await sessions()).sessions.map((session: { id: string }) => session.id)).not.toContain(sessionId)
    expect((await sessions('?archived=true')).sessions).toContainEqual(expect.objectContaining({ id: sessionId, archived: true }))
    expect(await sessionService.hasSessionStrict(sessionId)).toBe(true)
    expect((await delegation()).batches).toEqual(before)
    expect((await sessions('/power-activity')).busy).toBe(true)

    // Restart readiness must use the transcript, even though the caller is
    // absent from the default list used by the sidebar.
    dispose()
    dispose = configureSessionCollaborationHost('127.0.0.1', 1234)
    service = await getSessionCollaborationService()
    expect((await delegation()).batches).toEqual(before)
    expect((await sessions('/power-activity')).busy).toBe(true)

    expect(await sessions(`/${sessionId}/archive`, 'PATCH', { archived: false })).toEqual({ success: true, archived: false })
    expect((await sessions()).sessions.map((session: { id: string }) => session.id)).toContain(sessionId)
    expect((await sessions('?archived=true')).sessions).toHaveLength(0)
    expect((await delegation()).batches).toEqual(before)
    expect((await sessions('/power-activity')).busy).toBe(true)
    expect(await readFile(caller.filePath, 'utf8')).toBe(transcript)
    expect(create).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
  } finally {
    dispose()
    mock.restore()
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
  }
})

test('startup excludes a restored review with a missing caller without writing until normal recovery', async () => {
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  const { sessionId } = await sessionService.createSession(directory)
  await saveReview(sessionId)
  await sessionService.deleteSession(sessionId)
  const statePath = join(directory, 'cc-haha', 'session-collaboration', 'state.json')
  const before = await readFile(statePath, 'utf8')
  const dispose = configureSessionCollaborationHost('127.0.0.1', 1234)
  try {
    const { getPowerActivitySnapshot } = await import('./powerActivityRuntime.js')
    for (let attempt = 0; attempt < 200 && (await getPowerActivitySnapshot()).busy; attempt++) await Bun.sleep(5)
    expect((await getPowerActivitySnapshot()).busy).toBe(false)
    expect(await readFile(statePath, 'utf8')).toBe(before)
    const service = await getSessionCollaborationService()
    expect((await service.listBatches(sessionId))[0]?.state).toBe('cancelled')
  } finally {
    dispose()
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
  }
})

for (const target of ['projects', 'project'] as const) test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(`unreadable ${target} authority preserves the caller and pending review`, async () => {
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  const { sessionId } = await sessionService.createSession(directory)
  const caller = await sessionService.findSessionFile(sessionId)
  expect(caller).not.toBeNull()
  await saveReview(sessionId)
  const statePath = join(directory, 'cc-haha', 'session-collaboration', 'state.json')
  const before = await readFile(statePath, 'utf8')
  const inaccessible = target === 'projects' ? join(directory, 'projects') : dirname(caller!.filePath)
  const originalMode = (await stat(inaccessible)).mode & 0o7777
  const error = spyOn(console, 'error').mockImplementation(() => {})
  let dispose = () => {}
  try {
    await chmod(inaccessible, 0)
    await expect(readdir(inaccessible)).rejects.toMatchObject({ code: 'EACCES' })
    dispose = configureSessionCollaborationHost('127.0.0.1', 1234)
    await expect(getSessionCollaborationService()).rejects.toMatchObject({ code: 'EACCES' })
    const { getPowerActivitySnapshot } = await import('./powerActivityRuntime.js')
    expect((await getPowerActivitySnapshot()).busy).toBe(true)
    expect(await readFile(statePath, 'utf8')).toBe(before)
    expect(error).toHaveBeenCalled()

    await chmod(inaccessible, originalMode)
    expect(await readFile(caller!.filePath, 'utf8')).toContain('session-meta')
    dispose()
    dispose = configureSessionCollaborationHost('127.0.0.1', 1234)
    const recovered = await getSessionCollaborationService()
    expect((await recovered.listBatches(sessionId))[0]?.state).toBe('review')
    expect((await getPowerActivitySnapshot()).busy).toBe(true)
  } finally {
    await chmod(inaccessible, originalMode)
    dispose()
    mock.restore()
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
  }
})

test('host startup owns persisted review readiness before the first UI or session event', async () => {
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  const { sessionId } = await sessionService.createSession(directory)
  const proposal = await saveReview(sessionId)
  let release!: () => void
  let loaded = false
  const gate = new Promise<void>(resolve => { release = resolve })
  const originalLoad = SessionCollaborationService.prototype.loadForPowerActivity
  const loading = spyOn(SessionCollaborationService.prototype, 'loadForPowerActivity').mockImplementation(async function (this: SessionCollaborationService) {
    await gate
    await originalLoad.call(this)
    loaded = true
  })
  const recovery = spyOn(SessionCollaborationService.prototype, 'recover')
  const create = spyOn(sessionService, 'createSession').mockRejectedValue(new Error('Recovery must not create sessions'))
  const { getPowerActivitySnapshot } = await import('./powerActivityRuntime.js')
  const { powerActivityClock } = await import('./powerActivityClock.js')
  const before = powerActivityClock.read(false)
  let dispose = configureSessionCollaborationHost('127.0.0.1', 1234)
  try {
    expect(loading).toHaveBeenCalledTimes(1)
    expect(hasSessionCollaborationPowerActivity()).toBe(true)
    expect((await getPowerActivitySnapshot()).busy).toBe(true)
    expect(loading).toHaveBeenCalledTimes(1)
    expect(recovery).not.toHaveBeenCalled()
    release()
    for (let attempt = 0; attempt < 200 && !loaded; attempt++) await Bun.sleep(5)
    expect(loaded).toBe(true)
    expect((await getPowerActivitySnapshot()).busy).toBe(true)
    expect(recovery).not.toHaveBeenCalled()
    const service = await getSessionCollaborationService()
    expect((await service.listBatches(sessionId))[0]?.state).toBe('review')
    expect(create).not.toHaveBeenCalled()
    expect(powerActivityClock.read(false).completionSequence).toBe(before.completionSequence)

    await service.cancelBatch(sessionId, proposal.id, proposal.revision)
    expect((await getPowerActivitySnapshot()).busy).toBe(false)
    dispose()
    dispose = configureSessionCollaborationHost('127.0.0.1', 1234)
    await getSessionCollaborationService()
    expect((await getPowerActivitySnapshot()).busy).toBe(false)
    expect(powerActivityClock.read(false).completionSequence).toBe(before.completionSequence)
  } finally {
    release()
    dispose()
    mock.restore()
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
  }
})

test('an unreadable collaboration store keeps startup power readiness unavailable', async () => {
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  const stateDirectory = join(directory, 'cc-haha', 'session-collaboration')
  await mkdir(stateDirectory, { recursive: true })
  await writeFile(join(stateDirectory, 'state.json'), '{broken')
  const error = spyOn(console, 'error').mockImplementation(() => {})
  const dispose = configureSessionCollaborationHost('127.0.0.1', 1234)
  try {
    await expect(getSessionCollaborationService()).rejects.toThrow()
    expect(hasSessionCollaborationPowerActivity()).toBe(true)
    const { getPowerActivitySnapshot } = await import('./powerActivityRuntime.js')
    expect((await getPowerActivitySnapshot()).busy).toBe(true)
    expect(error).toHaveBeenCalled()
  } finally {
    dispose()
    mock.restore()
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
  }
})

test('user input reopens the inbox only after the shared admission commits to a ready CLI', async () => {
  let ready = false
  const delivered: CollaborationMessage[] = []
  const service = new SessionCollaborationService({
    statePath: join(directory, 'state.json'),
    sessions: { exists: async () => true, list: async () => [], read: async () => [], create: async () => ({ sessionId: 'unused' }) },
    runtime: {
      getState: () => 'running', start: async () => { throw new Error('Should inject into the user turn') }, stop: async () => {},
      enqueue: async (_, message) => { if (!ready) throw new Error('CLI session is not running'); delivered.push(message) },
    },
  })
  await service.onStopped('target')
  await service.send('sender', 'target', 'Previously queued message', 'pending')
  await handleSessionCollaborationEvent(service, { type: 'user-input', sessionId: 'target' })
  expect(delivered).toHaveLength(0)
  expect((await service.status()).messages[0]?.error).toBeUndefined()
  ready = true
  await handleSessionCollaborationEvent(service, { type: 'input-committed', sessionId: 'target' })
  expect(delivered.map(message => message.id)).toEqual(['pending'])
})

test('terminal failure does not claim an accepted message was consumed', async () => {
  const service = new SessionCollaborationService({
    statePath: join(directory, 'state.json'),
    sessions: { exists: async () => true, list: async () => [], read: async () => [], create: async () => ({ sessionId: 'unused' }) },
    runtime: { start: async () => {}, enqueue: async () => {}, stop: async () => {} },
  })
  await service.send('sender', 'target', 'Not yet consumed', 'pending')
  await handleSessionCollaborationEvent(service, { type: 'output', sessionId: 'target', message: { type: 'result', is_error: true, errors: ['process failed before query'] } })
  expect((await service.status()).messages[0]?.status).toBe('accepted')
  await handleSessionCollaborationEvent(service, { type: 'output', sessionId: 'target', message: { type: 'system', subtype: 'session_message_receipt', message_id: 'pending', status: 'consumed' } })
  expect((await service.status()).messages[0]?.status).toBe('consumed')
})

test('streaming output does not broadcast collaboration refreshes until collaboration state changes', async () => {
  const service = new SessionCollaborationService({
    statePath: join(directory, 'state.json'),
    sessions: { exists: async () => true, list: async () => [], read: async () => [], create: async () => ({ sessionId: 'unused' }) },
    runtime: { start: async () => {}, enqueue: async () => {}, stop: async () => {} },
  })

  expect(await handleSessionCollaborationEvent(service, {
    type: 'output',
    sessionId: 'worker',
    message: { type: 'assistant', content: [{ type: 'text', text: 'stream fragment' }] },
  })).toBe(false)
  expect(await handleSessionCollaborationEvent(service, {
    type: 'output',
    sessionId: 'worker',
    message: { type: 'result', is_error: false, result: 'done', uuid: 'result-1' },
  })).toBe(true)
})

test('only an explicit successful root result persists completion, and a stop fences its late result', async () => {
  const service = new SessionCollaborationService({
    statePath: join(directory, 'state.json'),
    now: () => new Date('2026-10-24T01:00:00Z'),
    sessions: { exists: async () => true, list: async () => [], read: async () => [], create: async () => ({ sessionId: 'unused' }) },
    runtime: { start: async () => {}, enqueue: async () => {}, stop: async () => {} },
  })
  const output = (sessionId: string, message: Record<string, unknown>) => handleSessionCollaborationEvent(service, { type: 'output', sessionId, message })
  await service.onUserInput('main')
  expect(await output('main', { type: 'result', is_error: false, parent_tool_use_id: 'agent', uuid: 'child-result' })).toBe(false)
  expect(await output('main', { type: 'result', uuid: 'incomplete-result' })).toBe(false)
  expect((await service.listCompletionStates())[0]).toEqual({ id: 'main', state: 'running' })
  await output('main', { type: 'result', is_error: false, result: 'Done', uuid: 'root-result' })
  expect((await service.listCompletionStates())[0]).toEqual({ id: 'main', state: 'completed', completedAt: '2026-10-24T01:00:00.000Z' })
  await handleSessionCollaborationEvent(service, { type: 'stopped', sessionId: 'stopped' })
  await output('stopped', { type: 'result', is_error: false, result: 'Partial', uuid: 'late-result' })
  await output('failed', { type: 'result', is_error: true, uuid: 'failed-result' })
  expect((await service.listCompletionStates()).filter(row => row.completedAt)).toHaveLength(1)
})

test('host rejects unavailable source workspace explicitly instead of silently choosing another directory', async () => {
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  const dispose = configureSessionCollaborationHost('127.0.0.1', 1234)
  spyOn(sessionService, 'getSessionSummary').mockResolvedValue({ id: 'source' } as any)
  spyOn(sessionService, 'getSessionWorkDir').mockResolvedValue(null)
  const create = spyOn(sessionService, 'createSession')
  try {
    const service = await getSessionCollaborationService()
    const error = await service.create('source', { prompt: 'a', requestId: 'missing-workspace' }).catch(value => value)
    expect(error).toBeInstanceOf(ApiError)
    expect(error.code).toBe('SESSION_WORKSPACE_UNAVAILABLE')
    expect(error.message).toContain('working directory is unavailable')
    expect(create).not.toHaveBeenCalled()
  } finally {
    dispose()
    mock.restore()
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
  }
})

test('manual admission waits for already emitted Stop events before reserving its slot', async () => {
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  const dispose = configureSessionCollaborationHost('127.0.0.1', 1234)
  let unblock!: () => void
  const gate = new Promise<void>(resolve => { unblock = resolve })
  try {
    const service = await getSessionCollaborationService()
    const stopped = service.onStopped.bind(service)
    spyOn(service, 'onStopped').mockImplementation(async id => { await gate; await stopped(id) })
    emitSessionTurnEvent({ type: 'stopped', sessionId: 'worker' })
    let admitted = false
    const pending = admitSessionUserTurn('worker', () => true).then(lease => { admitted = true; return lease })
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(admitted).toBe(false)
    unblock()
    const lease = await pending
    expect((await service.status()).members.find(member => member.sessionId === 'worker')).toMatchObject({ state: 'running', stopped: false })
    await lease.release()
    expect((await service.status()).members.find(member => member.sessionId === 'worker')).toMatchObject({ state: 'stopped', stopped: true })
  } finally {
    unblock()
    dispose()
    mock.restore()
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
  }
})


test('a full metadata page skips transcript search and returns immediately from the bounded index', async () => {
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  const dispose = configureSessionCollaborationHost('127.0.0.1', 1234)
  const sessions = Array.from({ length: 30 }, (_, i) => ({ id: `match-${i}`, title: '修复', workDir: '/fixture', projectPath: 'project', modifiedAt: 'now' }))
  const metadata = spyOn(sessionService, 'searchSessionMetadata').mockResolvedValue({ sessions, total: 20_000 })
  const list = spyOn(sessionService, 'listSessions').mockRejectedValue(new Error('Must not hydrate the sidebar'))
  const fullText = spyOn(SearchService.prototype, 'searchSessions').mockRejectedValue(new Error('Must not read transcripts'))
  const suggestions = spyOn(SearchService.prototype, 'searchSessionSuggestions').mockRejectedValue(new Error('Already have a full metadata page'))
  try {
    const service = await getSessionCollaborationService()
    const result = await service.candidates('修复')
    expect(result.sessions.map(item => item.sessionId)).toEqual(sessions.map(item => item.id))
    expect(metadata).toHaveBeenCalledWith('修复', expect.objectContaining({ limit: 30, offset: 0, signal: undefined }))
    expect(await service.list({ query: '修复' })).toMatchObject({ total: 20_000, totalIsLowerBound: true, truncated: true })
    expect(list).not.toHaveBeenCalled()
    expect(fullText).not.toHaveBeenCalled()
    expect(suggestions).not.toHaveBeenCalled()
  } finally {
    dispose(); mock.restore()
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
  }
})

test('duplicate transcript rows cannot replace a useful collaboration title with Untitled', async () => {
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  const dispose = configureSessionCollaborationHost('127.0.0.1', 1234)
  const row = (title: string, modifiedAt: string) => ({
    id: 'worker', title, workDir: '/fixture', projectPath: 'project', modifiedAt,
  })
  const indexed = spyOn(sessionService, 'getSessionSuggestionMetadata')
    .mockReturnValue([
      row('Untitled Session', 'newer'),
      row('Review the auth boundary', 'older'),
    ])
  try {
    const service = await getSessionCollaborationService()
    await service.onUserInput('worker')
    expect((await service.status(['worker'])).members[0]?.title)
      .toBe('Review the auth boundary')

    indexed.mockReturnValue([
      row('Newest useful title', 'newer'),
      row('Older useful title', 'older'),
    ])
    expect((await service.status(['worker'])).members[0]?.title)
      .toBe('Newest useful title')
  } finally {
    dispose(); mock.restore()
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
  }
})

test('content suggestions fill metadata pages without duplicate metadata hits or canonical history reads', async () => {
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  const dispose = configureSessionCollaborationHost('127.0.0.1', 1234)
  const title = { id: 'title', title: 'Project match', workDir: '/fixture', projectPath: '修复-project', modifiedAt: 'now' }
  const body = { id: 'body', title: 'Older discussion', workDir: '/fixture', projectPath: 'project', modifiedAt: 'before' }
  spyOn(sessionService, 'searchSessionMetadata').mockImplementation(async (_query, options) => ({ sessions: options?.offset ? [] : [title], total: 1 }))
  spyOn(sessionService, 'getSessionSuggestionMetadata').mockReturnValue([title, body])
  const fullText = spyOn(SearchService.prototype, 'searchSessions').mockRejectedValue(new Error('Must not scan files'))
  spyOn(SearchService.prototype, 'searchSessionSuggestions').mockResolvedValue({
    sessions: [title, body, body].map(item => ({ sessionId: item.id, projectPath: item.projectPath, modifiedAt: item.modifiedAt, ownerTranscriptPath: `/fixture/${item.id}.jsonl` })),
    truncated: false, indexUnavailable: false,
  })
  try {
    const service = await getSessionCollaborationService()
    expect((await service.candidates('修复')).sessions.map(item => item.sessionId)).toEqual(['title', 'body'])
    expect((await service.list({ query: '修复', offset: 1, limit: 1 }) as any).sessions.map((item: any) => item.id)).toEqual(['body'])
    expect((await service.list({ query: '修复', offset: 2, limit: 1 }) as any).sessions).toEqual([])
    expect(fullText).not.toHaveBeenCalled()
  } finally {
    dispose(); mock.restore()
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
  }
})

test('an explicit replacement provider can resolve even when the parent runtime is unavailable', async () => {
  const catalog = await import('./sessionModelCatalog.js')
  const handler = await import('../ws/handler.js')
  const { resolveCollaborationRuntime } = await import('./sessionCollaborationHost.js')
  const parent = spyOn(handler, 'getCollaborationRuntime').mockRejectedValue(new Error('parent removed'))
  const selected = { providerId: 'replacement', modelId: 'same-name' }
  spyOn(catalog, 'resolveSessionRuntime').mockImplementation(async (input, inherited) => input.runtime ?? inherited)
  try {
    expect(await resolveCollaborationRuntime('parent', { runtime: selected })).toEqual(selected)
    expect(parent).not.toHaveBeenCalled()
    await expect(resolveCollaborationRuntime('parent', {})).rejects.toThrow('parent removed')
  } finally { mock.restore() }
})

for (const savedMode of ['plan', undefined]) {
  test(`explicit creation survives a deleted parent provider and inherits ${savedMode ?? 'default'} permissions`, async () => {
    const previous = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = directory
    const handler = await import('../ws/handler.js')
    const catalog = await import('./sessionModelCatalog.js')
    const { conversationService } = await import('./conversationService.js')
    const { SettingsService } = await import('./settingsService.js')
    const repository = await import('./repositoryLaunchService.js')
    const dispose = configureSessionCollaborationHost('127.0.0.1', 1234)
    const replacement = { providerId: 'replacement', modelId: 'shared-model' }
    let removed = false
    spyOn(catalog, 'resolveSessionRuntime').mockImplementation(async (input, parent) => {
      const selection = input.runtime ?? parent
      if (removed && selection.providerId === 'removed') throw new Error('parent provider removed')
      return selection
    })
    spyOn(catalog, 'validateSessionRuntime').mockImplementation(async selection => selection)
    spyOn(conversationService, 'getSessionRuntimeSelection').mockImplementation(id => id === 'source'
      ? { providerId: 'removed', modelId: 'shared-model' } : replacement)
    spyOn(sessionService, 'getSessionSummary').mockResolvedValue({ id: 'source' } as never)
    spyOn(sessionService, 'getSessionWorkDir').mockResolvedValue(directory)
    spyOn(sessionService, 'getSessionLaunchInfo').mockResolvedValue({
      runtimeProviderId: 'removed', runtimeModelId: 'shared-model', permissionMode: savedMode,
    } as never)
    spyOn(SettingsService.prototype, 'getPermissionMode').mockResolvedValue('default')
    spyOn(repository, 'getRepositoryContext').mockResolvedValue({ state: 'not_git_repo' } as never)
    const create = spyOn(sessionService, 'createSession').mockResolvedValue({ sessionId: 'child', workDir: directory } as never)
    const metadata = spyOn(sessionService, 'appendSessionMetadata').mockResolvedValue(undefined)
    spyOn(handler, 'submitSessionTurn').mockResolvedValue({ status: 'queued' } as never)
    try {
      await handler.getCollaborationRuntime('source')
      removed = true
      const service = await getSessionCollaborationService()
      const result = await service.create('source', { prompt: 'Review task', requestId: 'replacement', runtime: replacement })
      expect(result.sessionId).toBe('child')
      expect(create).toHaveBeenCalledWith(directory, undefined, savedMode ?? 'default')
      expect(metadata).toHaveBeenCalledWith('child', expect.objectContaining({
        permissionMode: savedMode ?? 'default', runtimeProviderId: 'replacement', runtimeModelId: 'shared-model',
      }))
    } finally {
      dispose(); handler.__resetWebSocketHandlerStateForTests(); mock.restore()
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previous
    }
  })
}
