import type { Storage } from '../state/storage'

/** 「＋ 带什么」里「最近用过」的一条记录；只存标识和展示文案，真正的内容每次从电脑目录里取。 */
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

/** 记一次使用：同一条去重后放到最前，按使用时间倒序，最多 RECENT_LIMIT 条。 */
export function recordRecent(
  list: RecentItem[],
  item: Omit<RecentItem, 'usedAt'>,
  now: number
): RecentItem[] {
  return [{ ...item, usedAt: now }, ...list.filter((value) => value.key !== item.key)]
    .sort((a, b) => b.usedAt - a.usedAt)
    .slice(0, RECENT_LIMIT)
}

/** 一次记录多条（同一次「完成」选了几项）：保持传入顺序，先传的更靠前。 */
export function recordRecents(
  list: RecentItem[],
  items: Omit<RecentItem, 'usedAt'>[],
  now: number
): RecentItem[] {
  // 同一毫秒内的多条用递减的时间戳保持顺序。
  return [...items]
    .reverse()
    .reduce((next, item, index) => recordRecent(next, item, now + index), list)
}

/** 读取本地数据：坏数据一律当作没有，不让输入框因此打不开。 */
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

/** 写入串行化：连续两次记录不会互相覆盖。 */
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
