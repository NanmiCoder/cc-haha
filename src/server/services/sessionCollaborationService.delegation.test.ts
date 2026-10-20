import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionCollaborationService, type SessionCollaborationDependencies, type CollaborationMessage } from './sessionCollaborationService.js'
import type { SessionRuntimeSelection } from '../../shared/sessionDelegation.js'
import { handleSessionCollaborationUiApi } from '../api/sessionCollaboration.js'

let directory: string
let service: SessionCollaborationService
let deps: SessionCollaborationDependencies
let created: number
let started: CollaborationMessage[]
let applied: string[]
const runtime: SessionRuntimeSelection = { providerId: 'provider-a', modelId: 'same-model' }
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'delegation-fixture-'))
  created = 0; started = []; applied = []
  deps = {
    statePath: join(directory, 'state.json'),
    sessions: { exists: async () => true, list: async () => [], read: async () => [], create: async () => ({ sessionId: `child-${++created}` }), verifyUserInstruction: async (_, evidence) => evidence.messageId === 'real-user' && evidence.quote === 'use provider-a same-model' },
    models: { list: async () => [], parentRuntime: async () => runtime, resolve: async (_, input) => input.runtime ?? runtime, validate: async selection => { if (selection.providerId === 'deleted') throw new Error('Provider deleted'); return selection } },
    runtime: { start: async (_, message) => { started.push(message) }, enqueue: async (_, message) => { started.push(message) }, stop: async () => {}, stopAndWait: async id => { await service.onStopped(id) }, apply: async id => { applied.push(id) } },
  }
  service = new SessionCollaborationService(deps)
})
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

const input = () => ({ requestId: 'batch', sessions: [{ id: 'a', prompt: 'task a' }, { id: 'b', prompt: 'task b' }] })

test('default proposal is durable review without creating sessions; confirmation starts once', async () => {
  const proposal = await service.propose('root', input())
  expect(proposal.state).toBe('review')
  expect(created).toBe(0)
  service = new SessionCollaborationService(deps)
  await service.recover()
  expect((await service.listBatches('root'))[0]).toEqual(proposal)
  const launched = await service.confirmBatch('root', proposal.id, proposal.revision)
  expect(launched.state).toBe('launched')
  expect(created).toBe(2)
  expect(started).toHaveLength(2)
  await service.confirmBatch('root', proposal.id, proposal.revision)
  expect(started).toHaveLength(2)
  expect(await service.propose('root', input())).toEqual(launched)
})

test('only verified explicit selection bypasses review; ambiguous resolution remains editable', async () => {
  const explicit = { requestId: 'explicit', sessions: [{ prompt: 'do work', runtime, userInstruction: { messageId: 'real-user', quote: 'use provider-a same-model' } }] }
  expect((await service.propose('root', explicit)).state).toBe('launched')
  expect((await service.propose('root', { ...explicit, requestId: 'fake', sessions: [{ ...explicit.sessions[0]!, userInstruction: { messageId: 'fake', quote: 'use provider-a same-model' } }] })).state).toBe('review')
  deps.models!.resolve = async () => { throw new Error('Model name matches two providers') }
  const ambiguous = await service.propose('root', { requestId: 'ambiguous', sessions: [{ prompt: 'task', model: 'same-model' }] })
  expect(ambiguous.state).toBe('review')
  expect(ambiguous.sessions[0]?.error).toContain('two providers')
  await expect(service.confirmBatch('root', ambiguous.id, ambiguous.revision)).rejects.toThrow('Choose a model')
  const updated = await service.updateBatch('root', ambiguous.id, ambiguous.revision, [{ id: '1', runtime }])
  await expect(service.confirmBatch('root', updated.id, ambiguous.revision)).rejects.toThrow('changed')
  expect((await service.confirmBatch('root', updated.id, updated.revision)).state).toBe('launched')
})

test('partial creation failure holds every child and retries only definite failures', async () => {
  const original = deps.sessions.create
  let fail = true
  deps.sessions.create = async (...args) => { if (created === 1 && fail) throw new Error('workspace failure'); return original(...args) }
  const batch = await service.propose('root', input())
  const failed = await service.confirmBatch('root', batch.id, batch.revision)
  expect(failed.state).toBe('failed')
  expect(created).toBe(1)
  expect(started).toHaveLength(0)
  fail = false
  expect((await service.confirmBatch('root', batch.id, failed.revision)).state).toBe('launched')
  expect(created).toBe(2)
  expect(started).toHaveLength(2)
})

