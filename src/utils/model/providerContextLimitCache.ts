import { createHash, randomUUID } from 'crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import memoize from 'lodash-es/memoize.js'
import { dirname, join } from 'path'
import { z } from 'zod/v4'
import { logForDebugging } from '../debug.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { safeParseJSONWithoutCache } from '../json.js'
import { lazySchema } from '../lazySchema.js'
import { jsonStringify } from '../slowOperations.js'

// Context limits providers stated in prompt-too-long errors, shared between
// CLI processes. Every desktop session runs its own CLI, so without this each
// new session and every restart hits the provider's wall once to relearn it.

// Providers raise limits too; a limit nobody confirmed this long is relearned.
export const PROVIDER_CONTEXT_LIMIT_TTL_MS = 7 * 24 * 60 * 60 * 1000

const CacheEntrySchema = lazySchema(() =>
  z.object({
    limit: z.number().int().positive(),
    updatedAt: z.number(),
  }),
)

const CacheFileSchema = lazySchema(() =>
  z.object({
    version: z.literal(1),
    entries: z.record(z.string(), CacheEntrySchema()),
  }),
)

type CacheEntry = z.infer<ReturnType<typeof CacheEntrySchema>>
type CacheEntries = Record<string, CacheEntry>

// Entries are stored under a digest: the base URL in the key can carry a
// credential or a private host, and the file only ever needs to match it.
function storedKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

function getCachePath(): string {
  return join(getClaudeConfigHomeDir(), 'cache', 'provider-context-limits.json')
}

function isFresh(entry: CacheEntry, now: number): boolean {
  return now - entry.updatedAt < PROVIDER_CONTEXT_LIMIT_TTL_MS
}

// A missing, unreadable, corrupt or foreign-shaped file reads as empty: the
// cache only ever saves a relearn, so it is never worth failing over.
function readEntries(path: string): CacheEntries {
  try {
    // eslint-disable-next-line custom-rules/no-sync-fs -- small file; read from sync getEffectiveModelContextWindow
    const raw = readFileSync(path, 'utf-8')
    const parsed = CacheFileSchema().safeParse(safeParseJSONWithoutCache(raw, false))
    return parsed.success ? parsed.data.entries : {}
  } catch {
    return {}
  }
}

// Keyed on cache path so tests that set CLAUDE_CONFIG_DIR get a fresh read.
// Read once per process; a limit another process learns later is picked up
// by the next session.
const loadEntries = memoize((path: string): CacheEntries => readEntries(path))

// Files this process wrote, so a test reset undoes exactly its own writes.
const writtenPaths = new Set<string>()

export function readPersistedProviderContextLimit(
  key: string,
  now: number = Date.now(),
): number | undefined {
  try {
    const entries = loadEntries(getCachePath())
    const stored = storedKey(key)
    const entry = Object.hasOwn(entries, stored) ? entries[stored] : undefined
    return entry && isFresh(entry, now) ? entry.limit : undefined
  } catch {
    return undefined
  }
}

/**
 * Records a limit the provider confirmed, keeping the smaller of it and a
 * fresh one already on disk. Concurrent CLI processes each read, merge and
 * rename into place; one entry lost to a race is relearned at the next wall.
 * Synchronous on purpose: it runs once per recovered rejection on a file of a
 * few entries. Never throws.
 */
export function persistProviderContextLimit(
  key: string,
  limit: number,
  now: number = Date.now(),
): void {
  if (!Number.isSafeInteger(limit) || limit <= 0) return
  let temporary: string | undefined
  try {
    const path = getCachePath()
    // The file, not the memo: other processes may have written since.
    const entries: CacheEntries = Object.fromEntries(
      Object.entries(readEntries(path)).filter(([, entry]) => isFresh(entry, now)),
    )
    const stored = storedKey(key)
    const known = Object.hasOwn(entries, stored) ? entries[stored] : undefined
    entries[stored] =
      known !== undefined && known.limit < limit ? known : { limit, updatedAt: now }

    mkdirSync(dirname(path), { recursive: true })
    temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
    // eslint-disable-next-line custom-rules/no-sync-fs -- see the doc comment
    writeFileSync(temporary, jsonStringify({ version: 1, entries }), {
      encoding: 'utf-8',
      mode: 0o600,
    })
    renameSync(temporary, path)
    temporary = undefined
    writtenPaths.add(path)
    loadEntries.cache.set(path, entries)
  } catch (error) {
    logForDebugging(
      `[providerContextLimitCache] write skipped: ${error instanceof Error ? error.message : 'unknown'}`,
    )
    if (temporary) {
      try {
        rmSync(temporary, { force: true })
      } catch {
        // Nothing more to do; a stray temporary file is harmless.
      }
    }
  }
}

/**
 * Drops the in-process read. `keepPersisted` stands in for a later process
 * sharing the same config directory; otherwise files this process wrote are
 * removed too, so no learned limit leaks into the next test.
 */
export function resetProviderContextLimitCacheForTesting(
  { keepPersisted = false }: { keepPersisted?: boolean } = {},
): void {
  loadEntries.cache.clear?.()
  if (keepPersisted) return
  for (const path of writtenPaths) rmSync(path, { force: true })
  writtenPaths.clear()
}
