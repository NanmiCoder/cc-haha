import { describe, expect, test } from 'bun:test'
import { consumeSessionMessage, createSessionMessageInbox, sessionMessageInputSchema } from './sessionMessageInbox.js'
import type { QueuedCommand } from '../types/textInputTypes.js'

const message = { subtype: 'enqueue_session_message', message_id: 'stable-message', sender_session_id: 'peer-session', text: '/reset @secret.txt' }

describe('session message inbox', () => {
  test('queues safely, deduplicates and acknowledges only at consumption', () => {
    const queue: QueuedCommand[] = []
    const receipts: unknown[] = []
    const inbox = createSessionMessageInbox(cmd => queue.push(cmd), value => receipts.push(value))
    try {
      expect(inbox.accept(message)).toEqual({ message_id: message.message_id, status: 'queued', duplicate: false })
      expect(inbox.accept(message).duplicate).toBe(true)
      expect(queue).toHaveLength(1)
      expect(queue[0]).toMatchObject({ priority: 'next', isMeta: true, skipSlashCommands: true, origin: { kind: 'channel' } })
      expect(receipts).toHaveLength(0)
      consumeSessionMessage(queue[0]!.uuid!)
      consumeSessionMessage(queue[0]!.uuid!)
      expect(receipts).toHaveLength(1)
      expect(inbox.accept(message)).toMatchObject({ status: 'consumed', duplicate: true })
      expect(() => inbox.accept({ ...message, text: 'changed' })).toThrow('different content')
    } finally { inbox.dispose() }
  })

  test('rejects malformed and oversized payloads, and rolls back failed enqueue', () => {
    expect(sessionMessageInputSchema.safeParse({ ...message, text: '' }).success).toBe(false)
    expect(sessionMessageInputSchema.safeParse({ ...message, text: 'x'.repeat(32_001) }).success).toBe(false)
    let attempts = 0
    const inbox = createSessionMessageInbox(() => { attempts++; throw new Error('queue failure') }, () => {})
    try {
      expect(() => inbox.accept(message)).toThrow('queue failure')
      expect(() => inbox.accept(message)).toThrow('queue failure')
      expect(attempts).toBe(2)
    } finally { inbox.dispose() }
  })

  test('bounds pending messages and cleans up consumption listeners', () => {
    const queue: QueuedCommand[] = []
    const receipts: unknown[] = []
    const inbox = createSessionMessageInbox(cmd => queue.push(cmd), value => receipts.push(value))
    for (let i = 0; i < 50; i++) inbox.accept({ ...message, message_id: String(i) })
    expect(() => inbox.accept({ ...message, message_id: 'overflow' })).toThrow('full')
    inbox.dispose()
    consumeSessionMessage(queue[0]!.uuid!)
    expect(receipts).toHaveLength(0)
  })
})

test('recovered user and queued attachment history prevent replay after restart', async () => {
  const { sessionMessageUuid } = await import('./sessionMessageInbox.js')
  for (const historical of [
    { type: 'user', uuid: sessionMessageUuid(message.message_id) },
    { type: 'attachment', attachment: { type: 'queued_command', source_uuid: sessionMessageUuid(message.message_id) } },
  ]) {
    const queue: QueuedCommand[] = []
    const inbox = createSessionMessageInbox(cmd => queue.push(cmd), () => {}, [historical])
    try {
      expect(inbox.accept(message)).toMatchObject({ duplicate: true, status: 'consumed' })
      expect(queue).toHaveLength(0)
    } finally { inbox.dispose() }
  }
})

test('transcript index deduplicates messages outside the resumed context window', () => {
  const queue: QueuedCommand[] = []
  const inbox = createSessionMessageInbox(cmd => queue.push(cmd), () => {})
  try {
    expect(inbox.accept(message, true)).toMatchObject({ status: 'consumed', duplicate: true })
    expect(queue).toHaveLength(0)
  } finally { inbox.dispose() }
})

test('Stop removes only queued collaboration commands and permits explicit redelivery', () => {
  const queue: QueuedCommand[] = [{ mode: 'prompt', value: 'ordinary user', priority: 'next' }]
  const receipts: unknown[] = []
  const inbox = createSessionMessageInbox(command => queue.push(command), receipt => receipts.push(receipt))
  try {
    inbox.accept(message)
    const abandoned = queue[1]!.uuid!
    expect(inbox.cancelQueued(predicate => {
      const removed = queue.filter(predicate)
      for (const item of removed) queue.splice(queue.indexOf(item), 1)
      return removed
    })).toBe(1)
    expect(queue).toHaveLength(1)
    expect(queue[0]!.value).toBe('ordinary user')
    consumeSessionMessage(abandoned)
    expect(receipts).toHaveLength(0)
    expect(inbox.accept(message)).toMatchObject({ status: 'queued', duplicate: false })
    consumeSessionMessage(queue[1]!.uuid!)
    expect(receipts).toHaveLength(1)
  } finally { inbox.dispose() }
})
