/**
 * Global file-size cache with a two-tier structure, mirroring the download
 * card's hot/cold pattern:
 *
 *  - hot:  the 50 most recently accessed files — TTL 120s, LRU. Any read
 *    (set) or hit (get) refreshes the entry so actively-browsed files stay
 *    hot.
 *  - cold: the next 150 files — TTL 30min. A hot entry with no access for
 *    120s is demoted to cold (kept for history browsing); a cold entry older
 *    than 30min is dropped and must be re-queried.
 *
 * Total cap 200 entries, newest-in / oldest-out (LRU), so there is no growth
 * path: every write either refreshes an existing entry or evicts the oldest.
 * Persisted to localStorage (`cc-haha:file-sizes`) so re-opening the app
 * shows sizes instantly without re-querying `/local-file?info=1`.
 */

const STORAGE_KEY = 'cc-haha:file-sizes'
const MAX_HOT = 50
const MAX_COLD = 150
const HOT_TTL_MS = 120_000
const COLD_TTL_MS = 30 * 60 * 1000

export type SizeEntry = { path: string; size: number; at: number }

type TierShape = { entries: SizeEntry[] }
type StoredShape = { hot: TierShape; cold: TierShape }

const memory = new Map<string, SizeEntry>()

function emptyShape(): StoredShape {
  return { hot: { entries: [] }, cold: { entries: [] } }
}

function safeRead(): StoredShape {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return emptyShape()
    const parsed = JSON.parse(raw) as StoredShape
    if (!Array.isArray(parsed?.hot?.entries) || !Array.isArray(parsed?.cold?.entries)) {
      return emptyShape()
    }
    return parsed
  } catch {
    return emptyShape()
  }
}

function safeWrite(shape: StoredShape): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(shape))
  } catch {
    // Quota / private mode — best effort; memory still works.
  }
}

/** Demote a hot entry to cold (kept for 30min), or overwrite an existing one. */
function demoteToCold(shape: StoredShape, path: string, size: number, at: number): void {
  const others = shape.cold.entries.filter((e) => e.path !== path)
  shape.cold.entries = [...others, { path, size, at }].slice(-MAX_COLD)
}

/** Lazy maintenance: expire cold entries, demote stale hot, cap totals. */
function maintain(shape: StoredShape, now: number): void {
  const coldCutoff = now - COLD_TTL_MS
  shape.cold.entries = shape.cold.entries.filter((e) => e.at >= coldCutoff).slice(-MAX_COLD)
  const hotCutoff = now - HOT_TTL_MS
  for (const entry of shape.hot.entries) {
    if (entry.at >= hotCutoff) continue
    demoteToCold(shape, entry.path, entry.size, entry.at)
  }
  shape.hot.entries = shape.hot.entries.filter((e) => e.at >= hotCutoff).slice(-MAX_HOT)
  if (shape.cold.entries.length > MAX_COLD) {
    shape.cold.entries = shape.cold.entries.slice(-MAX_COLD)
  }
}

export function getFileSize(path: string): number | undefined {
  const now = Date.now()
  const shape = safeRead()
  maintain(shape, now)
  let entry = shape.hot.entries.find((e) => e.path === path)
  if (entry) {
    entry.at = now
    safeWrite(shape)
    memory.set(path, entry)
    return entry.size
  }
  entry = shape.cold.entries.find((e) => e.path === path)
  if (entry) {
    const withoutCold = shape.cold.entries.filter((e) => e.path !== path)
    shape.cold.entries = withoutCold
    shape.hot.entries = [...shape.hot.entries.filter((e) => e.path !== path), { ...entry, at: now }].slice(-MAX_HOT)
    safeWrite(shape)
    memory.set(path, { ...entry, at: now })
    return entry.size
  }
  const mem = memory.get(path)
  if (mem && now - mem.at < COLD_TTL_MS) return mem.size
  if (mem) memory.delete(path)
  return undefined
}

export function setFileSize(path: string, size: number): void {
  const now = Date.now()
  const shape = safeRead()
  maintain(shape, now)
  const others = shape.hot.entries.filter((e) => e.path !== path)
  shape.hot.entries = [...others, { path, size, at: now }]
  while (shape.hot.entries.length > MAX_HOT) {
    const removed = shape.hot.entries.shift()!
    demoteToCold(shape, removed.path, removed.size, removed.at)
  }
  safeWrite(shape)
  memory.set(path, { path, size, at: now })
  while (memory.size > MAX_HOT + MAX_COLD) {
    const oldest = memory.keys().next().value
    if (oldest === undefined) break
    memory.delete(oldest)
  }
}

export function __clearFileSizeCache(): void {
  memory.clear()
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
}
