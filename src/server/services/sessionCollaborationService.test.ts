import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionCollaborationService, projectCollaborationHistory, type SessionCollaborationDependencies, type CollaborationMessage } from './sessionCollaborationService.js'
import { ApiError } from '../middleware/errorHandler.js'

let directory: string
let deps: SessionCollaborationDependencies
let service: SessionCollaborationService
let started: CollaborationMessage[]
let injected: CollaborationMessage[]
let nextId: number
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'collaboration-test-'))
  started = []; injected = []; nextId = 0
  deps = {
    statePath: join(directory, 'state.json'),
    sessions: {
      list: async () => ({ sessions: [{ id: 'root', title: 'Main', workDir: '/fixture', modifiedAt: 'now' }] }),
      read: async () => ({ messages: [], page: { historyComplete: true } }),
      exists: async id => id !== 'missing',
      create: async () => ({ sessionId: `child-${++nextId}`, workDir: '/fixture/worktree' }),
    },
    runtime: { start: async (_, message) => { started.push(message) }, enqueue: async (_, message) => { injected.push(message) }, stop: async () => {} },
  }
  service = new SessionCollaborationService(deps)
})
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

describe('session collaboration', () => {
  test('suggestions project current member status without materializing message history', async () => {
    await service.onSessionState('root', 'blocked')
    service.status = async () => { throw new Error('Suggestions must not clone the full collaboration history') }
    expect((await service.candidates('Main')).sessions).toEqual([
      { sessionId: 'root', title: 'Main', cwd: '/fixture', status: 'blocked', updatedAt: 'now' },
    ])
  })

  test('suggestions propagate cancellation and reject cancelled results', async () => {
    const controller = new AbortController()
    let calls = 0
    deps.sessions.list = async options => {
      calls++
      expect(options.signal).toBe(controller.signal)
      controller.abort(new Error('Query replaced'))
      return { sessions: [] }
    }
    await expect(service.candidates('old query', controller.signal)).rejects.toThrow('Query replaced')
    await expect(service.candidates('old query', controller.signal)).rejects.toThrow('Query replaced')
    expect(calls).toBe(1)
  })

  test('shares three worker slots across nested delegation and releases them on completion', async () => {
    const a = await service.create('root', { prompt: 'a' })
    expect(a).toMatchObject({ state: 'running', delivery: 'accepted' })
    await service.create('root', { prompt: 'b' })
    await service.create(a.sessionId, { prompt: 'nested' })
    const queued = await service.create('root', { prompt: 'queued' })
    expect(queued).toMatchObject({ state: 'queued', delivery: 'queued' })
    expect(started).toHaveLength(3)
    expect((await service.status()).members.find(member => member.sessionId === queued.sessionId)?.state).toBe('queued')
    await service.onSessionState(a.sessionId, 'completed', 'done', 'completion-1')
    expect(started.some(message => message.targetSessionId === queued.sessionId)).toBe(true)
    const snapshot = await service.status()
    expect(snapshot.members.filter(member => member.sessionId !== 'root' && member.state === 'running')).toHaveLength(3)
    expect(snapshot.messages.filter(message => message.id === 'completion-1')).toHaveLength(1)
    await service.onSessionState(a.sessionId, 'completed', 'done', 'completion-1')
    expect((await service.status()).messages.filter(message => message.id === 'completion-1')).toHaveLength(1)
  })

  test('injects into existing busy sessions and deduplicates retry ids', async () => {
    deps.runtime.getState = () => 'running'
    await service.send('root', 'existing', 'hello', 'stable-id')
    await service.send('root', 'existing', 'hello', 'stable-id')
    expect(started).toHaveLength(0)
    expect(injected).toHaveLength(1)
    await service.onMessageConsumed('stable-id')
    expect((await service.status()).messages[0]?.status).toBe('consumed')
    await expect(service.send('root', 'existing', 'different', 'stable-id')).rejects.toThrow('different content')
  })

  test('Stop fences automatic wakeups and survives restart; explicit input clears it', async () => {
    const child = await service.create('root', { prompt: 'a' })
    await service.stop('root')
    await service.onSessionState(child.sessionId, 'completed', 'finished')
    expect(started.filter(message => message.targetSessionId === 'root')).toHaveLength(0)
    service = new SessionCollaborationService(deps)
    await service.recover()
    expect((await service.status()).members.find(member => member.sessionId === 'root')?.stopped).toBe(true)
    await service.onUserInput('root')
    expect(injected.some(message => message.targetSessionId === 'root')).toBe(true)
  })

  test('restart pauses unknown admissions instead of launching them again', async () => {
    await service.create('root', { prompt: 'a' })
    service = new SessionCollaborationService(deps)
    await service.recover()
    expect(started).toHaveLength(1)
    const snapshot = await service.status()
    expect(snapshot.members.find(member => member.sessionId === 'child-1')?.stopped).toBe(true)
    expect(snapshot.messages[0]?.status).toBe('queued')
  })

  test('restart fences a permission-blocked worker even when its assignment was consumed', async () => {
    const child = await service.create('root', { prompt: 'requires permission' })
    await service.onMessageConsumed(child.messageId)
    await service.onSessionState(child.sessionId, 'blocked', 'Awaiting approval')
    service = new SessionCollaborationService(deps)
    await service.recover()
    expect((await service.status()).members.find(member => member.sessionId === child.sessionId)).toMatchObject({ state: 'stopped', stopped: true })
  })

  test('idempotent creation returns the original independently persisted session', async () => {
    const input = { prompt: 'a', requestId: 'create-1' }
    const first = await service.create('root', input)
    service = new SessionCollaborationService(deps)
    expect(await service.create('root', input)).toEqual(first)
    expect(nextId).toBe(1)
  })

  test('keeps the creation title while the transcript index is missing or temporarily untitled', async () => {
    let indexedTitle: string | undefined = 'Untitled Session'
    deps.sessions.titles = sessionIds => indexedTitle
      ? Object.fromEntries(sessionIds.map(sessionId => [sessionId, indexedTitle]))
      : {}

    const created = await service.create('root', {
      prompt: 'Review the authentication boundary',
      title: 'Auth boundary review',
    })
    expect((await service.status([created.sessionId])).members[0]?.title)
      .toBe('Auth boundary review')

    indexedTitle = undefined
    service = new SessionCollaborationService(deps)
    expect((await service.status([created.sessionId])).members[0]?.title)
      .toBe('Auth boundary review')

    indexedTitle = 'Indexed auth review'
    expect((await service.status([created.sessionId])).members[0]?.title)
      .toBe('Indexed auth review')
  })

  test('migrates a versionless fixture while preserving unknown metadata', async () => {
    await writeFile(deps.statePath, JSON.stringify({ members: {}, messages: [], futureField: { preserve: true } }))
    service = new SessionCollaborationService(deps)
    await service.onUserInput('root')
    const stored = JSON.parse(await readFile(deps.statePath, 'utf8'))
    expect(stored.version).toBe(1)
    expect(stored.futureField).toEqual({ preserve: true })
  })

  test('wait wakes on incoming messages and user input interrupts the caller wait', async () => {
    const initial = await service.status()
    const waiting = service.wait(initial.revision, undefined, 1000)
    await service.send('root', 'other', 'news')
    expect((await waiting).revision).toBeGreaterThan(initial.revision)
    const revision = (await service.status()).revision
    const interrupted = service.wait(revision, undefined, 1000, undefined, 'root')
    await new Promise(resolve => setTimeout(resolve, 5))
    const rejection = interrupted.catch(error => error)
    await service.onUserInput('root')
    expect((await rejection).message).toContain('user supplied new input')
  })

  test('read defaults to one turn, excludes tool output and bounds opt-in output', () => {
    const history = { messages: [
      { type: 'user', content: 'old' }, { type: 'assistant', content: 'old answer' },
      { type: 'user', content: 'new' }, { type: 'tool_result', content: 'x'.repeat(40_000), toolUseResult: 'private-output' },
      { type: 'assistant', content: 'new answer' },
    ], page: { historyComplete: true } }
    const projected = projectCollaborationHistory(history) as any
    expect(projected.turnsIncluded).toBe(1)
    expect(projected.messages).toHaveLength(2)
    expect(JSON.stringify(projected)).not.toContain('private-output')
    const outputs = projectCollaborationHistory(history, { includeOutputs: true, maxOutputCharsPerItem: 100 }) as any
    expect(outputs.messages[1].content).toHaveLength(100)
    expect(outputs.truncated).toBe(true)
  })

  test('one-turn cursors retain older turns within a bounded storage page', async () => {
    deps.sessions.read = async () => ({ messages: [
      { type: 'user', content: 'first' }, { type: 'assistant', content: 'answer1' },
      { type: 'user', content: 'second' }, { type: 'assistant', content: 'answer2' },
      { type: 'user', content: 'third' }, { type: 'assistant', content: 'answer3' },
    ], page: { historyComplete: true, sourceVersion: 'v1', nextCursor: null } })
    const third = await service.read('root') as any
    const second = await service.read('root', { cursor: third.page.nextCursor }) as any
    const first = await service.read('root', { cursor: second.page.nextCursor }) as any
    expect([third.messages[0].content, second.messages[0].content, first.messages[0].content]).toEqual(['third', 'second', 'first'])
    expect(first.page.nextCursor).toBeNull()
  })

  test('budget cursors preserve all messages and oversized-message fragments', async () => {
    const large = { id: 'large', type: 'assistant', content: 'long text '.repeat(7000) }
    deps.sessions.read = async () => ({ messages: [
      { id: 'prompt', type: 'user', content: 'question' }, large, { id: 'last', type: 'assistant', content: 'finished' },
    ], page: { historyComplete: true, sourceVersion: 'v1', nextCursor: null } })
    let cursor: string | undefined
    const messages: any[] = []
    do {
      const result = await service.read('root', { cursor }) as any
      messages.unshift(...result.messages)
      cursor = result.page.nextCursor ?? undefined
    } while (cursor)
    expect(messages[0].id).toBe('prompt')
    expect(messages.at(-1).id).toBe('last')
    const fragments = messages.filter(message => message.id === 'large').sort((a, b) => a.contentPart.from - b.contentPart.from)
    expect(JSON.parse(fragments.map(message => message.content).join(''))).toEqual(large)
  })

  test('a cursor chain stops after the page budget instead of walking the transcript', async () => {
    let reads = 0
    deps.sessions.read = async () => {
      reads += 1
      return { messages: [
        { type: 'user', content: `turn ${reads}` }, { type: 'assistant', content: 'answer' },
      ], page: { historyComplete: false, sourceVersion: 'v1', nextCursor: `storage-${reads}` } }
    }
    let cursor: string | undefined
    let pages = 0
    do {
      const result = await service.read('root', { cursor }) as any
      pages += 1
      cursor = result.page.nextCursor ?? undefined
    } while (cursor)
    expect(pages).toBeLessThanOrEqual(8)
    expect(reads).toBeLessThanOrEqual(8)
    expect(cursor).toBeUndefined()
  })

  test('group Stop fences all descendants before runtime completion callbacks', async () => {
    await service.create('root', { prompt: 'a' })
    await service.create('root', { prompt: 'b' })
    deps.runtime.stop = async id => { await service.onSessionState(id, 'completed', 'stopped runtime') }
    await service.stopGroup('child-1')
    expect((await service.status()).members.every(member => member.stopped)).toBe(true)
    expect(started.filter(message => message.targetSessionId === 'root')).toHaveLength(0)
  })

  test('permission-blocked workers retain a slot until their turn completes', async () => {
    const first = await service.create('root', { prompt: 'a' })
    await service.create('root', { prompt: 'b' })
    await service.create('root', { prompt: 'c' })
    const fourth = await service.create('root', { prompt: 'd' })
    await service.onSessionState(first.sessionId, 'blocked', 'Permission needed')
    expect(started.some(message => message.targetSessionId === fourth.sessionId)).toBe(false)
    await service.onSessionState(first.sessionId, 'running')
    expect((await service.status()).members.filter(member => member.parentSessionId && member.state === 'running')).toHaveLength(3)
  })

  test('two waiting peers return promptly when either receives a message', async () => {
    await service.onUserInput('a')
    await service.onUserInput('b')
    const revision = (await service.status()).revision
    const a = service.wait(revision, ['b'], 1000, undefined, 'a')
    const b = service.wait(revision, ['a'], 1000, undefined, 'b')
    await service.send('a', 'b', 'I need your progress', 'incoming')
    expect((await a).revision).toBeGreaterThan(revision)
    expect((await b).revision).toBeGreaterThan(revision)
    expect(injected).toHaveLength(1)
  })

  test('runtime admission failure remains recoverable without a retry loop', async () => {
    deps.runtime.start = async () => { throw new Error('offline fixture') }
    const created = await service.create('root', { prompt: 'a' })
    expect(created).toMatchObject({ state: 'failed', delivery: 'queued', error: 'offline fixture' })
    let snapshot = await service.status()
    expect(snapshot.messages[0]?.status).toBe('queued')
    expect(snapshot.messages[0]?.error).toBe('offline fixture')
    deps.runtime.start = async (_, message) => { started.push(message) }
    await service.resume(created.sessionId)
    snapshot = await service.status()
    expect(snapshot.messages[0]?.status).toBe('accepted')
    expect(started).toHaveLength(1)
  })

  test('Stop revokes final-write eligibility during a delayed admission', async () => {
    let release!: () => void
    let entered!: () => void
    const admissionStarted = new Promise<void>(resolve => { entered = resolve })
    deps.runtime.start = async (_, message) => {
      entered()
      await new Promise<void>(resolve => { release = resolve })
      if (!service.canDeliver(message.id)) throw new Error('Stopped before socket write')
      started.push(message)
    }
    const creation = service.create('root', { prompt: 'a' })
    await admissionStarted
    await service.onStopped('child-1')
    release()
    await creation
    expect(started).toHaveLength(0)
    expect((await service.status()).members.find(member => member.sessionId === 'child-1')?.stopped).toBe(true)
  })

  test('nested waits report capacity deadlock immediately without oversubscribing worker slots', async () => {
    const parent = await service.create('root', { prompt: 'worker1' })
    await service.create('root', { prompt: 'worker2' })
    await service.create('root', { prompt: 'worker3' })
    const nested = await service.create(parent.sessionId, { prompt: 'nested' })
    const revision = (await service.status()).revision
    const response = await service.wait(revision, [nested.sessionId], 60_000, undefined, parent.sessionId)
    expect(response.waitReason).toBe('capacity_blocked')
    expect(response.guidance).toContain('End the current turn')
    expect(started).toHaveLength(3)
    await service.onSessionState(parent.sessionId, 'completed', 'Delegated pending work')
    expect(started.some(message => message.targetSessionId === nested.sessionId)).toBe(true)
  })

  test('failed workspace creation keeps its explicit error across idempotent retries and restart', async () => {
    let attempts = 0
    deps.sessions.create = async () => {
      attempts++
      throw new ApiError(400, 'Failed to create isolated worktree: branch is unavailable', 'REPOSITORY_WORKTREE_CREATE_FAILED')
    }
    const input = { prompt: 'a', requestId: 'worktree-failure' }
    const first = await service.create('root', input).catch(error => error)
    expect(first).toBeInstanceOf(ApiError)
    expect(first.code).toBe('REPOSITORY_WORKTREE_CREATE_FAILED')
    service = new SessionCollaborationService(deps)
    const retry = await service.create('root', input).catch(error => error)
    expect(retry).toBeInstanceOf(ApiError)
    expect(retry.message).toBe(first.message)
    expect(retry.code).toBe(first.code)
    expect(attempts).toBe(1)
    expect(started).toHaveLength(0)
  })

  test('group cancellation survives restart and explicit input without resurrecting assignments', async () => {
    const first = await service.create('root', { prompt: 'started' })
    const consumed = await service.create('root', { prompt: 'consumed' })
    await service.onMessageConsumed(consumed.messageId)
    await service.create('root', { prompt: 'third' })
    const queued = await service.create('root', { prompt: 'queued' })
    await service.stopGroup('root')
    expect(service.canDeliver(first.messageId)).toBe(false)
    await service.onMessageConsumed(first.messageId, first.sessionId)
    let messages = (await service.status()).messages
    expect(messages.find(message => message.id === first.messageId)?.status).toBe('cancelled')
    expect(messages.find(message => message.id === queued.messageId)?.status).toBe('cancelled')
    expect(messages.find(message => message.id === consumed.messageId)?.status).toBe('consumed')
    service = new SessionCollaborationService(deps)
    await service.recover()
    await service.onUserInput(first.sessionId)
    await service.resume(queued.sessionId)
    messages = (await service.status()).messages
    expect(messages.find(message => message.id === queued.messageId)?.status).toBe('cancelled')
    expect(started).toHaveLength(3)
    expect(injected).toHaveLength(0)
  })

  test('ordinary Stop requeues an unconsumed admission for explicit user resumption', async () => {
    const child = await service.create('root', { prompt: 'pending admission' })
    await service.onStopped(child.sessionId)
    expect((await service.status()).messages[0]?.status).toBe('queued')
    await service.onUserInput(child.sessionId)
    expect(injected.map(message => message.id)).toEqual([child.messageId])
    await service.onMessageConsumed(child.messageId, child.sessionId)
    expect((await service.status()).messages[0]?.status).toBe('consumed')
  })

  test('an in-flight admission rejection cannot undo group cancellation', async () => {
    let release!: () => void
    let entered!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve })
    deps.runtime.start = async () => { entered(); await new Promise<void>(resolve => { release = resolve }); throw new Error('cancelled socket write') }
    const creation = service.create('root', { prompt: 'in flight' })
    await ready
    await service.stopGroup('root')
    release()
    const result = await creation
    expect(result).toMatchObject({ state: 'stopped', delivery: 'cancelled' })
    expect((await service.status()).messages[0]?.status).toBe('cancelled')
  })

  test('a short wait is raised to the minimum and says so, while a newer revision still returns immediately', async () => {
    const startedAt = Date.now()
    const raised = await service.wait(0, undefined, 0)
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(10_000)
    expect(raised).toMatchObject({ requestedTimeoutMs: 0, timeoutMs: 10_000, messages: [] })
    expect(raised.guidance).toContain('clamped to 10000ms')
    await service.send('root', 'peer', 'arrived', 'arrived')
    const fresh = await service.wait(raised.revision, ['peer'], 0)
    expect(fresh.messages.map(message => message.id)).toEqual(['arrived'])
    expect(fresh).toMatchObject({ requestedTimeoutMs: 0, timeoutMs: 10_000 })
  }, 20_000)

  test('wait cursor omits unchanged messages but returns a changed delivery receipt', async () => {
    await service.send('root', 'peer', 'message', 'stable')
    const first = await service.wait(0, ['peer'], 0)
    expect(first.messages.map(message => message.id)).toEqual(['stable'])
    expect((await service.status(['peer'])).revision).toBe(first.revision)
    await service.onMessageConsumed('stable', 'peer')
    const consumed = await service.wait(first.revision, ['peer'], 0)
    expect(consumed.messages).toHaveLength(1)
    expect(consumed.messages[0]?.status).toBe('consumed')
    expect((await service.status(['peer'])).messages).toHaveLength(1)
  })

  test('legacy message revisions migrate once and bounded wait does not change complete UI status', async () => {
    await writeFile(deps.statePath, JSON.stringify({ version: 1, revision: 5, members: {}, messages: [
      { id: 'legacy', sourceSessionId: 'a', targetSessionId: 'b', content: 'legacy text', kind: 'message', status: 'consumed', createdAt: 'old' },
    ] }))
    service = new SessionCollaborationService(deps)
    const migrated = await service.wait(0, undefined, 0)
    expect(migrated.messages[0]?.revision).toBe(5)
    await service.onStopped('b')
    for (let index = 0; index < 60; index++) await service.send('a', 'b', 'x'.repeat(3000), `message-${index}`)
    const bounded = await service.wait(5, undefined, 0)
    expect(bounded.truncated).toBe(true)
    expect(bounded.omittedMessages).toBeGreaterThan(0)
    expect(JSON.stringify(bounded).length).toBeLessThan(50_000)
    expect((await service.status()).messages).toHaveLength(61)
  })
})

