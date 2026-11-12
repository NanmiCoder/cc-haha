import { mergeComposerReferences, type ComposerReference } from '../../core/composerReferences'
import type { ComposerAttachment } from '../../core/chatComposer'
import type { ClientMessage } from '../../core/types'

/**
 * Messages added while running. The mobile transport does not send user_message during a turn, 
 * so like the desktop default they queue on the phone first and send after this turn ends.
 */
export type QueuedMessage = {
  id: string
  text: string
  attachments: ComposerAttachment[]
  team: boolean
  references?: ComposerReference[]
  message: ClientMessage
}

export type QueueGate = {
  ready: boolean
  turnActive: boolean
  waitingForDecision: boolean
  pendingUser: boolean
  configPending: boolean
  workspaceMissing: boolean
  /** The previous turn ended with an error: queued follow-ups likely depend on it, so stop and let the user decide. */
  lastTurnFailed: boolean
  /** Delivery of the previous message was not confirmed: do not silently send before or after it. */
  deliveryUncertain: boolean
}

const settled = (gate: QueueGate) =>
  gate.ready &&
  !gate.turnActive &&
  !gate.waitingForDecision &&
  !gate.pendingUser &&
  !gate.configPending &&
  !gate.workspaceMissing

/** Send automatically only when this turn ended cleanly with no pending decisions and no unconfirmed sends. */
export function canFlushQueue(gate: QueueGate, focused = true) {
  return focused && settled(gate) && !gate.lastTurnFailed && !gate.deliveryUncertain
}

/** When this turn stopped but is not suitable for auto-continuing, give the queue area a reason; returned only when manual send is possible. */
export function queuePauseReason(gate: QueueGate) {
  if (!settled(gate)) return ''
  if (gate.lastTurnFailed) return 'The previous turn errored; queued messages are on hold'
  if (gate.deliveryUncertain) return 'Delivery of the previous message was not confirmed; queued messages are on hold'
  return ''
}

/** When stopping a task or leaving the session, queued text returns to the input and is never sent silently. */
export function queueToDraft(draft: string, queued: Pick<QueuedMessage, 'text'>[]) {
  return [...queued.map((item) => item.text), draft]
    .map((text) => text.trim())
    .filter(Boolean)
    .join('\n\n')
}

export function queueAttachments(
  queued: Pick<QueuedMessage, 'attachments'>[],
  current: ComposerAttachment[]
) {
  return [...queued.flatMap((item) => item.attachments), ...current]
}

export type ComposerQueueState = {
  queue: QueuedMessage[]
  draft: string
  attachments: ComposerAttachment[]
  team: boolean
  references?: ComposerReference[]
}

/** Stop, withdraw and blur all use the same queue restore path. */
export function withdrawQueuedComposer(
  key: string,
  current: ComposerQueueState,
  drafts: {
    set(key: string, value: string): unknown
    delete(key: string): unknown
  },
  ids?: string[]
): ComposerQueueState {
  const taken = current.queue.filter((item) => !ids || ids.includes(item.id))
  const next = taken.length ? {
    queue: current.queue.filter((item) => !taken.includes(item)),
    draft: queueToDraft(current.draft, taken),
    attachments: queueAttachments(taken, current.attachments),
    team: current.team || taken.some((item) => item.team),
    ...(current.references?.length || taken.some((item) => item.references?.length) ? { references: mergeComposerReferences(...taken.map((item) => item.references), current.references) } : {}),
  } : current
  if (next.draft) drafts.set(key, next.draft)
  else drafts.delete(key)
  parkComposer(key, next)
  return next
}

/**
 * When leaving the session page, materials and team toggle of queued messages are kept in memory first (the text goes into the draft), 
 * and given back to the input on return. Like drafts, only valid while the app stays open, never persisted.
 */
type Parked = { attachments: ComposerAttachment[]; team: boolean; references?: ComposerReference[] }
const parked = new Map<string, Parked>()

export function parkComposer(key: string, value: Parked) {
  if (!value.attachments.length && !value.team && !value.references?.length) parked.delete(key)
  else parked.set(key, { attachments: [...value.attachments], team: value.team, ...(value.references?.length ? { references: [...value.references] } : {}) })
}

/** Read without taking: React dev mode may call the initializer twice. Clear after mount. */
export function parkedComposer(key: string): Parked | undefined {
  return parked.get(key)
}

export function clearParkedComposer(key: string) {
  parked.delete(key)
}