test('cancellation and group Stop prevent deferred proposal launch', async () => {
  const batch = await service.propose('root', input())
  await service.cancelBatch('root', batch.id, batch.revision)
  await expect(service.confirmBatch('root', batch.id, 2)).rejects.toThrow('cannot be started')
  const next = await service.propose('root', { ...input(), requestId: 'next' })
  await service.stopGroup('root')
  await service.resume('root')
  await expect(service.confirmBatch('root', next.id, next.revision)).rejects.toThrow('stopped')
  expect(created).toBe(0)
})

test('after-turn change waits for completion and never creates a continuation for finished work', async () => {
  const child = await service.create('root', { prompt: 'work', runtime })
  await service.onMessageConsumed(child.messageId)
  const pending = await service.changeModels('root', { requestId: 'change', selections: [{ sessionId: child.sessionId, runtime: { ...runtime, modelId: 'better' } }] })
  expect(pending.state).toBe('pending')
  expect(applied).toEqual([])
  await service.onSessionState(child.sessionId, 'completed', 'done')
  expect(applied).toEqual([child.sessionId])
  expect((await service.listModelChanges('root'))[0]?.state).toBe('applied')
  expect(started.filter(message => message.targetSessionId === child.sessionId)).toHaveLength(1)
})

test('immediate change continues consumed work with a fresh id exactly once', async () => {
  const child = await service.create('root', { prompt: 'write file once', runtime })
  await service.onMessageConsumed(child.messageId)
  const change = { requestId: 'change', mode: 'immediate' as const, selections: [{ sessionId: child.sessionId, runtime }] }
  expect((await service.changeModels('root', change)).state).toBe('applied')
  await service.changeModels('root', change)
  const messages = (await service.status()).messages.filter(message => message.targetSessionId === child.sessionId)
  expect(messages).toHaveLength(2)
  expect(messages[0]?.status).toBe('consumed')
  expect(messages[1]?.content).toContain('do not repeat completed actions')
  expect(messages[1]?.id).not.toBe(child.messageId)
})

test('failed batch switch keeps every child paused without continuation', async () => {
  const first = await service.create('root', { prompt: 'one', runtime })
  const second = await service.create('root', { prompt: 'two', runtime })
  await service.onMessageConsumed(first.messageId); await service.onMessageConsumed(second.messageId)
  deps.runtime.apply = async id => { if (id === second.sessionId) throw new Error('apply failed'); applied.push(id) }
  const change = await service.changeModels('root', { requestId: 'change', mode: 'immediate', selections: [first, second].map(item => ({ sessionId: item.sessionId, runtime })) })
  expect(change.state).toBe('failed')
  expect((await service.status()).members.filter(member => member.parentSessionId).every(member => member.stopped)).toBe(true)
  expect((await service.status()).messages).toHaveLength(2)
})

test('migration of an old fixture preserves unknown fields and has empty delegation collections', async () => {
  await writeFile(deps.statePath, JSON.stringify({ revision: 1, members: {}, messages: [], future: { keep: true } }))
  service = new SessionCollaborationService(deps)
  await service.recover()
  expect(await service.listBatches('root')).toEqual([])
  expect(await service.listModelChanges('root')).toEqual([])
  await service.propose('root', input())
  expect(JSON.parse(await readFile(deps.statePath, 'utf8')).future).toEqual({ keep: true })
})

test('pending change cancellation and retry identity are strict', async () => {
  const child = await service.create('root', { prompt: 'work', runtime })
  const change = await service.changeModels('root', { requestId: 'change', selections: [{ sessionId: child.sessionId, runtime }] })
  await service.cancelModelChange('root', change.id, change.revision)
  await service.onSessionState(child.sessionId, 'completed')
  expect(applied).toEqual([])
  await expect(service.changeModels('root', { requestId: 'change', resume: false, selections: [{ sessionId: child.sessionId, runtime }] })).rejects.toThrow('different input')
})

test('mixed proposal starts explicit rows and cancellation leaves them running', async () => {
  const batch = await service.propose('root', { requestId: 'mixed', sessions: [
    { prompt: 'explicit work', runtime, userInstruction: { messageId: 'real-user', quote: 'use provider-a same-model' } },
    { prompt: 'review work' },
  ] })
  expect(batch.state).toBe('review')
  expect(batch.sessions[0]?.launched).toBe(true)
  expect(created).toBe(1)
  await service.cancelBatch('root', batch.id, batch.revision)
  expect((await service.status()).messages[0]?.status).toBe('accepted')
  expect(created).toBe(1)
})

