import type { Checkpoint, DiffResponse } from '../../core/operations'

/**
 * In-memory cache shared across the "Changes and files" pages (not persisted): checkpoints fetched by the list page, 
 * per-file diffs and workspace status can show first when entering the diff page, then refresh in the background.
 */
export class BoundedCache<V> {
  private readonly map = new Map<string, V>()
  constructor(private readonly limit: number) {}
  get(key: string) {
    return this.map.get(key)
  }
  has(key: string) {
    return this.map.has(key)
  }
  set(key: string, value: V) {
    this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
  }
  get size() {
    return this.map.size
  }
}

export type WorkspaceChange = {
  path: string
  oldPath?: string
  status: string
  additions: number
  deletions: number
}
export type WorkspaceStatus = {
  state: string
  workDir?: string
  repoName?: string | null
  branch?: string | null
  isGitRepo?: boolean
  changedFiles: WorkspaceChange[]
  error?: string
}

export const sessionKey = (hostId: string, sessionId: string) =>
  `${hostId}\u0000${sessionId}`

export const checkpointLists = new BoundedCache<Checkpoint[]>(16)
/** key: sessionKey + checkpoint signature + file path. */
export const checkpointDiffs = new BoundedCache<DiffResponse>(400)
export const workspaceStatuses = new BoundedCache<WorkspaceStatus>(16)
/** key: sessionKey + user message id. The text for a message id never changes. */
export const turnPrompts = new BoundedCache<string>(400)
