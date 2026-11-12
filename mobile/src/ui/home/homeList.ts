import type { DashboardRow, MobileActivity } from '../../core/dashboard'
import {
  decisionAction,
  decisionKind,
  outcomeLine,
  projectOf,
  settledOutcome,
  stalledLabel,
  type Outcome,
  type Project,
} from './homeModel'

/* Pure logic of the light home: status filter, Recent selection, grouping by project with auto-expansion, row status text. */

/* ───────────── Status filter ───────────── */

export type HomeFilter = 'all' | 'waiting' | 'running'

export type HomeCounts = { waiting: number; running: number }

export function homeCounts(rows: readonly DashboardRow[]): HomeCounts {
  let waiting = 0
  let running = 0
  for (const row of rows) {
    const state = row.activity?.activityState
    if (state === 'waiting') waiting++
    else if (state === 'running') running++
  }
  return { waiting, running }
}

/** Pills list only items with content: All is always there, "Waiting for your decision" and "In progress" hidden without sessions. */
export function filterOptions(counts: HomeCounts) {
  const options: { value: HomeFilter; label: string; count?: number }[] = [
    { value: 'all', label: 'All' },
  ]
  if (counts.waiting) options.push({ value: 'waiting', label: 'Waiting for your decision', count: counts.waiting })
  if (counts.running) options.push({ value: 'running', label: 'In progress', count: counts.running })
  return options
}

/** When the chosen filter no longer has sessions (e.g. decisions handled) go back to "All" instead of leaving an empty list. */
export function resolveFilter(filter: HomeFilter, counts: HomeCounts): HomeFilter {
  if (filter === 'waiting' && !counts.waiting) return 'all'
  if (filter === 'running' && !counts.running) return 'all'
  return filter
}

export function applyFilter(rows: readonly DashboardRow[], filter: HomeFilter) {
  if (filter === 'all') return [...rows]
  return rows.filter((row) => row.activity?.activityState === filter)
}

/* ───────────── Recent ───────────── */

export const recentLimit = 5

/**
 * "Recent": take the first few of rows sorted by recent activity; sessions waiting for your decision stay in no matter how old, 
 * and the rest fill up to limit. Return order matches input order.
 */
export function recentRows(rows: readonly DashboardRow[], limit = recentLimit) {
  const picked = new Set<DashboardRow>()
  for (const row of rows) if (row.activity?.activityState === 'waiting') picked.add(row)
  for (const row of rows) {
    if (picked.size >= limit) break
    picked.add(row)
  }
  return rows.filter((row) => picked.has(row))
}

/* ───────────── Project grouping ───────────── */

export type ProjectGroup = Project & {
  /** Sessions to list under a project: those already in Recent are not repeated. */
  rows: DashboardRow[]
  /** Has sessions below to expand; projects whose sessions are all in Recent have none, so you cannot open an empty list. */
  expandable: boolean
  /** Total sessions in this project (including those already in Recent). */
  total: number
  waiting: number
  running: number
  expanded: boolean
}

/**
 * Group by project (rows already sorted by recent activity descending, projects with recent activity first).
 * By default expand only the most recent project, plus projects with sessions waiting for your decision / running; 
 * overrides is the result of the user manually expanding or collapsing, taking priority over defaults. Sessions without a project directory do not go into the projects section.
 * exclude rows in it (already in Recent) are no longer listed under the project, but still count toward the project total and the waiting / running hints.
 */
export function projectGroups(
  rows: readonly DashboardRow[],
  overrides: Readonly<Record<string, boolean>> = {},
  exclude: ReadonlySet<DashboardRow> = new Set()
): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>()
  for (const row of rows) {
    const project = projectOf(row.session)
    if (!project) continue
    let group = groups.get(project.key)
    if (!group) {
      group = { ...project, rows: [], expandable: false, total: 0, waiting: 0, running: 0, expanded: false }
      groups.set(project.key, group)
    }
    group.total++
    if (!exclude.has(row)) group.rows.push(row)
    const state = row.activity?.activityState
    if (state === 'waiting') group.waiting++
    else if (state === 'running') group.running++
  }
  return [...groups.values()].map((group, index) => ({
    ...group,
    expandable: group.rows.length > 0,
    expanded: overrides[group.key] ?? (index === 0 || group.waiting > 0 || group.running > 0),
  }))
}

/**
 * Sessions without a project directory belong to no project, and outside Recent they would be invisible (search only): 
 * list them separately at the end of the projects section.
 */
export function looseRows(rows: readonly DashboardRow[], exclude: ReadonlySet<DashboardRow> = new Set()) {
  return rows.filter((row) => !projectOf(row.session) && !exclude.has(row))
}

/** Hint on the right of a collapsed project header: waiting for decisions first, then running; hidden if neither. */
export function projectBadge(group: Pick<ProjectGroup, 'waiting' | 'running'>) {
  if (group.waiting) return { text: `${group.waiting} waiting for your decision`, tone: 'attn' as const }
  if (group.running) return { text: `${group.running} running`, tone: 'run' as const }
  return null
}

/* ───────────── Row status ───────────── */

export type RowState = 'waiting' | 'running' | 'stalled' | Outcome

export function rowState(row: DashboardRow): RowState {
  const state = row.activity?.activityState
  if (state === 'waiting') return 'waiting'
  if (state === 'running') return row.activity?.stalled ? 'stalled' : 'running'
  return settledOutcome(row.activity)
}

export type LineTone = 'attn' | 'err' | 'ink3'

/** Subline of a Recent row: project name · status / current step. While running only the current step (monospace), falling back to the project name. */
export function recentLine(
  row: DashboardRow,
  now: number
): { text: string; tone: LineTone; mono: boolean } {
  const project = projectOf(row.session)?.name
  const state = rowState(row)
  switch (state) {
    case 'waiting':
      return {
        text: [project, decisionAction(row.activity)].filter(Boolean).join(' · '),
        tone: 'attn',
        mono: false,
      }
    case 'running':
      return {
        text: row.activity?.preview?.trim() || project || 'Working',
        tone: 'ink3',
        mono: true,
      }
    case 'stalled':
      return { text: stalledLabel(row.activity, now), tone: 'attn', mono: false }
    default:
      return {
        text: outcomeLine(state, project),
        tone: state === 'failed' ? 'err' : 'ink3',
        mono: false,
      }
  }
}

/** Short form of waiting for your decision (the full action does not fit on the right of session rows under projects). */
export function waitingShort(activity?: MobileActivity) {
  const kind = decisionKind(activity)
  if (kind === 'question') return 'Asking you'
  if (kind === 'plan' || kind === 'team') return 'Waiting for you'
  return 'Waiting for your decision'
}

/** Right side of session rows under projects: states needing attention use text; running ticks seconds and others show relative time handled by the component, so null here. */
export function projectTrailing(row: DashboardRow): { text: string; tone: LineTone } | null {
  switch (rowState(row)) {
    case 'waiting':
      return { text: waitingShort(row.activity), tone: 'attn' }
    case 'stalled':
      return { text: 'No progress', tone: 'attn' }
    case 'failed':
      return { text: 'Stopped with error', tone: 'err' }
    default:
      return null
  }
}

/** Status words for screen readers. */
export function stateWords(state: RowState) {
  switch (state) {
    case 'waiting':
      return 'Waiting for your decision'
    case 'running':
      return 'In progress'
    case 'stalled':
      return 'No progress'
    case 'failed':
      return 'Stopped with error'
    case 'stopped':
      return 'You stopped'
    case 'review':
      return 'Done, unviewed'
    case 'done':
      return 'Done'
    default:
      return ''
  }
}
