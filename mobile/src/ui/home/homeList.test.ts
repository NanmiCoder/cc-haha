import { expect, test } from 'bun:test'
import type { DashboardRow, MobileActivity } from '../../core/dashboard'
import type { Session } from '../../core/types'
import {
  applyFilter,
  filterOptions,
  homeCounts,
  projectBadge,
  looseRows,
  projectGroups,
  projectTrailing,
  recentLine,
  recentRows,
  resolveFilter,
  rowState,
  stateWords,
  waitingShort,
} from './homeList'

const session = (id: string, dir: string | null, extra: Partial<Session> = {}): Session => ({
  id,
  title: id,
  createdAt: '2026-10-24T10:00:00',
  modifiedAt: '2026-10-24T10:00:00',
  messageCount: 2,
  projectPath: dir ?? '',
  workDir: dir,
  workDirExists: true,
  ...extra,
})
const act = (state: MobileActivity['activityState'], extra: Partial<MobileActivity> = {}) => ({
  id: 'x',
  activityState: state,
  ...extra,
})
const row = (id: string, dir: string | null, activity?: MobileActivity): DashboardRow => ({
  session: session(id, dir),
  activity,
})

const a = '/w/alpha'
const b = '/w/beta'
const c = '/w/gamma'

test('filter pills only list states that have sessions and fall back to all when emptied', () => {
  const rows = [
    row('1', a, act('waiting')),
    row('2', a, act('running')),
    row('3', b, act('running')),
    row('4', b, act('idle', { terminalOutcome: 'completed' })),
  ]
  const counts = homeCounts(rows)
  expect(counts).toEqual({ waiting: 1, running: 2 })
  expect(filterOptions(counts)).toEqual([
    { value: 'all', label: '全部' },
    { value: 'waiting', label: '等你决定', count: 1 },
    { value: 'running', label: '进行中', count: 2 },
  ])
  expect(filterOptions({ waiting: 0, running: 3 }).map((o) => o.value)).toEqual(['all', 'running'])
  expect(filterOptions({ waiting: 0, running: 0 }).map((o) => o.value)).toEqual(['all'])

  expect(resolveFilter('waiting', counts)).toBe('waiting')
  expect(resolveFilter('waiting', { waiting: 0, running: 2 })).toBe('all')
  expect(resolveFilter('running', { waiting: 1, running: 0 })).toBe('all')
  expect(resolveFilter('all', { waiting: 0, running: 0 })).toBe('all')

  expect(applyFilter(rows, 'all')).toHaveLength(4)
  expect(applyFilter(rows, 'waiting').map((r) => r.session.id)).toEqual(['1'])
  expect(applyFilter(rows, 'running').map((r) => r.session.id)).toEqual(['2', '3'])
})

test('recent keeps every waiting session and fills the rest by recency, in the given order', () => {
  const rows = [
    row('new1', a, act('idle')),
    row('new2', a, act('running')),
    row('new3', b, act('idle')),
    row('old-waiting', c, act('waiting')),
    row('old1', c, act('idle')),
  ]
  expect(recentRows(rows, 3).map((r) => r.session.id)).toEqual(['new1', 'new2', 'old-waiting'])
  expect(recentRows(rows, 1).map((r) => r.session.id)).toEqual(['old-waiting'])
  expect(recentRows(rows, 10)).toHaveLength(5)
  expect(recentRows([], 5)).toEqual([])
  const manyWaiting = [row('w1', a, act('waiting')), row('w2', b, act('waiting')), row('i', c)]
  expect(recentRows(manyWaiting, 1).map((r) => r.session.id)).toEqual(['w1', 'w2'])
})

test('only the latest project and projects with live sessions start expanded', () => {
  const rows = [
    row('1', a, act('idle')),
    row('2', b, act('idle')),
    row('3', c, act('running')),
    row('4', b, act('waiting')),
    row('5', '/w/delta', act('idle')),
    row('6', null, act('running')),
  ]
  const groups = projectGroups(rows)
  expect(groups.map((g) => [g.name, g.expanded])).toEqual([
    ['alpha', true],
    ['beta', true],
    ['gamma', true],
    ['delta', false],
  ])
  expect(groups.find((g) => g.name === 'beta')).toMatchObject({ waiting: 1, running: 0 })
  expect(groups.find((g) => g.name === 'beta')!.rows.map((r) => r.session.id)).toEqual(['2', '4'])
  // 没有项目目录的会话不进项目段。
  expect(groups.flatMap((g) => g.rows).some((r) => r.session.id === '6')).toBe(false)
})

test('sessions already shown under 最近 are not repeated under their project', () => {
  const rows = [row('1', a, act('waiting')), row('2', a), row('3', a), row('4', b)]
  const recent = new Set([rows[0], rows[1]])
  const groups = projectGroups(rows, {}, recent)
  const alpha = groups.find((g) => g.name === 'alpha')!
  expect(alpha.rows.map((r) => r.session.id)).toEqual(['3'])
  // 总数和「等你决定」提示仍然把已在最近里的会话算进去。
  expect(alpha).toMatchObject({ total: 3, waiting: 1 })
  expect(groups.find((g) => g.name === 'beta')!.rows.map((r) => r.session.id)).toEqual(['4'])
  // 全部会话都在最近里的项目仍然保留项目头。
  const only = row('5', c)
  const all = projectGroups([only], {}, new Set([only]))
  expect(all.map((g) => [g.name, g.rows.length, g.total])).toEqual([['gamma', 0, 1]])
})