describe('reviewed admission and cancellation invariants', () => {
  test('manual turns cannot claim a fourth worker slot and failed admission releases its reservation', async () => {
    for (let i = 0; i < 4; i++) await service.create('root', { prompt: `task ${i}` })
    await expect(service.admitUserTurn('child-4')).rejects.toThrow('worker')
    expect((await service.status()).members.find(m => m.sessionId === 'child-4')?.state).toBe('queued')
    await service.onStopped('child-1')
    const lease = await service.admitUserTurn('child-1')
    expect((await service.status()).members.find(m => m.sessionId === 'child-1')?.state).toBe('running')
    await lease.release()
    expect((await service.status()).members.find(m => m.sessionId === 'child-1')?.stopped).toBe(true)
  })

  test('group Stop cancels assignments whose workspace creation finishes later', async () => {
    let release!: () => void
    let entered!: () => void
    const enteredPromise = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    deps.sessions.create = async () => { entered(); await gate; return { sessionId: 'late-child' } }
    const pending = service.create('root', { prompt: 'old task', requestId: 'stable-create' })
    await enteredPromise
    await service.stopGroup('root')
    release()
    const created = await pending
    expect(created.delivery).toBe('cancelled')
    await service.onUserInput('late-child')
    expect(injected).toHaveLength(0)
    expect(started).toHaveLength(0)
  })

  test('explicit retry and new user input recover delivery errors without reviving cancelled messages', async () => {
    let attempts = 0
    deps.runtime.getState = () => 'running'
    deps.runtime.enqueue = async () => { attempts++; if (attempts === 1 || attempts === 3) throw new Error('temporary disconnect') }
    await service.send('root', 'peer', 'hello', 'retry')
    await service.send('root', 'peer', 'hello', 'retry')
    expect(attempts).toBe(2)
    await service.send('root', 'peer', 'next', 'input-retry')
    await service.onUserInput('peer')
    expect(attempts).toBe(4)
    await service.stopGroup('peer')
    await service.send('root', 'peer', 'next', 'input-retry')
    await service.onUserInput('peer')
    expect(attempts).toBe(4)
  })
})


