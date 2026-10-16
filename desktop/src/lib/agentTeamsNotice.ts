/**
 * Whether the user asked not to see the Agent Teams cost notice again when
 * arming it from the composer's + menu. A per-device convenience: losing it
 * only brings the notice back, so every read tolerates a missing or foreign
 * value and every write is best-effort.
 *
 * Stored shape (version 1): `{ "version": 1, "dismissed": true }`.
 */

export const AGENT_TEAMS_NOTICE_STORAGE_KEY = 'cc-haha-agent-teams-notice'

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function defaultStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

export function isAgentTeamsNoticeDismissed(storage: StorageLike | null = defaultStorage()): boolean {
  try {
    const raw = storage?.getItem(AGENT_TEAMS_NOTICE_STORAGE_KEY)
    if (!raw) return false
    const parsed: unknown = JSON.parse(raw)
    return Boolean(
      parsed
      && typeof parsed === 'object'
      && !Array.isArray(parsed)
      && (parsed as { dismissed?: unknown }).dismissed === true,
    )
  } catch {
    return false
  }
}

export function dismissAgentTeamsNotice(storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.setItem(AGENT_TEAMS_NOTICE_STORAGE_KEY, JSON.stringify({ version: 1, dismissed: true }))
  } catch {
    // Storage can be blocked or full; the notice simply shows again.
  }
}