test('group Stop during runtime apply never releases the paused group', async () => {
  const child = await service.create('root', { prompt: 'work', runtime })
  await service.onMessageConsumed(child.messageId)
  deps.runtime.apply = async () => { await service.stopGroup('root') }
  const result = await service.changeModels('root', { requestId: 'change', mode: 'immediate', selections: [{ sessionId: child.sessionId, runtime }] })
  expect(result.state).toBe('applied')
  expect((await service.status()).members.find(member => member.sessionId === child.sessionId)?.stopped).toBe(true)
  expect((await service.status()).messages).toHaveLength(1)
})

test('manual input cannot enter the runtime preparation barrier', async () => {
  const child = await service.create('root', { prompt: 'work', runtime })
  deps.runtime.apply = async () => { await expect(service.admitUserTurn(child.sessionId)).rejects.toThrow('Model change in progress') }
  expect((await service.changeModels('root', { requestId: 'change', mode: 'immediate', selections: [{ sessionId: child.sessionId, runtime }] })).state).toBe('applied')
})

test('dispatch revalidates pinned runtime without silently changing provider', async () => {
  deps.models!.validate = async () => { throw new Error('provider removed') }
  const child = await service.create('root', { prompt: 'work', runtime })
  expect(child.state).toBe('failed')
  expect(started.filter(message => message.targetSessionId === child.sessionId)).toHaveLength(0)
  expect((await service.status()).members.find(member => member.sessionId === child.sessionId)?.runtime).toEqual(runtime)
})

test('save paused runtime then resume preserves one interrupted-task continuation', async () => {
  const child = await service.create('root', { prompt: 'work', runtime })
  await service.onMessageConsumed(child.messageId)
  await service.changeModels('root', { requestId: 'pause', mode: 'immediate', resume: false, selections: [{ sessionId: child.sessionId, runtime }] })
  expect((await service.status()).messages).toHaveLength(1)
  service = new SessionCollaborationService(deps)
  await service.recover()
  await service.changeModels('root', { requestId: 'continue', mode: 'immediate', selections: [{ sessionId: child.sessionId, runtime }] })
  expect((await service.status()).messages.filter(message => message.targetSessionId === child.sessionId)).toHaveLength(2)
  await service.resume(child.sessionId)
  expect((await service.status()).messages.filter(message => message.targetSessionId === child.sessionId)).toHaveLength(2)
})

test('created but unlaunched task can replace invalid runtime without recreating its session', async () => {
  const batch = await service.propose('root', { requestId: 'batch', sessions: [{ prompt: 'work' }] })
  let validations = 0
  deps.models!.validate = async selection => { if (++validations === 2) throw new Error('provider vanished'); return selection }
  const failed = await service.confirmBatch('root', batch.id, batch.revision)
  expect(failed.state).toBe('failed')
  expect(created).toBe(1)
  const nextRuntime = { ...runtime, providerId: 'provider-b' }
  const updated = await service.updateBatch('root', batch.id, failed.revision, [{ id: '1', runtime: nextRuntime }])
  const launched = await service.confirmBatch('root', batch.id, updated.revision)
  expect(launched.state).toBe('launched')
  expect(created).toBe(1)
  expect(applied).toEqual(['child-1'])
  expect((await service.status()).members.find(member => member.sessionId === 'child-1')?.runtime).toEqual(nextRuntime)
})

test('after-turn terminal notification does not override a still-running runtime', async () => {
  const child = await service.create('root', { prompt: 'work', runtime })
  deps.runtime.getState = () => 'running'
  await service.changeModels('root', { requestId: 'change', selections: [{ sessionId: child.sessionId, runtime }] })
  await service.onSessionState(child.sessionId, 'completed')
  expect(applied).toEqual([])
  expect((await service.listModelChanges('root'))[0]?.state).toBe('pending')
  deps.runtime.getState = () => 'idle'
  await service.processPendingModelChanges()
  expect(applied).toEqual([child.sessionId])
})

test('pending after-turn selection holds new messages until applied', async () => {
  const child = await service.create('root', { prompt: 'work', runtime })
  await service.onMessageConsumed(child.messageId)
  await service.changeModels('root', { requestId: 'change', selections: [{ sessionId: child.sessionId, runtime }] })
  await service.send('root', child.sessionId, 'next work', 'next-message')
  expect(started.filter(message => message.id === 'next-message')).toHaveLength(0)
  await service.onSessionState(child.sessionId, 'completed')
  expect(applied).toEqual([child.sessionId])
  expect(started.filter(message => message.id === 'next-message')).toHaveLength(1)
})

