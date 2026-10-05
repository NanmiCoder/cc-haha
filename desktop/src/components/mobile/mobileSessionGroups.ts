import type { SessionListItem } from '../../types/session'
import {
  buildSidebarTaskGroups,
  getSessionProjectKey,
  type SidebarTaskGroupId,
} from '../layout/sidebarTaskGroups'

/**
 * The phone list's sections, most urgent first: sessions waiting on the
 * person, then sessions working, then the same day buckets the desktop task
 * view uses. A session appears in exactly one section.
 */
export type MobileSessionGroupId = 'attention' | SidebarTaskGroupId

export type MobileSessionGroup = {
  id: MobileSessionGroupId
  sessions: SessionListItem[]
}

export function buildMobileSessionGroups(
  sessions: readonly SessionListItem[],
  runningIds: ReadonlySet<string>,
  attentionIds: ReadonlySet<string>,
  now: number,
): MobileSessionGroup[] {
  const attention: SessionListItem[] = []
  const rest: SessionListItem[] = []
  for (const session of sessions) {
    if (attentionIds.has(session.id)) attention.push(session)
    else rest.push(session)
  }

  const groups: MobileSessionGroup[] = []
  if (attention.length > 0) {
    groups.push({
      id: 'attention',
      sessions: [...attention].sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt)),
    })
  }
  return [...groups, ...buildSidebarTaskGroups(rest, runningIds, now)]
}

export type MobileProjectFilter = {
  key: string
  label: string
}

/** Projects in the order of their most recent session, for the filter chips. */
export function listMobileProjectFilters(
  sessions: readonly SessionListItem[],
  labelFor: (session: SessionListItem) => string,
): MobileProjectFilter[] {
  const seen = new Map<string, MobileProjectFilter>()
  const newestFirst = [...sessions].sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt))
  for (const session of newestFirst) {
    const key = getSessionProjectKey(session)
    if (!seen.has(key)) seen.set(key, { key, label: labelFor(session) })
  }
  return [...seen.values()]
}

export function filterMobileSessions(
  sessions: readonly SessionListItem[],
  { projectKey, query }: { projectKey: string | null; query: string },
): SessionListItem[] {
  const needle = query.trim().toLocaleLowerCase()
  return sessions.filter((session) => {
    if (projectKey && getSessionProjectKey(session) !== projectKey) return false
    if (needle && !(session.title || '').toLocaleLowerCase().includes(needle)) return false
    return true
  })
}
