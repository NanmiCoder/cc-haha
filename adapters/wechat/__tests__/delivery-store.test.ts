import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeliveryCapacityError, WechatDeliveryStore, wechatBindingKey } from '../delivery-store.js'

const directories: string[] = []
const stores: WechatDeliveryStore[] = []
function fixture(options: { bindingKey?: string; maxRows?: number; maxPayloadBytes?: number; now?: () => number; path?: string } = {}) {
  const directory = options.path ? undefined : mkdtempSync(join(tmpdir(), 'wechat-delivery-'))
  if (directory) directories.push(directory)
  const path = options.path ?? join(directory!, 'delivery.sqlite')
  const store = new WechatDeliveryStore({ path, bindingKey: 'fixture-binding', ...options })
  stores.push(store)
  return { store, path }
}
function close(store: WechatDeliveryStore) {
  store.close()
  stores.splice(stores.indexOf(store), 1)
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
const incoming = (messageKey: string, chatId = 'fixture-user') => ({ messageKey, chatId, payload: { text: `message-${messageKey}` } })

describe('WeChat durable delivery journal', () => {
  it('persists cursor and unsubmitted inputs atomically, deduplicating a replayed batch', () => {
    const { store, path } = fixture()
    expect(store.ingestBatch([incoming('one'), incoming('two')], 'cursor-1')).toEqual(['one', 'two'])
    close(store)
    const reopened = fixture({ path }).store
    expect(reopened.getCursor()).toBe('cursor-1')
    expect(reopened.ingestBatch([incoming('one')], 'cursor-2')).toEqual([])
    expect(reopened.pendingInbound().map(row => row.messageKey)).toEqual(['one', 'two'])
    expect(reopened.getCursor()).toBe('cursor-2')
  })

  it('rolls back the entire batch and cursor when bounded capacity is exhausted', () => {
    const { store } = fixture({ maxRows: 2 })
    store.ingestBatch([incoming('one')], 'known-cursor')
    expect(() => store.ingestBatch([incoming('two'), incoming('three')], 'lost-cursor')).toThrow('journal is full')
    expect(store.getCursor()).toBe('known-cursor')
    expect(store.pendingInbound().map(row => row.messageKey)).toEqual(['one'])
    expect(store.ingestBatch([incoming('one')], 'same-message-next-cursor')).toEqual([])
  })

  it('reclaims only the oldest sent receipt to admit work without losing inbound dedup', () => {
    let now = 1000
    const { store } = fixture({ maxRows: 4, now: () => now++ })
    store.ingestBatch([incoming('completed-inbound')], 'known-cursor')
    store.finishInbound('completed-inbound')
    const oldest = store.stageText({ chatId: 'fixture-user', text: 'old sent' })
    store.finishOutbound(oldest.replyId, 'sent')
    const recent = store.stageText({ chatId: 'fixture-user', text: 'recent sent' })
    store.finishOutbound(recent.replyId, 'sent')
    const pending = store.stageText({ chatId: 'fixture-user', text: 'not sent' })
    expect(store.ingestBatch([incoming('new-work')], 'new-cursor')).toEqual(['new-work'])
    expect(store.getOutbound(oldest.replyId)).toBeUndefined()
    expect(store.getOutbound(recent.replyId)?.state).toBe('sent')
    expect(store.getOutbound(pending.replyId)?.state).toBe('pending')
    expect(store.ingestBatch([incoming('completed-inbound')], 'next-cursor')).toEqual([])
  })

  it('throws structured JOURNAL_FULL without erasing inbound dedup or failed/unknown work', () => {
    const { store } = fixture({ maxRows: 3 })
    store.ingestBatch([incoming('completed-inbound')], 'known-cursor')
    store.finishInbound('completed-inbound')
    const unknown = store.stageText({ chatId: 'fixture-user', text: 'possibly sent' })
    store.finishOutbound(unknown.replyId, 'unknown')
    const failed = store.stageText({ chatId: 'fixture-user', text: 'failed' })
    store.finishOutbound(failed.replyId, 'failed')
    let failure: unknown
    try { store.ingestBatch([incoming('new')], 'must-not-advance') } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(DeliveryCapacityError)
    expect((failure as DeliveryCapacityError).code).toBe('JOURNAL_FULL')
    expect(store.getCursor()).toBe('known-cursor')
    expect(store.getOutbound(unknown.replyId)?.state).toBe('unknown')
    expect(store.getOutbound(failed.replyId)?.state).toBe('failed')
    expect(store.ingestBatch([incoming('completed-inbound')])).toEqual([])
  })

  it('rolls back receipt eviction as well as new input when admission still exceeds capacity', () => {
    const { store } = fixture({ maxRows: 2 })
    const receipt = store.stageText({ chatId: 'fixture-user', text: 'sent' })
    store.finishOutbound(receipt.replyId, 'sent')
    store.ingestBatch([incoming('existing')], 'known-cursor')
    expect(() => store.ingestBatch([incoming('one'), incoming('two')], 'must-not-advance')).toThrow(DeliveryCapacityError)
    expect(store.getOutbound(receipt.replyId)?.state).toBe('sent')
    expect(store.pendingInbound().map(row => row.messageKey)).toEqual(['existing'])
    expect(store.getCursor()).toBe('known-cursor')
  })

  it('also bounds stored text, context and cursor bytes and preserves prior data on failure', () => {
    const { store } = fixture({ maxPayloadBytes: 40 })
    store.ingestBatch([], 'short')
    expect(() => store.stageText({ chatId: 'fixture-user', text: 'x'.repeat(41) })).toThrow('journal is full')
    expect(() => store.ingestBatch([], 'x'.repeat(41))).toThrow('journal is full')
    expect(store.getCursor()).toBe('short')
    expect(store.listOutbound('fixture-user')).toEqual([])
  })

  it('does not persist unauthorized body or queue it for replay', () => {
    const { store, path } = fixture()
    store.ingestBatch([{ messageKey: 'untrusted', chatId: 'fixture-user', payload: null }], 'cursor')
    expect(store.pendingInbound()).toEqual([])
    const db = new Database(path)
    expect(db.query('SELECT payload, bytes, state FROM inbound').get()).toEqual({ payload: null, bytes: 0, state: 'rejected' })
    db.close()
  })

  it('can journal a live followup after pairing in the same batch, without storing the pairing code', () => {
    const { store } = fixture({ maxPayloadBytes: 40 })
    store.ingestBatch([{ messageKey: 'pair', chatId: 'fixture-user', payload: null }, { messageKey: 'hi', chatId: 'fixture-user', payload: null }])
    expect(() => store.authorizeLiveInput('hi', { text: 'x'.repeat(50) })).toThrow('journal is full')
    expect(store.pendingInbound()).toEqual([])
    expect(store.authorizeLiveInput('hi', { text: 'hello' })).toBe(true)
    expect(store.authorizeLiveInput('hi', { text: 'overwrite' })).toBe(false)
    expect(store.pendingInbound().map(row => row.messageKey)).toEqual(['hi'])
    expect(store.pendingInbound()[0]?.payload).toEqual({ text: 'hello' })
  })

  it('stages all text chunks atomically and leaves no partial response when capacity is exceeded', () => {
    const { store } = fixture({ maxRows: 3 })
    const rows = store.stageTextBatch({ chatId: 'fixture-user', chunks: ['part 1', 'part 2'], contextToken: 'context' })
    expect(rows.map(row => row.text)).toEqual(['part 1', 'part 2'])
    expect(new Set(rows.map(row => row.clientId)).size).toBe(2)
    expect(() => store.stageTextBatch({ chatId: 'fixture-user', chunks: ['part 3', 'part 4'] })).toThrow('journal is full')
    expect(store.listOutbound('fixture-user').length).toBe(2)
  })

  it('rolls back the explicit retry source cancellation if staging the new record fails', () => {
    const { store } = fixture({ maxRows: 1 })
    const previous = store.stageText({ chatId: 'fixture-user', text: 'keep this reply' })
    expect(() => store.cloneTextForRetry(previous.replyId, { chatId: 'fixture-user' })).toThrow('journal is full')
    expect(store.getOutbound(previous.replyId)).toMatchObject({ state: 'pending', text: 'keep this reply' })
  })

  it('isolates cursor, dedup and replies across binding generations', () => {
    const { store, path } = fixture({ bindingKey: wechatBindingKey('account', 'credential-v1') })
    store.ingestBatch([incoming('one')], 'old-cursor')
    const outbound = store.stageText({ chatId: 'fixture-user', text: 'private old reply' })
    const next = fixture({ path, bindingKey: wechatBindingKey('account', 'credential-v2') }).store
    expect(next.getCursor()).toBeUndefined()
    expect(next.pendingInbound()).toEqual([])
    expect(next.getOutbound(outbound.replyId)).toBeUndefined()
    expect(next.ingestBatch([incoming('one')])).toEqual(['one'])
    expect(wechatBindingKey('account', 'credential-v1')).not.toContain('credential')
  })

  it('claims an input once across handles and never replays a crash-interrupted dispatch', () => {
    const { store, path } = fixture()
    store.ingestBatch([incoming('queued'), incoming('submitted')])
    const concurrent = fixture({ path }).store
    expect(store.beginInbound('submitted')).toBe(true)
    expect(concurrent.beginInbound('submitted')).toBe(false)
    close(store)
    expect(concurrent.acquireWorker(100, () => false)).toBe(true)
    expect(concurrent.recoverInterrupted().uncertainInbound).toBe(1)
    expect(concurrent.pendingInbound().map(row => row.messageKey)).toEqual(['queued'])
    expect(concurrent.recoverySummary('fixture-user').uncertain).toBe(1)
    expect(concurrent.finishInbound('submitted')).toBe(false)
  })

  it('preserves stable outbound IDs, records unknown sends, and never resumes a media upload automatically', () => {
    const { store, path } = fixture()
    const pending = store.stageText({ chatId: 'fixture-user', text: 'queued', contextToken: 'old-context' })
    const sending = store.stageText({ chatId: 'fixture-user', text: 'possibly delivered' })
    const media = store.stageMedia({ chatId: 'fixture-user', metadata: { fileName: 'fixture.mp4', sizeBytes: 123 } })
    expect(store.beginOutbound(sending.replyId)).toBe(true)
    expect(store.beginOutbound(sending.replyId)).toBe(false)
    close(store)
    const reopened = fixture({ path }).store
    reopened.acquireWorker(100, () => false)
    expect(reopened.recoverInterrupted()).toEqual({ uncertainInbound: 0, unknownOutbound: 1, failedMedia: 1 })
    expect(reopened.getOutbound(pending.replyId)).toEqual(pending)
    expect(reopened.getOutbound(sending.replyId)?.state).toBe('unknown')
    expect(reopened.getOutbound(media.replyId)?.state).toBe('failed')
    expect(reopened.beginOutbound(sending.replyId)).toBe(false)
  })

  it('explicit text retry requires the same user and replaces stale context with a fresh id', () => {
    const { store } = fixture()
    const original = store.stageText({ chatId: 'fixture-user', text: 'result', contextToken: 'expired' })
    store.beginOutbound(original.replyId)
    store.finishOutbound(original.replyId, 'unknown')
    expect(() => store.cloneTextForRetry(original.replyId, { chatId: 'other-user' })).toThrow('not available')
    const retry = store.cloneTextForRetry(original.replyId, { chatId: 'fixture-user', contextToken: 'fresh' })
    expect(retry.text).toBe('result')
    expect(retry.contextToken).toBe('fresh')
    expect(retry.clientId).not.toBe(original.clientId)
    expect(retry.replyId).not.toBe(original.replyId)
    expect(store.getOutbound(original.replyId)?.state).toBe('cancelled')
    expect(store.getOutbound(original.replyId)?.text).toBeNull()
    expect(() => store.cloneTextForRetry(original.replyId, { chatId: 'fixture-user' })).toThrow('not available')
  })

  it('does not retain sent payloads and refuses to retry sent or media deliveries', () => {
    const { store } = fixture()
    const text = store.stageText({ chatId: 'fixture-user', text: 'result', contextToken: 'private-context' })
    store.beginOutbound(text.replyId)
    store.finishOutbound(text.replyId, 'sent')
    expect(store.getOutbound(text.replyId)).toMatchObject({ state: 'sent', text: null, contextToken: null })
    expect(() => store.cloneTextForRetry(text.replyId, { chatId: 'fixture-user' })).toThrow('not available')
    const media = store.stageMedia({ chatId: 'fixture-user', metadata: { fileName: 'file.pdf' } })
    store.finishOutbound(media.replyId, 'failed')
    expect(() => store.cloneTextForRetry(media.replyId, { chatId: 'fixture-user' })).toThrow('not available')
  })

  it('cancels only the target user, including queued output and uncertain active delivery', () => {
    const { store } = fixture()
    store.ingestBatch([incoming('queued'), incoming('active'), incoming('other', 'other-user')])
    store.beginInbound('active')
    const pending = store.stageText({ chatId: 'fixture-user', text: 'queued' })
    const sending = store.stageText({ chatId: 'fixture-user', text: 'sending' })
    store.beginOutbound(sending.replyId)
    store.cancelChat('fixture-user')
    expect(store.pendingInbound().map(row => row.messageKey)).toEqual(['other'])
    expect(store.getOutbound(pending.replyId)).toMatchObject({ state: 'cancelled', text: null })
    expect(store.getOutbound(sending.replyId)).toMatchObject({ state: 'unknown', text: null })
    expect(store.recoverySummary('fixture-user').uncertain).toBe(1)
  })

  it('can exclude the currently executing stop/new control from cancellation', () => {
    const { store } = fixture()
    store.ingestBatch([incoming('old-work'), incoming('stop-command')])
    store.beginInbound('stop-command')
    store.beginInbound('old-work')
    store.cancelChat('fixture-user', 'stop-command')
    expect(store.finishInbound('stop-command', 'completed')).toBe(true)
    expect(store.recoverySummary('fixture-user')).toMatchObject({ uncertain: 1, dispatching: 0 })
  })

  it('does not cancel a later message in the same poll batch as stop/new', () => {
    const { store } = fixture()
    store.ingestBatch([incoming('old-work'), incoming('new-command'), incoming('after-command')])
    store.beginInbound('old-work')
    store.cancelChat('fixture-user', 'new-command')
    expect(store.pendingInbound().map(row => row.messageKey)).toEqual(['new-command', 'after-command'])
    expect(store.beginInbound('new-command')).toBe(true)
    store.finishInbound('new-command')
    expect(store.beginInbound('after-command')).toBe(true)
    expect(store.recoverySummary('fixture-user')).toMatchObject({ uncertain: 1, dispatching: 1 })
  })

  it('retains active work, prunes successful records after a day and uncertain results after seven days', () => {
    let time = 1000
    const { store } = fixture({ now: () => time })
    store.ingestBatch([incoming('pending'), incoming('done'), incoming('uncertain')])
    store.finishInbound('done')
    store.beginInbound('uncertain')
    store.finishInbound('uncertain', 'uncertain')
    const sent = store.stageText({ chatId: 'fixture-user', text: 'sent' })
    store.finishOutbound(sent.replyId, 'sent')
    const failed = store.stageText({ chatId: 'fixture-user', text: 'failed' })
    store.finishOutbound(failed.replyId, 'failed')
    time += 2 * 86_400_000
    store.prune()
    expect(store.getOutbound(sent.replyId)).toBeUndefined()
    expect(store.getOutbound(failed.replyId)?.state).toBe('failed')
    expect(store.recoverySummary('fixture-user').uncertain).toBe(1)
    time += 6 * 86_400_000
    store.prune()
    expect(store.getOutbound(failed.replyId)).toBeUndefined()
    expect(store.recoverySummary('fixture-user').uncertain).toBe(0)
    expect(store.pendingInbound().map(row => row.messageKey)).toEqual(['pending'])
  })

  it('requires exclusive ownership for recovery and refuses to steal a live worker', () => {
    const { store, path } = fixture()
    const second = fixture({ path }).store
    expect(() => store.recoverInterrupted()).toThrow('exclusive worker lock')
    expect(store.acquireWorker(100, () => false)).toBe(true)
    expect(store.acquireWorker(100, () => true)).toBe(true)
    expect(second.acquireWorker(200, pid => pid === 100)).toBe(false)
    expect(() => second.recoverInterrupted()).toThrow('exclusive worker lock')
    expect(second.acquireWorker(200, () => false)).toBe(true)
    store.releaseWorker()
    expect(second.acquireWorker(200, () => true)).toBe(true)
    expect(() => store.recoverInterrupted()).toThrow('exclusive worker lock')
    second.releaseWorker()
    expect(store.acquireWorker(100, () => true)).toBe(true)
  })

  it('upgrades a version-one journal without losing cursor, queued inputs or unrelated tables', () => {
    const { store, path } = fixture()
    store.ingestBatch([incoming('old')], 'legacy-cursor')
    close(store)
    const legacy = new Database(path)
    legacy.exec("DROP TABLE worker_lock; CREATE TABLE unrelated (value TEXT); INSERT INTO unrelated VALUES ('preserved'); PRAGMA user_version = 1")
    legacy.close()
    const upgraded = fixture({ path }).store
    expect(upgraded.getCursor()).toBe('legacy-cursor')
    expect(upgraded.pendingInbound().map(row => row.messageKey)).toEqual(['old'])
    expect(upgraded.acquireWorker(100, () => false)).toBe(true)
    const verify = new Database(path)
    expect(verify.query('PRAGMA user_version').get()).toEqual({ user_version: 2 })
    expect(verify.query('SELECT value FROM unrelated').get()).toEqual({ value: 'preserved' })
    verify.close()
  })

  it('refuses a future schema instead of overwriting it', () => {
    const { store, path } = fixture()
    close(store)
    const future = new Database(path)
    future.exec('PRAGMA user_version = 3')
    future.close()
    expect(() => fixture({ path })).toThrow('newer version')
    const verify = new Database(path)
    expect(verify.query('PRAGMA user_version').get()).toEqual({ user_version: 3 })
    verify.close()
  })
})
