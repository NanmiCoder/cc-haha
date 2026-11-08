import { afterEach, expect, test } from 'bun:test'
import { conversationService } from './conversationService.js'
import { getPowerActivitySnapshot } from './powerActivityRuntime.js'

const sessions = (conversationService as unknown as { sessions: Map<string, ReturnType<typeof runtime>['session']> }).sessions
const cleanups: Array<() => Promise<void>> = []

function runtime(id: string) {
  let resolve!: (code: number) => void
  const session = {
    proc: { exitCode: null as number | null, exited: new Promise<number>(done => { resolve = done }) },
    pendingPermissionRequests: new Map(), outputCallbacks: [], sdkMessages: [], sdkMessageBytes: 0,
    seenSdkMessageUuids: new Set<string>(),
  }
  sessions.set(id, session)
  const exit = async () => { session.proc.exitCode = 0; resolve(0); await session.proc.exited; await Promise.resolve() }
  cleanups.push(async () => { await exit(); if (sessions.get(id) === session) sessions.delete(id) })
  return { session, exit }
}

function activity(id: string, generation: string, active: boolean, uuid = crypto.randomUUID()) {
  const message = { type: 'system', subtype: 'prompt_suggestion_activity', generation_id: generation, active, uuid, session_id: id }
  conversationService.handleSdkPayload(id, JSON.stringify(message))
  return message
}

afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

test('prediction ownership changes authoritative power activity without manufacturing a completion', async () => {
  runtime('prediction-power')
  const initial = await getPowerActivitySnapshot()
  expect(initial.busy).toBe(false)
  const start = activity('prediction-power', 'first', true)
  const running = await getPowerActivitySnapshot()
  expect(running.busy).toBe(true)
  expect(running.revision).toBeGreaterThan(initial.revision)
  activity('prediction-power', 'first', true)
  expect(await getPowerActivitySnapshot()).toEqual(running)
  activity('prediction-power', 'first', false)
  const finished = await getPowerActivitySnapshot()
  expect(finished.busy).toBe(false)
  expect(finished.revision).toBeGreaterThan(running.revision)
  expect(finished.completionSequence).toBe(initial.completionSequence)
  expect(finished.scheduledCompletionSequence).toBe(initial.scheduledCompletionSequence)
  conversationService.handleSdkPayload('prediction-power', JSON.stringify(start))
  expect(await getPowerActivitySnapshot()).toEqual(finished)
})

test('old generations and another session cannot release a replacement prediction', async () => {
  runtime('prediction-a')
  runtime('prediction-b')
  activity('prediction-a', 'old', true)
  activity('prediction-a', 'new', true)
  activity('prediction-b', 'new', true)
  activity('prediction-a', 'old', false)
  expect((await getPowerActivitySnapshot()).busy).toBe(true)
  activity('prediction-a', 'new', false)
  expect((await getPowerActivitySnapshot()).busy).toBe(true)
  activity('prediction-b', 'new', false)
  expect((await getPowerActivitySnapshot()).busy).toBe(false)
})

test('retiring a runtime retains its work until real exit and cannot clear its replacement', async () => {
  const old = runtime('prediction-restart')
  activity('prediction-restart', 'old', true)
  sessions.delete('prediction-restart')
  expect((await getPowerActivitySnapshot()).busy).toBe(true)
  const replacement = runtime('prediction-restart')
  activity('prediction-restart', 'new', true)
  await old.exit()
  expect((await getPowerActivitySnapshot()).busy).toBe(true)
  await replacement.exit()
  expect((await getPowerActivitySnapshot()).busy).toBe(false)
  activity('prediction-restart', 'late-after-exit', true)
  expect((await getPowerActivitySnapshot()).busy).toBe(false)
})

test('a malformed terminal frame cannot make an active generation idle', async () => {
  runtime('prediction-malformed')
  activity('prediction-malformed', 'owned', true)
  for (const fields of [{ active: 'false' }, { generation_id: null }, { generation_id: '' }]) {
    conversationService.handleSdkPayload('prediction-malformed', JSON.stringify({
      type: 'system', subtype: 'prompt_suggestion_activity', generation_id: 'owned', active: false, ...fields,
    }))
    expect((await getPowerActivitySnapshot()).busy).toBe(true)
  }
  activity('prediction-malformed', 'owned', false)
  expect((await getPowerActivitySnapshot()).busy).toBe(false)
})
