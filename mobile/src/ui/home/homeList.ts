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

/* 轻量首页的纯逻辑：状态筛选、「最近」挑选、按项目分组与自动展开、行的状态文案。 */

/* ───────────── 状态筛选 ───────────── */

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

/** 药丸只列有内容的项：全部永远在，「等你决定」「进行中」没有会话时不显示。 */
export function filterOptions(counts: HomeCounts) {
  const options: { value: HomeFilter; label: string; count?: number }[] = [
    { value: 'all', label: '全部' },
  ]
  if (counts.waiting) options.push({ value: 'waiting', label: '等你决定', count: counts.waiting })
  if (counts.running) options.push({ value: 'running', label: '进行中', count: counts.running })
  return options
}

/** 所选筛选已经没有会话了（比如决定处理完）就回到「全部」，不留一个空列表。 */
export function resolveFilter(filter: HomeFilter, counts: HomeCounts): HomeFilter {
  if (filter === 'waiting' && !counts.waiting) return 'all'
  if (filter === 'running' && !counts.running) return 'all'
  return filter
}

export function applyFilter(rows: readonly DashboardRow[], filter: HomeFilter) {
  if (filter === 'all') return [...rows]
  return rows.filter((row) => row.activity?.activityState === filter)
}

/* ───────────── 最近 ───────────── */

export const recentLimit = 5

/**
 * 「最近」：按最近活动排好的行里取前几条；等你决定的会话不论多旧都留在里面，
 * 其余补到 limit 条。返回顺序与传入顺序一致。
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

/* ───────────── 项目分组 ───────────── */

export type ProjectGroup = Project & {
  /** 项目下要列出的会话：已经在「最近」里出现的不再重复。 */
  rows: DashboardRow[]
  /** 下面有会话可以展开；会话全都在「最近」里的项目没有，不能点开一个空列表。 */
  expandable: boolean
  /** 这个项目的会话总数（含已在「最近」里的）。 */
  total: number
  waiting: number
  running: number
  expanded: boolean
}

/**
 * 按项目分组（行已按最近活动倒序，项目按最近有动静的排在前面）。
 * 默认只展开最近的那个项目，以及有等你决定 / 运行中会话的项目；
 * overrides 是用户手动点开或收起的结果，优先于默认。没有项目目录的会话不进项目段。
 * exclude 里的行（已经在「最近」里）不再列在项目下，但仍计入项目的总数和等你决定 / 运行中的提示。
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
 * 没有项目目录的会话进不了任何项目，不在「最近」里就哪儿都看不到（只能搜索）：
 * 单独列在项目段最后。
 */
export function looseRows(rows: readonly DashboardRow[], exclude: ReadonlySet<DashboardRow> = new Set()) {
  return rows.filter((row) => !projectOf(row.session) && !exclude.has(row))
}

/** 折叠着的项目头右侧的提示：有等你决定的先说，其次是运行中；都没有就不显示。 */
export function projectBadge(group: Pick<ProjectGroup, 'waiting' | 'running'>) {
  if (group.waiting) return { text: `${group.waiting} 个等你决定`, tone: 'attn' as const }
  if (group.running) return { text: `${group.running} 个运行中`, tone: 'run' as const }
  return null
}

/* ───────────── 行状态 ───────────── */

export type RowState = 'waiting' | 'running' | 'stalled' | Outcome

export function rowState(row: DashboardRow): RowState {
  const state = row.activity?.activityState
  if (state === 'waiting') return 'waiting'
  if (state === 'running') return row.activity?.stalled ? 'stalled' : 'running'
  return settledOutcome(row.activity)
}

export type LineTone = 'attn' | 'err' | 'ink3'

/** 「最近」行的副行：项目名 · 状态 / 当前一步。运行中只写当前一步（等宽），没有就退回项目名。 */
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
        text: row.activity?.preview?.trim() || project || '正在处理',
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

/** 等你决定的短说法（项目下的会话行右侧放不下完整的动作）。 */
export function waitingShort(activity?: MobileActivity) {
  const kind = decisionKind(activity)
  if (kind === 'question') return '在问你'
  if (kind === 'plan' || kind === 'team') return '等你确认'
  return '等你决定'
}

/** 项目下的会话行右侧：需要说话的状态用文字；运行中走秒、其余显示相对时间由组件负责，这里返回 null。 */
export function projectTrailing(row: DashboardRow): { text: string; tone: LineTone } | null {
  switch (rowState(row)) {
    case 'waiting':
      return { text: waitingShort(row.activity), tone: 'attn' }
    case 'stalled':
      return { text: '没有进展', tone: 'attn' }
    case 'failed':
      return { text: '出错停下', tone: 'err' }
    default:
      return null
  }
}

/** 读屏用的状态词。 */
export function stateWords(state: RowState) {
  switch (state) {
    case 'waiting':
      return '等你决定'
    case 'running':
      return '进行中'
    case 'stalled':
      return '没有进展'
    case 'failed':
      return '出错停下'
    case 'stopped':
      return '你停止了'
    case 'review':
      return '已完成，未查看'
    case 'done':
      return '已完成'
    default:
      return ''
  }
}
