import { expect, test } from 'bun:test'
import {
  canFlushQueue,
  clearParkedComposer,
  parkComposer,
  parkedComposer,
  queueAttachments,
  queuePauseReason,
  queueToDraft,
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
