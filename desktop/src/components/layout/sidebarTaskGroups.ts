import type { SessionListItem } from '../../types/session'

/**
 * 任务视图的分段。`running` 是状态段，其余五段是「最后活动时间」的自然日分桶。
 * 顺序即渲染顺序。
 */
export type SidebarTaskGroupId =
  | 'running'
  | 'today'
  | 'yesterday'
  | 'last7Days'
  | 'last30Days'
  | 'earlier'

export type SidebarTaskGroup = {
  id: SidebarTaskGroupId
  sessions: SessionListItem[]
}

const TIME_GROUP_ORDER: readonly SidebarTaskGroupId[] = [
  'today',
  'yesterday',
  'last7Days',
  'last30Days',
  'earlier',
]

const DAY_MS = 24 * 60 * 60 * 1000

export function getSessionProjectKey(session: SessionListItem): string {
  return session.projectRoot || session.workDir || session.projectPath || 'unknown'
}

export function projectTitle(pathLike: string | null | undefined): string {
  if (!pathLike) return 'Unknown project'
  const normalized = pathLike.replace(/[\\/]+$/, '')
  const segments = normalized.split(/[\\/]/).filter(Boolean)
  const last = segments[segments.length - 1]
  if (last) return last
  return normalized || 'Unknown project'
}

export function normalizePathForCompare(pathLike: string): string {
  return pathLike.replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * macOS exposes `/var`, `/tmp` and `/etc` through symlinks into `/private`, and
 * the two halves of a session can disagree about which spelling they carry:
 * the project root is resolved through git (real path), the work dir is kept
 * as the user's shell typed it. Treat the two spellings as one place, or every
 * session under a temp directory reads as a separate worktree.
 */
function stripPrivateAlias(pathLike: string): string {
  return pathLike.replace(/^\/private(?=\/(?:var|tmp|etc)(?:\/|$))/, '')
}

export function isSameOrChildPath(childPath: string, parentPath: string): boolean {
  const child = stripPrivateAlias(normalizePathForCompare(childPath))
  const parent = stripPrivateAlias(normalizePathForCompare(parentPath))
  return child === parent || child.startsWith(`${parent}/`)
}

export function isWorktreeSession(session: SessionListItem): boolean {
  if (!session.workDir) return false
  if (/[\\/]\.claude[\\/]worktrees[\\/]/.test(session.workDir)) return true
  if (!session.projectRoot || session.workDir === session.projectRoot) return false
  return !isSameOrChildPath(session.workDir, session.projectRoot)
}

/**
 * 任务行第二行显示的所属目录名。与 `groupByProject` 的组标题同一套口径：
 * 用户改过名就用改过的名字，否则取路径末段。
 */
export function getSessionWorkspaceLabel(
  session: SessionListItem,
  displayNameForProject: (projectKey: string) => string | null,
): string {
  const projectKey = getSessionProjectKey(session)
  const displayName = displayNameForProject(projectKey)
  if (displayName) return displayName
  return projectTitle(session.projectRoot || session.workDir || projectKey)
}

export function getSessionModifiedTime(session: SessionListItem): number {
  const timestamp = new Date(session.modifiedAt ?? 0).getTime()
  return Number.isFinite(timestamp) ? timestamp : 0
}

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/**
 * 自然日之差，不是「距今多少个 24 小时」。晚上 23:50 跑完的任务，第二天
 * 00:10 打开必须落在「昨天」——按 24 小时算会把它留在「今天」。
 *
 * 两个本地零点之差在夏令时切换日是 23 或 25 小时，`round` 把它归回整数天。
 */
function calendarDaysAgo(timestamp: number, now: number): number {
  return Math.round((startOfLocalDay(now) - startOfLocalDay(timestamp)) / DAY_MS)
}

function resolveTimeGroupId(timestamp: number, now: number): SidebarTaskGroupId {
  const daysAgo = calendarDaysAgo(timestamp, now)
  // 未来时间戳（时钟漂移 / 机器时区不一致）归到今天，而不是掉进「更早」。
  if (daysAgo <= 0) return 'today'
  if (daysAgo === 1) return 'yesterday'
  if (daysAgo <= 7) return 'last7Days'
  if (daysAgo <= 30) return 'last30Days'
  return 'earlier'
}

/**
 * 把会话切成任务视图的分段。正在跑的会话只出现在 `running` 段，不再按时间
 * 重复一次。空段不产出，调用方可以直接 map。
 */
export function buildSidebarTaskGroups(
  sessions: SessionListItem[],
  runningSessionIds: ReadonlySet<string>,
  now: number,
): SidebarTaskGroup[] {
  const running: SessionListItem[] = []
  const buckets = new Map<SidebarTaskGroupId, SessionListItem[]>()

  for (const session of sessions) {
    if (runningSessionIds.has(session.id)) {
      running.push(session)
      continue
    }
    const groupId = resolveTimeGroupId(getSessionModifiedTime(session), now)
    const items = buckets.get(groupId)
    if (items) items.push(session)
    else buckets.set(groupId, [session])
  }

  const newestFirst = (a: SessionListItem, b: SessionListItem) =>
    getSessionModifiedTime(b) - getSessionModifiedTime(a)

  const groups: SidebarTaskGroup[] = []
  if (running.length > 0) {
    groups.push({ id: 'running', sessions: [...running].sort(newestFirst) })
  }
  for (const groupId of TIME_GROUP_ORDER) {
    const items = buckets.get(groupId)
    if (items && items.length > 0) {
      groups.push({ id: groupId, sessions: [...items].sort(newestFirst) })
    }
  }
  return groups
}