test('Stop followed by new input fences a proposal still resolving models', async () => {
  let entered!: () => void; let release!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  deps.models!.resolve = async () => { entered(); await gate; return runtime }
  const pending = service.propose('root', { requestId: 'late', sessions: [{ prompt: 'old work', runtime, userInstruction: { messageId: 'real-user', quote: 'use provider-a same-model' } }] })
  await ready
  await service.stopGroup('root'); await service.onUserInput('root')
  release()
  await expect(pending).rejects.toThrow('stopped')
  expect(created).toBe(0)
  expect(await service.listBatches('root')).toEqual([])
})

test('Stop followed by new input fences a model change still validating', async () => {
  const child = await service.create('root', { prompt: 'work', runtime })
  await service.onMessageConsumed(child.messageId)
  let entered!: () => void; let release!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  deps.models!.validate = async selection => { entered(); await gate; return selection }
  const pending = service.changeModels('root', { requestId: 'late', mode: 'immediate', selections: [{ sessionId: child.sessionId, runtime }] })
  await ready
  await service.stopGroup('root'); await service.onUserInput('root')
  release()
  await expect(pending).rejects.toThrow('stopped')
  expect(applied).toEqual([])
  expect(await service.listModelChanges('root')).toEqual([])
})

test('mixed explicit row cannot start after Stop during its final validation', async () => {
  let entered!: () => void; let release!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  deps.models!.validate = async selection => { entered(); await gate; return selection }
  const pending = service.propose('root', { requestId: 'mixed-late', sessions: [
    { prompt: 'explicit work', runtime, userInstruction: { messageId: 'real-user', quote: 'use provider-a same-model' } },
    { prompt: 'review work' },
  ] })
  await ready
  await service.stopGroup('root'); await service.onUserInput('root')
  release()
  const batch = await pending
  expect(batch.sessions[0]?.error).toContain('stopped')
  expect(created).toBe(0)
})

test('manual Stop cancels a pending turn-boundary change and cannot revive queued work', async () => {
  const child = await service.create('root', { prompt: 'work', runtime })
  await service.onMessageConsumed(child.messageId)
  const change = await service.changeModels('root', { requestId: 'pending-stop', selections: [{ sessionId: child.sessionId, runtime }] })
  await service.send('root', child.sessionId, 'later work', 'later-work')
  await service.onStopped(child.sessionId)
  await service.onSessionState('root', 'completed', 'done')
  expect((await service.listModelChanges('root')).find(item => item.id === change.id)?.state).toBe('cancelled')
  expect((await service.status()).members.find(item => item.sessionId === child.sessionId)?.stopped).toBe(true)
  expect(started.some(item => item.id === 'later-work')).toBe(false)
  expect(applied).toEqual([])
  const admission = await service.admitUserTurn(child.sessionId)
  await admission.release()
})

for (const differentInput of [false, true]) test(`concurrent model-change request identity is preserved (different input: ${differentInput})`, async () => {
  const child = await service.create('root', { prompt: 'work', runtime })
  await service.onMessageConsumed(child.messageId)
  let entered!: () => void; let release!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  let validations = 0
  deps.models!.validate = async selection => {
    if (++validations === 1) { entered(); await gate }
    return selection
  }
  const input = { requestId: 'concurrent', mode: 'immediate' as const, selections: [{ sessionId: child.sessionId, runtime }] }
  const slow = service.changeModels('root', input)
  await ready
  const winner = await service.changeModels('root', differentInput ? { ...input, resume: false } : input)
  release()
  if (differentInput) await expect(slow).rejects.toThrow('different input')
  else expect(await slow).toEqual(winner)
  expect(applied).toEqual([child.sessionId])
  expect((await service.status()).messages.filter(item => item.kind === 'message')).toHaveLength(differentInput ? 0 : 1)
  expect((await service.listModelChanges('root'))[0]).toEqual(winner)
})