test('a quiet history collapses everything except the most recent project', () => {
  const rows = [row('1', a), row('2', b), row('3', c)]
  expect(projectGroups(rows).map((g) => g.expanded)).toEqual([true, false, false])
})

test('manual toggles beat the defaults in both directions', () => {
  const rows = [row('1', a, act('idle')), row('2', b, act('running')), row('3', c, act('idle'))]
  const groups = projectGroups(rows, { [a]: false, [b]: false, [c]: true })
  expect(groups.map((g) => [g.name, g.expanded])).toEqual([
    ['alpha', false],
    ['beta', false],
    ['gamma', true],
  ])
})

test('collapsed project headers call out waiting before running', () => {
  expect(projectBadge({ waiting: 1, running: 2 })).toEqual({ text: '1 个等你决定', tone: 'attn' })
  expect(projectBadge({ waiting: 0, running: 1 })).toEqual({ text: '1 个运行中', tone: 'run' })
  expect(projectBadge({ waiting: 0, running: 0 })).toBeNull()
})

test('row state separates stalled runs and maps settled outcomes', () => {
  expect(rowState(row('1', a, act('waiting')))).toBe('waiting')
  expect(rowState(row('1', a, act('running')))).toBe('running')
  expect(rowState(row('1', a, act('running', { stalled: true })))).toBe('stalled')
  expect(rowState(row('1', a, act('failed')))).toBe('failed')
  expect(rowState(row('1', a, act('review')))).toBe('review')
  expect(rowState(row('1', a, act('idle', { terminalOutcome: 'stopped' })))).toBe('stopped')
  expect(rowState(row('1', a, act('idle', { terminalOutcome: 'completed' })))).toBe('done')
  expect(rowState(row('1', a))).toBe('unknown')
})

test('recent sub-lines read project and state, and never invent a result', () => {
  const now = Date.parse('2026-10-24T12:00:00')
  expect(
    recentLine(row('1', a, act('waiting', { toolName: 'Bash', requestId: 'r' })), now)
  ).toEqual({ text: 'alpha · 想运行命令', tone: 'attn', mono: false })
  expect(
    recentLine(row('1', a, act('running', { preview: '  运行 bun test  ' })), now)
  ).toEqual({ text: '运行 bun test', tone: 'ink3', mono: true })
  expect(recentLine(row('1', a, act('running')), now).text).toBe('alpha')
  expect(recentLine(row('1', null, act('running')), now).text).toBe('正在处理')
  expect(
    recentLine(
      row('1', a, act('running', { stalled: true, lastProgressAt: now - 5 * 60000 })),
      now
    )
  ).toEqual({ text: '5 分钟没有进展', tone: 'attn', mono: false })
  expect(recentLine(row('1', a, act('idle', { terminalOutcome: 'completed' })), now)).toEqual({
    text: 'alpha · 已完成',
    tone: 'ink3',
    mono: false,
  })
  expect(recentLine(row('1', a, act('failed')), now)).toEqual({
    text: '出错停下 · alpha',
    tone: 'err',
    mono: false,
  })
  // 历史会话没有活动记录时只写项目名。
  expect(recentLine(row('1', a), now).text).toBe('alpha')
})

test('project rows only get a text status for states that need attention', () => {
  expect(waitingShort(act('waiting', { toolName: 'AskUserQuestion' }))).toBe('在问你')
  expect(waitingShort(act('waiting', { toolName: 'ExitPlanMode' }))).toBe('等你确认')
  expect(waitingShort(act('waiting', { toolName: 'Bash', requestId: 'r' }))).toBe('等你决定')
  expect(waitingShort(undefined)).toBe('等你决定')
  expect(projectTrailing(row('1', a, act('waiting', { toolName: 'AskUserQuestion' })))).toEqual({
    text: '在问你',
    tone: 'attn',
  })
  expect(projectTrailing(row('1', a, act('failed')))).toEqual({ text: '出错停下', tone: 'err' })
  expect(projectTrailing(row('1', a, act('running', { stalled: true })))).toEqual({
    text: '没有进展',
    tone: 'attn',
  })
  expect(projectTrailing(row('1', a, act('running')))).toBeNull()
  expect(projectTrailing(row('1', a, act('idle', { terminalOutcome: 'completed' })))).toBeNull()
})

test('every visible state has words for screen readers except unknown history', () => {
  expect(stateWords('waiting')).toBe('等你决定')
  expect(stateWords('review')).toBe('已完成，未查看')
  expect(stateWords('unknown')).toBe('')
})

test('a project whose sessions are all under 最近 is not expandable; loose sessions get their own list', () => {
  const only = row('5', c)
  const [group] = projectGroups([only], {}, new Set([only]))
  expect(group).toMatchObject({ expandable: false, total: 1 })
  const [other] = projectGroups([row('6', c), row('7', c)], {}, new Set([row('x', c)]))
  expect(other.expandable).toBe(true)

  const orphan = row('8', null)
  const shown = row('9', null)
  expect(looseRows([orphan, shown, row('10', a)], new Set([shown])).map((r) => r.session.id)).toEqual(['8'])
})
