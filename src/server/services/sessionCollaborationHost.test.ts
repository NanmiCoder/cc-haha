import { afterEach, beforeEach, expect, test, spyOn, mock } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionCollaborationService, type CollaborationMessage } from './sessionCollaborationService.js'
import { handleSessionCollaborationEvent, configureSessionCollaborationHost, getSessionCollaborationService } from './sessionCollaborationHost.js'
import { sessionService } from './sessionService.js'
import { admitSessionUserTurn, emitSessionTurnEvent } from './sessionTurnEvents.js'
import { SearchService } from './searchService.js'
import { ApiError } from '../middleware/errorHandler.js'

let directory: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'collaboration-host-fixture-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

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
