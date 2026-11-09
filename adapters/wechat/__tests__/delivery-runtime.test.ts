import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WechatDeliveryStore } from '../delivery-store.js'
import { WechatDeliveryRuntime, wechatMessageKey, isWechatStorageError } from '../delivery-runtime.js'

const cleanup: Array<() => void> = []
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn() })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'wx-runtime-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const store = new WechatDeliveryStore({ path: join(dir, 'journal.sqlite'), bindingKey: 'fixture-binding' })
  cleanup.push(() => store.close())
  store.acquireWorker()
  let allowed = true
  const runtime = new WechatDeliveryRuntime(store, () => allowed)
  const message = { from_user_id: 'peer', message_id: 1, item_list: [{ type: 1, text_item: { text: 'fixture task' } }] }
  return { store, runtime, message, revoke: () => { allowed = false }, allow: () => { allowed = true } }
}

describe('WeChat durable dispatch boundary', () => {
  it('classifies fixed storage failures separately without inspecting private error text', () => {
    expect(isWechatStorageError({ code: 'SQLITE_FULL', message: 'private fixture' })).toBe(true)
    expect(isWechatStorageError({ code: 'SQLITE_IOERR_WRITE' })).toBe(true)
    expect(isWechatStorageError({ code: 'ECONNRESET' })).toBe(false)
    expect(isWechatStorageError(new Error('SQLITE_FULL in arbitrary text'))).toBe(false)
  })
  it('promotes a live follow-up in the same batch only after pairing authorized the sender', async () => {
    const { store, runtime, message, revoke, allow } = fixture()
    revoke()
    const followup = { ...message, message_id: 2 }
    runtime.ingest([message, followup])
    await runtime.dispatch(message, async () => { allow() })
    await runtime.dispatch(followup, async () => { expect(runtime.beginCurrent()).toBe(true); runtime.submittedToServer('peer') })
    expect(store.recoverySummary('peer').dispatching).toBe(1)
  })

  it('keeps not-yet-dequeued work recoverable and does not mark the stop command itself uncertain', async () => {
    const { store, runtime, message } = fixture()
    runtime.ingest([message])
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const queued = runtime.dispatch(message, async () => { await gate; runtime.beginCurrent(); runtime.cancel('peer') })
    expect(runtime.pending()).toHaveLength(1)
    release()
    await queued
    expect(store.recoverySummary('peer').uncertain).toBe(0)
  })

  it('never falsely completes overlapping submissions after error followed by completion events', async () => {
    const { store, runtime, message } = fixture()
    const second = { ...message, message_id: 2 }
    runtime.ingest([message, second])
    for (const msg of [message, second]) await runtime.dispatch(msg, async () => { runtime.submittedToServer('peer') })
    runtime.completed('peer', false)
    runtime.completed('peer', true)
    runtime.completed('peer', true)
    expect(store.recoverySummary('peer').uncertain).toBe(2)
  })
  it('deduplicates replay batches and waits for actual completion after socket submission', async () => {
    const { store, runtime, message } = fixture()
    expect(runtime.ingest([message], 'c1')).toHaveLength(1)
    expect(runtime.ingest([message], 'c2')).toHaveLength(0)
    await runtime.dispatch(message, async () => { runtime.submittedToServer('peer') })
    expect(store.recoverySummary('peer').dispatching).toBe(1)
    runtime.completed('peer', true)
    expect(store.recoverySummary('peer').dispatching).toBe(0)
    expect(store.getCursor()).toBe('c2')
  })

  it('does not replay submitted work when completion was not observed before restart', async () => {
    const { store, runtime, message } = fixture()
    runtime.ingest([message], 'c1')
    await runtime.dispatch(message, async () => { runtime.submittedToServer('peer') })
    store.recoverInterrupted()
    expect(runtime.pending()).toHaveLength(0)
    expect(runtime.summary('peer')).toContain('执行结果待核对 1')
  })

  it('persists unstarted work for recovery and does not complete a cancelled task later', async () => {
    const { store, runtime, message } = fixture()
    runtime.ingest([message], 'c1')
    expect(runtime.pending()).toEqual([message])
    await runtime.dispatch(message, async () => { runtime.submittedToServer('peer') })
    runtime.cancel('peer')
    runtime.completed('peer', true)
    expect(store.recoverySummary('peer').uncertain).toBe(1)
  })

  it('does not persist pairing text and permits its one-time live control route', async () => {
    const { runtime, message, revoke } = fixture()
    revoke()
    expect(runtime.ingest([message], 'c1')).toHaveLength(1)
    expect(runtime.pending()).toHaveLength(0)
    let routed = 0
    await runtime.dispatch(message, async () => { routed++ })
    expect(routed).toBe(1)
    expect(runtime.ingest([message])).toHaveLength(0)
  })

  it('keeps a handled execution failure uncertain even if the common queue swallows its error', async () => {
    const { runtime, store, message } = fixture()
    runtime.ingest([message])
    await runtime.dispatch(message, async () => { runtime.failedCurrent() })
    expect(store.recoverySummary('peer').uncertain).toBe(1)
  })

  it('uses sender identity and a content fallback when protocol identifiers are missing', () => {
    expect(wechatMessageKey({ from_user_id: 'a', message_id: 1 })).not.toBe(wechatMessageKey({ from_user_id: 'b', message_id: 1 }))
    const a = { from_user_id: 'peer', item_list: [{ type: 1, text_item: { text: 'one' } }] }
    const b = { from_user_id: 'peer', item_list: [{ type: 1, text_item: { text: 'two' } }] }
    expect(wechatMessageKey(a)).not.toBe(wechatMessageKey(b))
    expect(wechatMessageKey(a)).toBe(wechatMessageKey(a))
  })
})