test('manual reservations are fenced by Stop and replacement admissions', async () => {
  const child = await service.create('root', { prompt: 'task' })
  await service.onStopped(child.sessionId)
  const first = await service.admitUserTurn(child.sessionId)
  await service.onStopped(child.sessionId)
  const second = await service.admitUserTurn(child.sessionId)
  await first.release()
  expect((await service.status()).members.find(m => m.sessionId === child.sessionId)?.state).toBe('running')
  await service.onStopped(child.sessionId)
  await second.release()
  expect((await service.status()).members.find(m => m.sessionId === child.sessionId)?.stopped).toBe(true)
  await expect(service.admitUserTurn(child.sessionId, () => false)).rejects.toThrow('cancelled')
  expect((await service.status()).members.find(m => m.sessionId === child.sessionId)?.stopped).toBe(true)
})

test('legacy stores gain persistent group stop epochs without discarding unknown data', async () => {
  const old = { revision: 0, members: {}, messages: [], futureData: { keep: true } }
  await writeFile(deps.statePath, JSON.stringify(old))
  service = new SessionCollaborationService(deps)
  await service.stopGroup('root')
  const stored = JSON.parse(await readFile(deps.statePath, 'utf8'))
  expect(stored.stopEpochs).toEqual({ root: 1 })
  expect(stored.futureData).toEqual({ keep: true })
  const restarted = new SessionCollaborationService(deps)
  await restarted.stopGroup('root')
  expect(JSON.parse(await readFile(deps.statePath, 'utf8')).stopEpochs.root).toBe(2)
})

