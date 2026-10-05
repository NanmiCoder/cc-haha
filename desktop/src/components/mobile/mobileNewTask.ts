import type { SessionListItem } from '../../types/session'
import { getSessionProjectKey } from '../layout/sidebarTaskGroups'

const UNKNOWN_PROJECT_KEY = 'unknown'

/**
 * The folder a new task starts in when it is opened from the phone's list.
 *
 * With a project filter picked, that project: the person is looking at it.
 * Otherwise the project of the task created most recently, on any device,
 * since that is where they last chose to start work. A folder that no longer
 * exists is skipped rather than offered. Empty when there is nothing to go
 * on, which leaves the choice to the project picker.
 *
 * The project key is the session's project root (or its folder), so a task
 * last run in a worktree still starts a new one in the repository itself.
 */
export function resolveNewTaskWorkDir(
  sessions: readonly SessionListItem[],
  filterProjectKey: string | null,
): string {
  if (filterProjectKey && filterProjectKey !== UNKNOWN_PROJECT_KEY) return filterProjectKey

  let newest: SessionListItem | null = null
  for (const session of sessions) {
    if (session.workDirExists === false) continue
    if (getSessionProjectKey(session) === UNKNOWN_PROJECT_KEY) continue
    if (!newest || Date.parse(session.createdAt) > Date.parse(newest.createdAt)) newest = session
  }
  return newest ? getSessionProjectKey(newest) : ''
}
