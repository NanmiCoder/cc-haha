import { randomUUID } from 'node:crypto'
import { ApiError } from '../middleware/errorHandler.js'
import type { IndexedSessionRow } from './localIndex/sessionIndex.js'
import type { SessionListItem } from './sessionService.js'

export type ProjectHistoryOptions = {
  projectRoot: string
  limit?: number
  cursor?: string
  beforeModifiedAt?: string
  beforeId?: string
}
export type ProjectHistoryPage = { sessions: SessionListItem[]; nextCursor: string | null }
export type ProjectHistoryRow = IndexedSessionRow & { logicalProjectRoot: string }
type Snapshot = { scope: string; root: string; expiresAt: number; rows: ProjectHistoryRow[] }

const SNAPSHOT_TTL_MS = 5 * 60_000
const SNAPSHOT_LIMIT = 16
const SNAPSHOT_ROW_BUDGET = 50_000

/** In-memory order snapshots keep inserts and resumed sessions from shifting pages. */
export class ProjectSessionHistory {
  private catalog: { key: string; expiresAt: number; rows: ProjectHistoryRow[] } | null = null
  private readonly requests = new Map<string, Promise<ProjectHistoryRow[]>>()
  private readonly snapshots = new Map<string, Snapshot>()

  constructor(private readonly source: {
    now: () => number
    scope: () => string
    revision: () => string
    mutation: () => string
    load: () => Promise<ProjectHistoryRow[]>
    hydrate: (row: ProjectHistoryRow) => Promise<SessionListItem | null>
  }) {}

  async list(options: ProjectHistoryOptions): Promise<ProjectHistoryPage> {
    const { projectRoot, cursor, beforeModifiedAt, beforeId } = options
    if (typeof projectRoot !== 'string' || !projectRoot.trim() || projectRoot.length > 8192 || projectRoot.includes('\0')) {
      throw ApiError.badRequest('A valid projectRoot is required')
    }
    const requestedLimit = options.limit ?? 50
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit <= 0) throw ApiError.badRequest('Invalid limit')
    const limit = Math.min(100, requestedLimit)
    if ((beforeModifiedAt === undefined) !== (beforeId === undefined) || (cursor !== undefined && beforeId !== undefined)) {
      throw ApiError.badRequest('Use beforeModifiedAt and beforeId together on the first page only')
    }
    const beforeTime = beforeModifiedAt === undefined ? null : Date.parse(beforeModifiedAt)
    if (beforeTime !== null && (!Number.isFinite(beforeTime) || typeof beforeId !== 'string' || !beforeId || beforeId.length > 256 || beforeId.includes('\0'))) {
      throw ApiError.badRequest('Invalid history boundary')
    }

    const scope = this.source.scope()
    this.prune(scope)
    let snapshotId: string
    let snapshot: Snapshot
    let offset = 0
    if (cursor !== undefined) {
      const decoded = this.decodeCursor(cursor)
      snapshotId = decoded.snapshot
      offset = decoded.offset
      const found = this.snapshots.get(snapshotId)
      if (!found) throw this.expired()
      if (found.scope !== scope || found.root !== projectRoot) throw ApiError.badRequest('Cursor does not belong to this project')
      if (offset > found.rows.length) throw ApiError.badRequest('Invalid cursor position')
      snapshot = found
    } else {
      const catalog = await this.loadCatalog()
      if (scope !== this.source.scope()) throw this.expired()
      const seen = new Set<string>()
      const rows = catalog.filter((row) => {
        if (row.logicalProjectRoot !== projectRoot || seen.has(row.id)) return false
        seen.add(row.id)
        if (beforeTime === null) return true
        const time = Date.parse(row.modifiedAt)
        return row.id !== beforeId && (time < beforeTime || (time === beforeTime && row.id.localeCompare(beforeId!) > 0))
      })
      snapshotId = randomUUID()
      snapshot = { scope, root: projectRoot, expiresAt: this.source.now() + SNAPSHOT_TTL_MS, rows }
      this.snapshots.set(snapshotId, snapshot)
      this.prune(scope)
    }

    // Keep validation and hydration page-sized. Deleted files consume a cursor
    // position but not a rendered row, so sparse pages still make progress.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const mutation = this.source.mutation()
      const sessions: SessionListItem[] = []
      let nextOffset = offset
      while (nextOffset < snapshot.rows.length && sessions.length < limit && nextOffset - offset < limit * 2) {
        const session = await this.source.hydrate(snapshot.rows[nextOffset++]!)
        if (session) sessions.push(session)
      }
      if (mutation !== this.source.mutation()) continue
      if (scope !== this.source.scope()) throw this.expired()
      snapshot.expiresAt = this.source.now() + SNAPSHOT_TTL_MS
      this.snapshots.delete(snapshotId)
      this.snapshots.set(snapshotId, snapshot)
      this.prune(scope)
      return {
        sessions,
        nextCursor: nextOffset < snapshot.rows.length
          ? Buffer.from(JSON.stringify({ snapshot: snapshotId, offset: nextOffset })).toString('base64url')
          : null,
      }
    }
    throw new ApiError(409, 'Project history changed during loading; retry from the first page', 'PROJECT_HISTORY_CHANGED')
  }

  private async loadCatalog(): Promise<ProjectHistoryRow[]> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const key = this.source.revision()
      if (this.catalog?.key === key && this.catalog.expiresAt > this.source.now()) return this.catalog.rows
      let request = this.requests.get(key)
      if (!request) {
        request = this.source.load()
        this.requests.set(key, request)
      }
      let rows: ProjectHistoryRow[]
      try { rows = await request } finally {
        if (this.requests.get(key) === request) this.requests.delete(key)
      }
      if (key !== this.source.revision()) continue
      rows.sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt) || a.id.localeCompare(b.id) || a.transcriptPath.localeCompare(b.transcriptPath))
      this.catalog = { key, expiresAt: this.source.now() + 5000, rows }
      return rows
    }
    throw new ApiError(409, 'Project history changed during loading; retry from the first page', 'PROJECT_HISTORY_CHANGED')
  }

  private decodeCursor(cursor: string): { snapshot: string; offset: number } {
    try {
      if (typeof cursor !== 'string' || cursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error()
      const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
      if (!value || typeof value.snapshot !== 'string' || !/^[0-9a-f-]{36}$/.test(value.snapshot) || !Number.isSafeInteger(value.offset) || value.offset < 0) throw new Error()
      return value
    } catch { throw ApiError.badRequest('Invalid project history cursor') }
  }

  private expired() {
    return new ApiError(409, 'Project history cursor expired; retry from the first page', 'PROJECT_HISTORY_CURSOR_EXPIRED')
  }

  private prune(scope: string) {
    for (const [id, snapshot] of this.snapshots) {
      if (snapshot.scope !== scope || snapshot.expiresAt <= this.source.now()) this.snapshots.delete(id)
    }
    let rows = [...this.snapshots.values()].reduce((total, snapshot) => total + snapshot.rows.length, 0)
    // A single unusually large project remains browsable; the budget evicts
    // other snapshots instead of silently truncating its history.
    while (this.snapshots.size > SNAPSHOT_LIMIT || (rows > SNAPSHOT_ROW_BUDGET && this.snapshots.size > 1)) {
      const oldest = this.snapshots.keys().next().value!
      rows -= this.snapshots.get(oldest)!.rows.length
      this.snapshots.delete(oldest)
    }
  }
}
