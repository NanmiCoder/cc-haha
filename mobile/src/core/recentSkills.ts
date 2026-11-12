import type { Storage } from '../state/storage'

/** A "Recently used" record in "+ Bring"; stores only the ID and display text, and the real content is fetched from the computer directory each time. */
export type RecentKind = 'skill' | 'plugin' | 'command' | 'agent' | 'workflow'
export type RecentItem = {
  key: string
  kind: RecentKind
  name: string
  displayName?: string
  description: string
  usedAt: number
}
export const RECENT_LIMIT = 8
export const recentKey = 'cc-haha.mobile.recent-skills'

const kinds: RecentKind[] = ['skill', 'plugin', 'command', 'agent', 'workflow']

/** Record one use: dedupe the same item and move it to the front, sorted by use time descending, at most RECENT_LIMIT items. */
export function recordRecent(
  list: RecentItem[],
  item: Omit<RecentItem, 'usedAt'>,
  now: number
): RecentItem[] {
  return [{ ...item, usedAt: now }, ...list.filter((value) => value.key !== item.key)]
    .sort((a, b) => b.usedAt - a.usedAt)
    .slice(0, RECENT_LIMIT)
}

/** Record several at once (several picked in one Done): keep the given order, earlier ones first. */
export function recordRecents(
  list: RecentItem[],
  items: Omit<RecentItem, 'usedAt'>[],
  now: number
): RecentItem[] {
  // Multiple items in the same millisecond keep their order with decreasing timestamps.
  return [...items]
    .reverse()
    .reduce((next, item, index) => recordRecent(next, item, now + index), list)
}

/** Read local data: treat any bad data as absent so the input never fails to open because of it. */
export function parseRecent(raw: string | null): RecentItem[] {
  if (!raw) return []
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return []
  }
  const items = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { items?: unknown }).items)
      ? (value as { items: unknown[] }).items
      : []
  const seen = new Set<string>()
  const result: RecentItem[] = []
  for (const entry of items) {
    if (!entry || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>
    if (
      typeof item.key !== 'string' ||
      !item.key ||
      typeof item.name !== 'string' ||
      !kinds.includes(item.kind as RecentKind) ||
      typeof item.usedAt !== 'number' ||
      !Number.isFinite(item.usedAt) ||
      seen.has(item.key)
    )
      continue
    seen.add(item.key)
    result.push({
      key: item.key,
      kind: item.kind as RecentKind,
      name: item.name,
      displayName: typeof item.displayName === 'string' ? item.displayName : undefined,
      description: typeof item.description === 'string' ? item.description : '',
      usedAt: item.usedAt,
    })
  }
  return result.sort((a, b) => b.usedAt - a.usedAt).slice(0, RECENT_LIMIT)
}

export function serializeRecent(list: RecentItem[]): string {
  return JSON.stringify({ version: 1, items: list.slice(0, RECENT_LIMIT) })
}

/** Serialize writes: two consecutive records never overwrite each other. */
export class RecentSkillsRepository {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private storage: Storage) {}
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task)
    this.queue = result.catch(() => {})
    return result
  }
  load(): Promise<RecentItem[]> {
    return this.serial(async () => parseRecent(await this.storage.getItem(recentKey)))
  }
  record(items: Omit<RecentItem, 'usedAt'>[], now = Date.now()): Promise<RecentItem[]> {
    return this.serial(async () => {
      const next = recordRecents(parseRecent(await this.storage.getItem(recentKey)), items, now)
      await this.storage.setItem(recentKey, serializeRecent(next))
      return next
    })
  }
}
