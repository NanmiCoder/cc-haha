/**
 * Skills the user sent most recently, newest first, so the + menu can put
 * them within one click. A per-device convenience: losing it only empties the
 * "Recent" group, so every read tolerates a missing or foreign value.
 *
 * Stored shape (version 1): `{ "version": 1, "ids": ["skill-id", ...] }`.
 */

export const RECENT_SKILLS_STORAGE_KEY = 'cc-haha-recent-skills'
export const RECENT_SKILLS_MAX = 8

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function defaultStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/** Normalize anything found under the key into a list of skill ids. */
export function parseRecentSkills(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    const ids = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as { ids?: unknown }).ids
      : null
    if (!Array.isArray(ids)) return []
    return ids
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .filter((id, index, all) => all.indexOf(id) === index)
      .slice(0, RECENT_SKILLS_MAX)
  } catch {
    return []
  }
}

export function readRecentSkills(storage: StorageLike | null = defaultStorage()): string[] {
  try {
    return parseRecentSkills(storage?.getItem(RECENT_SKILLS_STORAGE_KEY) ?? null)
  } catch {
    return []
  }
}

/** Move the sent skills to the front, in the order they appear in the message. */
export function recordRecentSkills(skillIds: string[], storage: StorageLike | null = defaultStorage()): void {
  if (!storage || skillIds.length === 0) return
  const sent = skillIds.filter((id, index, all) => id && all.indexOf(id) === index)
  const ids = [...sent, ...readRecentSkills(storage).filter(id => !sent.includes(id))].slice(0, RECENT_SKILLS_MAX)
  try {
    storage.setItem(RECENT_SKILLS_STORAGE_KEY, JSON.stringify({ version: 1, ids }))
  } catch { /* storage full or unavailable */ }
}