test('a group cancellation epoch remains effective after the parent resumes during workspace creation', async () => {
  let release!: () => void
  let entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  deps.sessions.create = async () => { entered(); await gate; return { sessionId: 'late-after-resume' } }
  const pending = service.create('root', { prompt: 'old assignment', requestId: 'epoch-reservation' })
  await ready
  await service.stopGroup('root')
  await service.onUserInput('root')
  release()
  expect((await pending).delivery).toBe('cancelled')
  const store = JSON.parse(await readFile(deps.statePath, 'utf8'))
  expect(store.creations['root:epoch-reservation']).toMatchObject({ rootSessionId: 'root', stopEpoch: 0 })
  expect(started).toHaveLength(0)
})

test('simultaneous manual admissions compete atomically for the final slot', async () => {
  for (let i = 0; i < 4; i++) await service.create('root', { prompt: `task ${i}` })
  await service.onStopped('child-1')
  const outcomes = await Promise.allSettled([service.admitUserTurn('child-1'), service.admitUserTurn('child-4')])
  expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
  const snapshot = await service.status()
  expect(snapshot.members.filter(member => member.sessionId !== 'root' && member.state === 'running')).toHaveLength(3)
})


test('replacement reservations retain the original state when neither turn commits', async () => {
  const child = await service.create('root', { prompt: 'original task' })
  await service.onStopped(child.sessionId)
  const first = await service.admitUserTurn(child.sessionId)
  const second = await service.admitUserTurn(child.sessionId)
  await first.release()
  expect((await service.status()).members.find(member => member.sessionId === child.sessionId)?.state).toBe('running')
  await second.release()
  expect((await service.status()).members.find(member => member.sessionId === child.sessionId)).toMatchObject({ state: 'stopped', stopped: true })
})

