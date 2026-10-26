import { expect, test } from 'bun:test'
import { Drafts } from '../../state/storage'
import {
  canFlushQueue,
  clearParkedComposer,
  parkComposer,
  parkedComposer,
  queueAttachments,
  queuePauseReason,
  queueToDraft,
  withdrawQueuedComposer,
  type ComposerQueueState,
  type QueueGate,
} from './queue'

const idle: QueueGate = {
  ready: true,
  turnActive: false,
  waitingForDecision: false,
  pendingUser: false,
  configPending: false,
  workspaceMissing: false,
  lastTurnFailed: false,
  deliveryUncertain: false,
}

test('queued follow-ups wait until the turn and every pending decision are finished', () => {
  expect(canFlushQueue(idle)).toBe(true)
  expect(queuePauseReason(idle)).toBe('')
  for (const key of [
    'turnActive',
    'waitingForDecision',
    'pendingUser',
    'configPending',
    'workspaceMissing',
  ] as const) {
    expect(canFlushQueue({ ...idle, [key]: true })).toBe(false)
    // Still busy: no pause message, it simply keeps waiting.
    expect(queuePauseReason({ ...idle, [key]: true })).toBe('')
  }
  expect(canFlushQueue({ ...idle, ready: false })).toBe(false)
})

test('a failed turn or an unconfirmed send pauses the queue instead of sending on top of it', () => {
  expect(canFlushQueue({ ...idle, lastTurnFailed: true })).toBe(false)
  expect(queuePauseReason({ ...idle, lastTurnFailed: true })).toBe('上一轮出错了，排队的消息先不发')
  expect(canFlushQueue({ ...idle, deliveryUncertain: true })).toBe(false)
  expect(queuePauseReason({ ...idle, deliveryUncertain: true })).toBe('上一条没确认送达，排队的消息先不发')
  // While the failed turn is somehow still active, it is not a pause yet.
  expect(queuePauseReason({ ...idle, lastTurnFailed: true, turnActive: true })).toBe('')
})

test('stopping or leaving returns queued text to the draft in order instead of sending it', () => {
  expect(queueToDraft('', [])).toBe('')
  expect(queueToDraft('还在写', [{ text: '先跑测试' }, { text: ' 再补文档 ' }])).toBe(
    '先跑测试\n\n再补文档\n\n还在写'
  )
  expect(queueToDraft('  ', [{ text: '只有排队的' }])).toBe('只有排队的')
})

test('queued attachments come back ahead of the ones still in the composer', () => {
  const a = { kind: 'file', name: 'a.txt' } as never
  const b = { kind: 'file', name: 'b.txt' } as never
  expect(queueAttachments([{ attachments: [a] }], [b])).toEqual([a, b])
})

test('attachments and the team switch survive leaving the page until the page takes them back', () => {
  const a = { kind: 'file', name: 'a.txt' } as never
  parkComposer('h:s', { attachments: [a], team: true })
  // Reading twice (React may run initializers twice in development) returns the same value.
  expect(parkedComposer('h:s')).toEqual({ attachments: [a], team: true })
  expect(parkedComposer('h:s')).toEqual({ attachments: [a], team: true })
  clearParkedComposer('h:s')
  expect(parkedComposer('h:s')).toBeUndefined()
  parkComposer('h:s', { attachments: [], team: false })
  expect(parkedComposer('h:s')).toBeUndefined()
})

test('a blurred chat cannot send a queued follow-up when the running turn finishes', () => {
  expect(canFlushQueue(idle, false)).toBe(false)
  expect(canFlushQueue(idle, true)).toBe(true)
})

const queuedComposer = (): ComposerQueueState => ({
  queue: [{
    id: 'one',
    text: 'QA-queue-stop',
    attachments: [{ kind: 'file', name: 'qa.txt' } as never],
    team: true,
    message: { type: 'user_message', content: 'QA-queue-stop' },
  }],
  draft: '还在写',
  attachments: [],
  team: false,
})

test('stop or withdraw saves the restored draft before leaving and reentering the chat', () => {
  const drafts = new Drafts()
  const key = 'stop-regression:session'
  const restored = withdrawQueuedComposer(key, queuedComposer(), drafts)
  expect(restored.queue).toEqual([])
  expect(restored.draft).toBe('QA-queue-stop\n\n还在写')
  // A later blur/unmount has no queue left. The next screen still receives the restored draft.
  expect(withdrawQueuedComposer(key, restored, drafts)).toBe(restored)
  expect(drafts.get(key)).toBe(restored.draft)
  expect(parkedComposer(key)).toEqual({ attachments: restored.attachments, team: true })
  clearParkedComposer(key)
})

test('withdrawing one message preserves the remaining queue and does not duplicate restored material', () => {
  const drafts = new Drafts()
  const key = 'partial-withdraw:session'
  const initial = queuedComposer()
  initial.queue.push({ ...initial.queue[0]!, id: 'two', text: 'second', attachments: [], team: false })
  const first = withdrawQueuedComposer(key, initial, drafts, ['one'])
  expect(first.queue.map((item) => item.id)).toEqual(['two'])
  expect(drafts.get(key)).toBe('QA-queue-stop\n\n还在写')
  const leaving = withdrawQueuedComposer(key, first, drafts)
  expect(leaving.queue).toEqual([])
  expect(drafts.get(key)).toBe('second\n\nQA-queue-stop\n\n还在写')
  expect(parkedComposer(key)?.attachments).toHaveLength(1)
  expect(withdrawQueuedComposer(key, leaving, drafts)).toBe(leaving)
  clearParkedComposer(key)
})

test('editing or clearing a restored composer before blur replaces its parked contents', () => {
  const drafts = new Drafts()
  const key = 'edited-restored:session'
  const restored = withdrawQueuedComposer(key, queuedComposer(), drafts)
  withdrawQueuedComposer(key, { ...restored, draft: 'new text', attachments: [], team: false }, drafts)
  expect(drafts.get(key)).toBe('new text')
  expect(parkedComposer(key)).toBeUndefined()
  withdrawQueuedComposer(key, { ...restored, draft: '', attachments: [], team: false }, drafts)
  expect(drafts.get(key)).toBeUndefined()
  expect(parkedComposer(key)).toBeUndefined()
})

test('withdrawing queued skills restores selection chips and plain draft, not model instructions', () => {
  const reference = { kind: 'skill' as const, id: 'review', name: 'review', displayName: '审查', description: '', modelText: 'Use the Skill tool with skill: "review" for this request.' }
  const drafts = { set: () => {}, delete: () => {} }
  const next = withdrawQueuedComposer('skill-restore', {
    queue: [{ id: 'q', text: '检查代码', attachments: [], team: false, references: [reference], message: { type: 'user_message', content: `${reference.modelText}\n\n检查代码` } }],
    draft: '还有测试', attachments: [], team: false, references: [reference],
  }, drafts)
  expect(next.draft).toBe('检查代码\n\n还有测试')
  expect(next.references).toEqual([reference])
  expect(parkedComposer('skill-restore')?.references).toEqual([reference])
  clearParkedComposer('skill-restore')
})
