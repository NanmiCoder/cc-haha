import type { SessionListItem } from '../../types/session'

/**
 * Sections of the task view. `running` is a status section; the other five bucket by the
 * calendar day of last activity. Order is render order.
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
 * Folder name shown on a task row's second line. Same rule as `groupByProject` group titles:
 * the user's rename if any, otherwise the last path segment.
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
 * The difference in calendar days, not in 24-hour periods. A task finished at 23:50 and opened
 * at 00:10 the next day must land in "Yesterday"; counting 24 hours would keep it in "Today".
 *
 * Two local midnights are 23 or 25 hours apart on DST change days; `round` brings that back to whole days.
 */
function calendarDaysAgo(timestamp: number, now: number): number {
  return Math.round((startOfLocalDay(now) - startOfLocalDay(timestamp)) / DAY_MS)
}

function resolveTimeGroupId(timestamp: number, now: number): SidebarTaskGroupId {
  const daysAgo = calendarDaysAgo(timestamp, now)
  // Future timestamps (clock drift / mismatched machine time zones) go to today rather than "Earlier".
  if (daysAgo <= 0) return 'today'
  if (daysAgo === 1) return 'yesterday'
  if (daysAgo <= 7) return 'last7Days'
  if (daysAgo <= 30) return 'last30Days'
  return 'earlier'
}

/**
 * Split sessions into task-view sections. Running sessions appear only in `running`, not again
 * by time. Empty sections are omitted, so callers can map directly.
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