test('a reserved manual turn does not accept inbox messages until its CLI input commits', async () => {
  const child = await service.create('root', { prompt: 'old assignment' })
  await service.onStopped(child.sessionId)
  deps.runtime.getState = () => 'running'
  await service.admitUserTurn(child.sessionId)
  await service.send('root', child.sessionId, 'arrived during startup', 'startup-peer')
  expect(injected).toHaveLength(0)
  await service.onUserInput(child.sessionId, { dispatch: false })
  await service.onSessionState(child.sessionId, 'running')
  expect(injected.map(message => message.content)).toEqual(['old assignment', 'arrived during startup'])
})


test('sending while the host temporarily blocks admission does not persist a permission block', async () => {
  deps.runtime.getState = () => 'blocked'
  await service.send('root', 'peer', 'wait for admission', 'pending-admission')
  expect((await service.status()).members.find(member => member.sessionId === 'peer')?.state).toBe('idle')
  deps.runtime.getState = () => 'idle'
  await service.send('root', 'peer', 'wait for admission', 'pending-admission')
  expect(started.map(message => message.id)).toEqual(['pending-admission'])
})


test('a failed reservation persistence write cannot leave an invisible admission lock', async () => {
  await service.resume('peer')
  const persisted = await readFile(deps.statePath, 'utf8')
  await rm(deps.statePath)
  await mkdir(deps.statePath)
  await expect(service.admitUserTurn('peer')).rejects.toThrow()
  await rm(deps.statePath, { recursive: true })
  await writeFile(deps.statePath, persisted)
  await service.send('root', 'peer', 'retry after storage recovery', 'storage-recovery')
  expect(started.map(message => message.id)).toEqual(['storage-recovery'])
})
