import { createHash } from 'node:crypto'
import { z } from 'zod/v4'
import type { QueuedCommand } from '../types/textInputTypes.js'
import { formatSessionCollaborationPrompt } from './sessionCollaborationEnvelope.js'

export const sessionMessageInputSchema = z.strictObject({
  subtype: z.literal('enqueue_session_message'),
  message_id: z.string().min(1).max(200),
  sender_session_id: z.string().min(1).max(200),
  text: z.string().min(1).max(32_000),
  start_if_idle: z.boolean().optional(),
})

type Receipt = { message_id: string; status: 'queued' | 'consumed'; duplicate: boolean }
const consumers = new Map<string, () => void>()

/** Called only where the existing command lifecycle marks a prompt started. */
export function consumeSessionMessage(uuid: string): void {
  consumers.get(uuid)?.()
  consumers.delete(uuid)
}

export function sessionMessageUuid(messageId: string): `${string}-${string}-${string}-${string}-${string}` {
  const hash = createHash('sha256').update('desktop-session-message:' + messageId).digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

export function isPendingSessionMessage(uuid: string | undefined): boolean {
  return uuid !== undefined && consumers.has(uuid)
}

export function createSessionMessageInbox(
  enqueue: (command: QueuedCommand) => void,
  receipt: (value: Receipt) => void,
  history: readonly unknown[] = [],
) {
  const consumedHistory = new Set<string>()
  for (const raw of history) {
    if (!raw || typeof raw !== 'object') continue
    const message = raw as { type?: string; uuid?: string; attachment?: { type?: string; source_uuid?: string } }
    if (message.type === 'user' && message.uuid) consumedHistory.add(message.uuid)
    if (message.type === 'attachment' && message.attachment?.type === 'queued_command' && message.attachment.source_uuid) consumedHistory.add(message.attachment.source_uuid)
  }
  const messages = new Map<string, { sender: string; text: string; status: Receipt['status']; uuid: string }>()
  return {
    accept(raw: unknown, persisted = false): Receipt {
      const input = sessionMessageInputSchema.parse(raw)
      if (persisted || consumedHistory.has(sessionMessageUuid(input.message_id))) {
        return { message_id: input.message_id, status: 'consumed', duplicate: true }
      }
      const existing = messages.get(input.message_id)
      if (existing) {
        if (existing.sender !== input.sender_session_id || existing.text !== input.text) {
          throw new Error('Session message ID already belongs to different content')
        }
        return { message_id: input.message_id, status: existing.status, duplicate: true }
      }
      if (messages.size >= 10_000 || [...messages.values()].filter(m => m.status === 'queued').length >= 50) {
        throw new Error('Session message inbox is full')
      }
      const uuid = sessionMessageUuid(input.message_id)
      const entry = { sender: input.sender_session_id, text: input.text, status: 'queued' as Receipt['status'], uuid }
      messages.set(input.message_id, entry)
      consumers.set(uuid, () => {
        entry.status = 'consumed'
        receipt({ message_id: input.message_id, status: 'consumed', duplicate: false })
      })
      try {
        enqueue({
          mode: 'prompt', priority: 'next', uuid, isMeta: true, skipSlashCommands: true,
          origin: { kind: 'channel', server: 'session-collaboration' },
          value: formatSessionCollaborationPrompt({ senderSessionId: input.sender_session_id, messageId: input.message_id, text: input.text }),
        })
      } catch (error) {
        consumers.delete(uuid)
        messages.delete(input.message_id)
        throw error
      }
      return { message_id: input.message_id, status: 'queued', duplicate: false }
    },
    cancelQueued(remove: (predicate: (command: QueuedCommand) => boolean) => QueuedCommand[]) {
      const queued = new Map([...messages].filter(([, entry]) => entry.status === 'queued').map(([id, entry]) => [entry.uuid, id]))
      const removed = remove(command => command.uuid !== undefined && queued.has(command.uuid))
      for (const command of removed) {
        const id = queued.get(command.uuid!)!
        consumers.delete(command.uuid!)
        messages.delete(id)
      }
      return removed.length
    },
    dispose() {
      for (const { uuid } of messages.values()) consumers.delete(uuid)
      messages.clear()
    },
  }
}
