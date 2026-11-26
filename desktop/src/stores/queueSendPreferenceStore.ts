import { create } from 'zustand'

/**
 * Deliberately its own key rather than a field in the server-side user
 * settings: this only decides how this renderer drains its in-memory prompt
 * queue, and the queue itself never leaves the client. A phone connected to
 * the same session should not inherit the desktop's choice.
 */
export const QUEUE_SEND_AT_ONCE_STORAGE_KEY = 'cc-haha-send-queued-messages-at-once'

/** Default: one queued prompt per turn, in queue order. */
export const DEFAULT_SEND_QUEUED_MESSAGES_AT_ONCE = false

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>

export function normalizeSendQueuedMessagesAtOnce(value: unknown): boolean {
  return value === true || value === '1' || value === 'true'
}

function getPreferenceStorage(): PreferenceStorage | null {
  try { return globalThis.localStorage ?? null } catch { return null }
}

export function readSendQueuedMessagesAtOnce(
  storage: PreferenceStorage | null = getPreferenceStorage(),
): boolean {
  try {
    return normalizeSendQueuedMessagesAtOnce(
      storage?.getItem(QUEUE_SEND_AT_ONCE_STORAGE_KEY),
    )
  } catch {
    return DEFAULT_SEND_QUEUED_MESSAGES_AT_ONCE
  }
}

export function persistSendQueuedMessagesAtOnce(
  sendAtOnce: boolean,
  storage: PreferenceStorage | null = getPreferenceStorage(),
): void {
  if (!storage) return
  try {
    storage.setItem(QUEUE_SEND_AT_ONCE_STORAGE_KEY, sendAtOnce ? '1' : '0')
  } catch { /* Keep the control usable when storage is unavailable. */ }
}

type QueueSendPreferenceState = {
  sendQueuedMessagesAtOnce: boolean
  setSendQueuedMessagesAtOnce: (sendAtOnce: boolean) => void
}

export const useQueueSendPreferenceStore = create<QueueSendPreferenceState>((set) => ({
  sendQueuedMessagesAtOnce: readSendQueuedMessagesAtOnce(),
  setSendQueuedMessagesAtOnce: (sendAtOnce) => {
    persistSendQueuedMessagesAtOnce(sendAtOnce)
    set({ sendQueuedMessagesAtOnce: sendAtOnce })
  },
}))

/** The queue drainer runs outside React; read the preference directly. */
export function sendsQueuedMessagesAtOnce(): boolean {
  return useQueueSendPreferenceStore.getState().sendQueuedMessagesAtOnce
}
