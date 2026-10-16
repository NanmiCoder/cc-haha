import { afterEach, beforeEach, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { Worker } from 'node:worker_threads'
import {
  commitSearchContentSpool,
  getSearchCommitWorkerForTests,
  setSearchCommitWorkerFactoryForTests,
} from './searchContentCommitWorker.js'
import type { SearchContentSourceWrite } from './searchContentIndex.js'

type JobMessage = { id: number; gate: SharedArrayBuffer }

class ControlledWorker extends EventEmitter {
  messages: JobMessage[] = []
  terminations = 0
  private finishTermination!: (code: number) => void
  private readonly termination = new Promise<number>(resolve => { this.finishTermination = resolve })

  ref() { return this }
  unref() { return this }
  postMessage(message: JobMessage) { this.messages.push(message) }
  terminate() { this.terminations += 1; return this.termination }
  finish() { this.emit('exit', 1); this.finishTermination(1) }
}

const workers: ControlledWorker[] = []
beforeEach(async () => {
  // A preceding file in the single-process coverage universe may have left
  // the production worker idle. Finish it before replacing the factory.
  await getSearchCommitWorkerForTests()?.terminate()
  setSearchCommitWorkerFactoryForTests(() => {
    const worker = new ControlledWorker()
    workers.push(worker)
    return worker as unknown as Worker
  })
})
afterEach(async () => {
  for (const worker of workers) worker.finish()
  await turn()
  workers.length = 0
  setSearchCommitWorkerFactoryForTests()
})

async function turn() {
  for (let index = 0; index < 5; index++) await Promise.resolve()
}

function commit(signal?: AbortSignal) {
  // The controlled worker performs no filesystem or provider operations.
  return commitSearchContentSpool({
    databasePath: 'fixture-index.sqlite', spoolPath: 'fixture-spool.sqlite',
    source: {} as SearchContentSourceWrite, append: false, signal,
  })
}

test.each(['complete', 'failed'] as const)('running cancel waits for termination despite an early %s message', async (type) => {
  const controller = new AbortController()
  let settled = false
  const aborted = commit(controller.signal).catch(error => { settled = true; return error })
  await turn()
  const worker = workers[0]!
  const message = worker.messages[0]!
  worker.emit('message', { type: 'started', id: message.id })
  controller.abort()
  expect(worker.terminations).toBe(1)
  worker.emit('message', { type, id: message.id, message: 'finished before thread teardown' })
  await turn()
  expect(settled).toBe(false)
  worker.finish()
  expect((await aborted).name).toBe('AbortError')
})

test('running cancel keeps queued callers and a replacement worker behind termination', async () => {
  const controller = new AbortController()
  let firstSettled = false
  let queuedSettled = false
  const first = commit(controller.signal).catch(error => { firstSettled = true; return error })
  const queued = commit().catch(error => { queuedSettled = true; return error })
  await turn()
  const worker = workers[0]!
  worker.emit('message', { type: 'started', id: worker.messages[0]!.id })
  controller.abort()
  const next = commit().catch(error => error)
  await turn()
  expect(firstSettled).toBe(false)
  expect(queuedSettled).toBe(false)
  expect(workers).toHaveLength(1)
  worker.finish()
  expect((await first).name).toBe('AbortError')
  expect((await queued).message).toBe('Search commit worker restarted')
  await turn()
  const replacement = workers[1]!
  replacement.emit('message', { type: 'complete', id: replacement.messages[0]!.id })
  await next
})

test('an exit event alone cannot create a replacement before terminate resolves', async () => {
  const controller = new AbortController()
  let settled = false
  const aborted = commit(controller.signal).catch(error => { settled = true; return error })
  await turn()
  const worker = workers[0]!
  worker.emit('message', { type: 'started', id: worker.messages[0]!.id })
  controller.abort()
  worker.emit('exit', 1)
  const next = commit().catch(error => error)
  await turn()
  expect(settled).toBe(false)
  expect(workers).toHaveLength(1)
  worker.finish()
  expect((await aborted).name).toBe('AbortError')
  await turn()
  const replacement = workers[1]!
  replacement.emit('message', { type: 'complete', id: replacement.messages[0]!.id })
  await next
})

test('worker errors keep callers and replacements behind termination', async () => {
  let settled = false
  const failed = commit().catch(error => { settled = true; return error })
  await turn()
  const worker = workers[0]!
  worker.emit('error', new Error('fixture worker crash'))
  const next = commit().catch(error => error)
  await turn()
  expect(settled).toBe(false)
  expect(workers).toHaveLength(1)
  worker.finish()
  expect((await failed).message).toBe('fixture worker crash')
  await turn()
  const replacement = workers[1]!
  replacement.emit('message', { type: 'complete', id: replacement.messages[0]!.id })
  await next
})

test('a caller aborted while waiting for retirement never creates a replacement', async () => {
  const controller = new AbortController()
  const first = commit(controller.signal).catch(error => error)
  await turn()
  const worker = workers[0]!
  worker.emit('message', { type: 'started', id: worker.messages[0]!.id })
  controller.abort()
  const waitingController = new AbortController()
  const waiting = commit(waitingController.signal).catch(error => error)
  const reason = new Error('cancelled while waiting for teardown')
  waitingController.abort(reason)
  worker.finish()
  expect((await first).name).toBe('AbortError')
  expect(await waiting).toBe(reason)
  expect(workers).toHaveLength(1)
})

test('retirement cancels claimed and pending gates before stopping the worker once', async () => {
  const controller = new AbortController()
  const first = commit(controller.signal).catch(error => error)
  let claimedSettled = false
  const claimed = commit().catch(error => { claimedSettled = true; return error })
  const pending = commit().catch(error => error)
  await turn()
  const worker = workers[0]!
  worker.emit('message', { type: 'started', id: worker.messages[0]!.id })
  // The worker may finish the first job and claim the second before the main
  // thread sees its completion. A cancelled claim must wake its Atomics.wait.
  const claimedGate = new Int32Array(worker.messages[1]!.gate)
  Atomics.store(claimedGate, 0, 3)
  const notify = Atomics.notify
  const notifications: Int32Array[] = []
  Atomics.notify = ((gate: Int32Array, index: number, count?: number) => {
    notifications.push(gate)
    return notify(gate, index, count)
  }) as typeof Atomics.notify
  try { controller.abort() } finally { Atomics.notify = notify }
  worker.emit('error', new Error('worker failed during cancellation'))
  expect(worker.terminations).toBe(1)
  for (const message of worker.messages) expect(Atomics.load(new Int32Array(message.gate), 0)).toBe(2)
  expect(notifications.map(gate => gate.buffer)).toContain(claimedGate.buffer)
  await turn()
  expect(claimedSettled).toBe(false)
  worker.finish()
  expect((await first).name).toBe('AbortError')
  expect((await claimed).message).toBe('Search commit worker restarted')
  expect((await pending).message).toBe('Search commit worker restarted')
})

test('the factory cannot change while an idle worker retires without active jobs', async () => {
  const warm = commit()
  await turn()
  const worker = workers[0]!
  worker.emit('message', { type: 'complete', id: worker.messages[0]!.id })
  await warm
  worker.emit('error', new Error('idle worker failed'))
  expect(() => setSearchCommitWorkerFactoryForTests()).toThrow('Cannot replace an active search commit worker')
  worker.finish()
  await turn()
})
