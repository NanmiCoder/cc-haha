/**
 * U07 / M6-B submission seam — the ONE prepare step the three send points share.
 *
 * The immediate send (`ChatInput`), the first send of a created/replaced session
 * (`ChatInput`'s repository launch, `EmptySession`'s create-then-send) and the
 * queued-while-busy send all call `prepareManagedContextSubmission()` once, at
 * the moment they decide to send. The result travels with the message/queue item
 * (`managedContext`), so the queue flush re-uses the snapshot it captured instead
 * of preparing a second one — a selection cannot be prepared twice, differently,
 * or sent twice.
 *
 * Two properties matter here:
 *
 * - The snapshot is a deep copy (`useContextSelectionStore.snapshot()`) taken at
 *   prepare time and frozen, never a live reference to the store's pick. Editing
 *   the composer selection after an item is queued cannot change what it sends.
 * - Nothing is allocated or written when nothing is selected: `prepare` returns
 *   `null`, the store is not touched, and no selection is persisted. The wire
 *   frame (`user_message`) is untouched in both cases — the server-side context
 *   ticket is a later micro-batch's contract.
 */
import { getDesktopHost } from '../../../lib/desktopHost/index.js'
import { isConversationContextSupported } from '../api/desktopHostCapabilities.js'
import {
  useContextSelectionStore,
  type ContextSelectionSnapshot,
} from '../stores/contextSelectionStore.js'
import type { ConversationContextSelectionV2 } from '../types/resourceTypes.js'

/** What one prepared send carries: identity, immutable content and what to persist. */
export type ManagedContextSubmission = {
  /** Identity of exactly this prepared send — one token per prepare call. */
  submissionId: string
  /** Deep copy of the selection as it was when this send was prepared. */
  snapshot: ContextSelectionSnapshot
  /** The same pick projected onto the persisted v2 document. */
  selection: ConversationContextSelectionV2
}

let submissionCounter = 0

/**
 * UUID-shaped, like the message identity the server's receipt/replay will
 * associate later (M7's ticket `requestId`). The counter only guarantees
 * uniqueness when the platform has no `crypto.randomUUID`.
 */
function createSubmissionToken(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return uuid
  submissionCounter += 1
  return `ctx-submission-${Date.now().toString(36)}-${submissionCounter}`
}

/**
 * Freeze the copy this module owns. `snapshot()` already deep-copies, so this
 * only makes the copy's immutability explicit at the seam that hands it to a
 * queue item that outlives the composer.
 */
function freezeSnapshot(snapshot: ContextSelectionSnapshot): ContextSelectionSnapshot {
  for (const tag of snapshot.sourceTags) {
    Object.freeze(tag.memberIds)
    Object.freeze(tag)
  }
  for (const direct of snapshot.directIds) Object.freeze(direct)
  Object.freeze(snapshot.sourceTags)
  Object.freeze(snapshot.directIds)
  Object.freeze(snapshot.resolved.host)
  Object.freeze(snapshot.resolved.concept)
  Object.freeze(snapshot.resolved.dataConnection)
  Object.freeze(snapshot.resolved)
  return Object.freeze(snapshot)
}

/**
 * Whether a send would carry managed context. Reads in-memory state only, so a
 * caller can guard its `await` with this and keep the no-selection send path
 * synchronous, i.e. timed exactly as it was before this batch.
 */
export function hasManagedContextSelection(): boolean {
  return useContextSelectionStore.getState().hasSelection()
}

/**
 * The one prepare. Returns `null` when nothing is selected, so the no-selection
 * path stays byte-identical: no snapshot, no store write, no persistence.
 */
export function prepareManagedContextSubmission(): ManagedContextSubmission | null {
  const store = useContextSelectionStore.getState()
  if (!store.hasSelection()) return null
  return {
    submissionId: createSubmissionToken(),
    snapshot: freezeSnapshot(store.snapshot()),
    selection: store.toConversationContextSelection(),
  }
}

/**
 * Persist a selection through the existing host API. Best effort by design: the
 * selection is already captured in memory for the send in flight, so a failed
 * write must not fail that send.
 */
export async function persistManagedContextSelection(
  sessionId: string,
  selection: ConversationContextSelectionV2,
): Promise<void> {
  if (!isConversationContextSupported()) return
  try {
    await getDesktopHost().conversationContext.saveSelection(sessionId, selection)
  } catch {
    // See above: a persistence failure never drops the send.
  }
}

/**
 * Create/replace path: move the draft selection onto the session in one store
 * update (`migrateToSession`), so no render can observe a session-scoped empty
 * draft or a draft-scoped session pick, then persist it for that session.
 *
 * Returns `true` when a selection moved. With nothing selected this is a no-op:
 * no `set`, no host call, and the draft keeps whatever it had.
 */
export async function adoptManagedContextSession(sessionId: string): Promise<boolean> {
  const store = useContextSelectionStore.getState()
  if (!store.hasSelection()) return false
  store.migrateToSession(sessionId)
  await persistManagedContextSelection(sessionId, useContextSelectionStore.getState().toConversationContextSelection())
  return true
}
