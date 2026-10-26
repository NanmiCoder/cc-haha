import type { Checkpoint, DiffResponse } from '../../core/operations'

/**
 * 「改动与文件」几页之间共享的内存缓存（不落盘）：列表页取到的检查点、
 * 逐文件差异和工作区状态，进入差异页时可以先显示，再在后台刷新。
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
/** key：sessionKey + 检查点签名 + 文件路径。 */
export const checkpointDiffs = new BoundedCache<DiffResponse>(400)
export const workspaceStatuses = new BoundedCache<WorkspaceStatus>(16)
/** key：sessionKey + 用户消息 id。消息 id 对应的文字不会变。 */
export const turnPrompts = new BoundedCache<string>(400)
