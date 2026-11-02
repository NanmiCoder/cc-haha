import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { lock } from './lockfile.js'

type ArchiveRecord = { archived: boolean; [key: string]: unknown }
type ArchiveState = { schemaVersion: 1; sessions: Record<string, ArchiveRecord>; [key: string]: unknown }
type Snapshot = { revision: string; state: ArchiveState; ids: ReadonlySet<string> }
const cache = new Map<string, Snapshot>()
const mutationQueues = new Map<string, Promise<void>>()

function statePath(configDir: string): string {
  return join(configDir, 'cc-haha', 'session-archives.json')
}

/** Cleanup and archive mutations share this lock, including across CLI/server
 * processes. Each caller locks only one candidate, never an entire sweep. */
export async function withSessionArchiveLock<T>(configDir: string, action: () => Promise<T>): Promise<T> {
  const filePath = statePath(configDir)
  const previous = mutationQueues.get(filePath) ?? Promise.resolve()
  const operation = previous.catch(() => {}).then(async () => {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
    const release = await lock(filePath, { realpath: false, retries: { retries: 30, minTimeout: 10, maxTimeout: 100 } })
    try { return await action() } finally { await release() }
  })
  const queued = operation.then(() => {}, () => {})
  mutationQueues.set(filePath, queued)
  try { return await operation } finally {
    if (mutationQueues.get(filePath) === queued) mutationQueues.delete(filePath)
  }
}

function migrateArchiveState(value: unknown): ArchiveState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid session archive state; existing data was preserved')
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== undefined && record.schemaVersion !== 0 && record.schemaVersion !== 1) {
    throw new Error('Unsupported session archive state version; update the app before modifying archives')
  }
  if (!record.sessions || typeof record.sessions !== 'object' || Array.isArray(record.sessions)) throw new Error('Invalid session archive records')
  for (const entry of Object.values(record.sessions)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof (entry as ArchiveRecord).archived !== 'boolean') {
      throw new Error('Invalid session archive record; existing data was preserved')
    }
  }
  // Unversioned metadata has the same records. Forward reads supply v1 and the
  // next intentional mutation persists it without dropping extension fields.
  return { ...record, schemaVersion: 1, sessions: record.sessions as Record<string, ArchiveRecord> }
}

export function readSessionArchives(configDir: string): Snapshot {
  const filePath = statePath(configDir)
  let revision: string
  try {
    const stat = statSync(filePath)
    revision = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return { revision: 'missing', state: { schemaVersion: 1, sessions: {} }, ids: new Set() }
  }
  const previous = cache.get(filePath)
  if (previous?.revision === revision) return previous
  const state = migrateArchiveState(JSON.parse(readFileSync(filePath, 'utf8')))
  const snapshot = { revision, state, ids: new Set(Object.entries(state.sessions).filter(([, value]) => value.archived).map(([id]) => id)) }
  cache.delete(filePath)
  cache.set(filePath, snapshot)
  while (cache.size > 16) cache.delete(cache.keys().next().value!)
  return snapshot
}

/** Synchronous read-modify-rename keeps the final activity check and mutation
 * in one server turn. Archives never rewrite, move, or remove transcripts. */
export function writeSessionArchive(configDir: string, sessionId: string, archived: boolean): void {
  const filePath = statePath(configDir)
  const { state } = readSessionArchives(configDir)
  const next: ArchiveState = {
    ...state,
    sessions: { ...state.sessions, [sessionId]: { ...state.sessions[sessionId], archived } },
  }
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
  const temporary = `${filePath}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
    renameSync(temporary, filePath)
  } finally {
    try { unlinkSync(temporary) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  cache.delete(filePath)
}
