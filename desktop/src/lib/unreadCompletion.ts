import type { UIMessage } from '../types/chat'

type Reply = Extract<UIMessage, { type: 'assistant_text' }>
type User = Extract<UIMessage, { type: 'user_text' }>

// An unread closed tab keeps a locator for its reply, not its transcript or image data.
function textKey(text: string): string {
  const value = text.trim()
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619)
  return `${value.length}:${hash >>> 0}`
}

type TurnAnchor =
  | { type: 'tool'; id: string }
  | { type: 'user'; id: string; transcriptId?: string; key: string; occurrence: number }

function isUser(message: UIMessage): message is User {
  return message.type === 'user_text' && !message.optimisticQueued
}

function turnAnchor(messages: readonly UIMessage[], before: number): { anchor?: TurnAnchor; index: number } {
  for (let i = before - 1; i >= 0; i--) {
    const row = messages[i]!
    if (row.type === 'tool_use' && row.toolUseId && !row.parentToolUseId) {
      return { anchor: { type: 'tool', id: row.toolUseId }, index: i }
    }
    if (isUser(row)) {
      const key = textKey(row.content)
      let occurrence = 1
      for (let j = 0; j < i; j++) {
        const prior = messages[j]!
        if (isUser(prior) && prior.content.trim() === row.content.trim()) occurrence++
      }
      return { anchor: { type: 'user', id: row.id, transcriptId: row.transcriptMessageId, key, occurrence }, index: i }
    }
  }
  return { index: -1 }
}

function findAnchor(messages: readonly UIMessage[], anchor: TurnAnchor): number {
  if (anchor.type === 'tool') {
    return messages.findIndex(row => row.type === 'tool_use' && row.toolUseId === anchor.id && !row.parentToolUseId)
  }
  const byId = messages.findIndex(row => isUser(row) &&
    (row.id === anchor.id || (!!anchor.transcriptId && row.transcriptMessageId === anchor.transcriptId)))
  if (byId >= 0 || anchor.transcriptId) return byId
  let occurrence = 0
  return messages.findIndex(row => isUser(row) && textKey(row.content) === anchor.key && ++occurrence === anchor.occurrence)
}

export type UnreadCompletion = {
  replyId: string
  transcriptId?: string
  transcriptOccurrence: number
  key: string
  anchor?: TurnAnchor
  occurrence: number
}

export function createUnreadCompletion(messages: readonly UIMessage[], reply: Reply): UnreadCompletion {
  const index = messages.indexOf(reply)
  const { anchor, index: anchorIndex } = turnAnchor(messages, index)
  const content = reply.content.trim()
  let occurrence = 1
  let transcriptOccurrence = 1
  for (let i = 0; i < index; i++) {
    const row = messages[i]!
    if (row.type !== 'assistant_text' || row.content.trim() !== content) continue
    if (i > anchorIndex) occurrence++
    if (reply.transcriptMessageId && reply.transcriptMessageId === row.transcriptMessageId) transcriptOccurrence++
  }
  return { replyId: reply.id, transcriptId: reply.transcriptMessageId, transcriptOccurrence, key: textKey(content), anchor, occurrence }
}

export function resolveUnreadCompletion(messages: readonly UIMessage[], marker: UnreadCompletion): Reply | undefined {
  const exact = messages.find((row): row is Reply => row.type === 'assistant_text' &&
    row.id === marker.replyId && textKey(row.content) === marker.key)
  if (exact) return exact
  if (marker.transcriptId) {
    // A single SDK message may contain identical text blocks separated by thinking or tool calls.
    let occurrence = 0
    return messages.find((row): row is Reply => row.type === 'assistant_text' &&
      row.transcriptMessageId === marker.transcriptId && textKey(row.content) === marker.key &&
      ++occurrence === marker.transcriptOccurrence)
  }
  // A cold history load replaces renderer ids with durable ones. Match within the
  // original turn so an identical answer to a different prompt cannot acknowledge it.
  const anchor = marker.anchor ? findAnchor(messages, marker.anchor) : -1
  if (marker.anchor && anchor < 0) return
  let occurrence = 0
  for (let i = anchor + 1; i < messages.length; i++) {
    const row = messages[i]!
    if (marker.anchor && (isUser(row) || (row.type === 'tool_use' && !row.parentToolUseId))) return
    if (row.type === 'assistant_text' && row.transcriptMessageId &&
      textKey(row.content) === marker.key && ++occurrence === marker.occurrence) return row
  }
}

/** Find durable output for the turn this renderer actually saw running before losing its socket. */
export function recoveredUnreadCompletion(before: readonly UIMessage[], restored: readonly UIMessage[]): UnreadCompletion | undefined {
  const { anchor, index: baseline } = turnAnchor(before, before.length)
  if (!anchor) return
  const start = findAnchor(restored, anchor)
  if (start < 0) return
  for (let i = start; i >= 0; i--) {
    const row = restored[i]!
    if (isUser(row)) {
      if (row.scheduledTask) return
      break
    }
  }
  let reply: Reply | undefined
  for (let i = start + 1; i < restored.length; i++) {
    const row = restored[i]!
    if (isUser(row)) break
    if (row.type === 'error' || (row.type === 'system' && row.generationStopped)) return
    if (row.type === 'tool_use' && !row.parentToolUseId) reply = undefined
    if (row.type === 'assistant_text') reply = row
  }
  if (!reply || !reply.transcriptMessageId) return
  const marker = createUnreadCompletion(restored, reply)
  // The durable tail may still end at pre-gap output. It is evidence of a new
  // reply only when this turn didn't already contain the same occurrence.
  for (let i = baseline + 1; i < before.length; i++) {
    const row = before[i]!
    if (row.type !== 'assistant_text') continue
    if (resolveUnreadCompletion(restored, createUnreadCompletion(before, row)) === reply) return
  }
  return marker
}