test('successful runtime repair retries a queued assignment with a previous dispatch error', async () => {
  deps.models!.validate = async () => { throw Object.assign(new Error('provider vanished'), { code: 'PROVIDER_UNAVAILABLE' }) }
  const child = await service.create('root', { prompt: 'work', runtime })
  expect(child.state).toBe('failed')
  expect(child.errorCode).toBe('PROVIDER_UNAVAILABLE')
  expect(started.filter(item => item.targetSessionId === child.sessionId)).toHaveLength(0)
  deps.models!.validate = async selection => selection
  const changed = await service.changeModels('root', { requestId: 'repair', mode: 'immediate', resume: true, selections: [{ sessionId: child.sessionId, runtime: { ...runtime, providerId: 'replacement' } }] })
  expect(changed.state).toBe('applied')
  expect(started.filter(item => item.id === child.messageId)).toHaveLength(1)
  const message = (await service.status()).messages.find(item => item.id === child.messageId)
  expect(message?.status).toBe('accepted')
  expect(message?.error).toBeUndefined()
  expect(message?.errorCode).toBeUndefined()
})

test('manual child Stop fences a model change still validating before persistence', async () => {
  const child = await service.create('root', { prompt: 'work', runtime })
  await service.onMessageConsumed(child.messageId)
  let entered!: () => void; let release!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  deps.models!.validate = async selection => { entered(); await gate; return selection }
  const pending = service.changeModels('root', { requestId: 'child-stop', mode: 'immediate', selections: [{ sessionId: child.sessionId, runtime }] })
  await ready
  await service.onStopped(child.sessionId)
  release()
  await expect(pending).rejects.toThrow('stopped')
  expect(applied).toEqual([])
  expect(await service.listModelChanges('root')).toEqual([])
  expect((await service.status()).members.find(item => item.sessionId === child.sessionId)?.stopped).toBe(true)
})

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await read()
    if (ready(value)) return value
    await Bun.sleep(5)
  }
  throw new Error('condition was not reached')
}
const uiPost = (path: string, body: unknown) => {
  const url = new URL(`http://localhost/api/session-collaboration/root/${path}`)
  return handleSessionCollaborationUiApi(new Request(url, { method: 'POST', body: JSON.stringify(body) }), url, service)
}

// The dialog closes on the response. It used to arrive only after every
// workspace was created and every CLI had started, with Close ignored meanwhile.
test('UI Start answers once the batch is launching and the launch finishes on its own', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const create = deps.sessions.create
  deps.sessions.create = async (...args) => { await gate; return create(...args) }
  // The batch reads launched before each first message is delivered; a slow
  // start keeps that window open on every machine.
  deps.runtime.start = async (_, message) => { await Bun.sleep(20); started.push(message) }
  const proposal = await service.propose('root', input())
  const response = await uiPost(`batches/${encodeURIComponent(proposal.id)}/confirm`, { expectedRevision: proposal.revision })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ id: proposal.id, state: 'launching' })
  expect(created).toBe(0)
  release()
  await until(async () => started.length, count => count === 2)
  const [launched] = await service.listBatches('root')
  expect(launched?.state).toBe('launched')
  expect(launched?.sessions.every(entry => entry.launched && entry.sessionId)).toBe(true)
})

test('UI Start still refuses a stale revision, and a launch failing later is recorded on the batch', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  deps.sessions.create = async () => { await gate; throw new Error('workspace failure') }
  const proposal = await service.propose('root', input())
  expect((await uiPost(`batches/${encodeURIComponent(proposal.id)}/confirm`, { expectedRevision: proposal.revision + 1 })).status).toBe(409)
  expect((await uiPost(`batches/${encodeURIComponent(proposal.id)}/confirm`, { expectedRevision: proposal.revision })).status).toBe(200)
  release()
  const [failed] = await until(() => service.listBatches('root'), batches => batches[0]?.state === 'failed')
  expect(failed?.error).toContain('workspace failure')
  expect(started).toHaveLength(0)
})

test('UI immediate change answers before running sessions are stopped and restarted', async () => {
  const child = await service.create('root', { prompt: 'work', runtime })
  await service.onMessageConsumed(child.messageId)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  deps.runtime.stopAndWait = async id => { await gate; await service.onStopped(id) }
  const response = await uiPost('model-changes', { requestId: 'ui', mode: 'immediate', selections: [{ sessionId: child.sessionId, runtime: { ...runtime, modelId: 'better' } }] })
  expect(response.status).toBe(200)
  expect(['pending', 'applying']).toContain((await response.json()).state)
  expect(applied).toEqual([])
  release()
  await until(() => service.listModelChanges('root'), changes => changes[0]?.state === 'applied')
  expect(applied).toEqual([child.sessionId])
})
