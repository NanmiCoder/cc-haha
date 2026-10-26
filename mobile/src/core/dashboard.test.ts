import { expect, test } from 'bun:test'
import {
  elapsedLabel,
  formatDuration,
  groupDashboard,
  relativeLabel,
} from './dashboard'
import type { Session } from './types'
const session = (
  id: string,
  modifiedAt = '2026-10-24T10:00:00',
  messageCount = 2
): Session => ({
  id,
  title: id,
  createdAt: modifiedAt,
  modifiedAt,
  messageCount,
  projectPath: '/tmp/project',
  workDir: '/tmp/project',
  workDirExists: true,
})
test('dashboard sorts real waiting and running before settled; failures are not completions', () => {
  const date = new Date('2026-10-24T12:00:00')
  const rows = groupDashboard(
    ['wait', 'run', 'idle', 'failed', 'unknown', 'empty'].map((x) =>
      session(x, undefined, x === 'empty' ? 0 : 2)
    ),
    [
      { id: 'wait', activityState: 'waiting' },
      { id: 'run', activityState: 'running' },
      { id: 'idle', activityState: 'idle', terminalOutcome: 'completed', completedAt: new Date('2026-10-24T10:00:00').getTime() },
      { id: 'failed', activityState: 'failed' },
      { id: 'empty', activityState: 'idle' },
    ],
    date
  )
  expect(rows.waiting.map((x) => x.session.id)).toEqual(['wait'])
  expect(rows.running.map((x) => x.session.id)).toEqual(['run'])
  expect(rows.completedToday).toBe(1)
  expect(rows.settled).toHaveLength(4)
})
test('completion count is local-day scoped and unknown historical sessions remain visible', () => {
  const rows = groupDashboard(
    [session('old', '2026-10-23T10:00:00'), session('today')],
    [
      { id: 'old', activityState: 'idle', terminalOutcome: 'completed', completedAt: new Date('2026-10-23T10:00:00').getTime() },
      { id: 'today', activityState: 'idle', terminalOutcome: 'completed', completedAt: new Date('2026-10-24T10:00:00').getTime() },
    ],
    new Date('2026-10-24T12:00:00')
  )
  expect(rows.completedToday).toBe(1)
  expect(rows.settled).toHaveLength(2)
})
test('completion requires explicit time, ignores modifiedAt, and counts a session once within its host snapshot', () => {
  const today = new Date('2026-10-24T12:00:00')
  const completedAt = new Date('2026-10-24T10:00:00').getTime()
  const sessions = [session('done', '2026-10-23T23:59:59'), session('done'), session('stopped'), session('unknown'), session('yesterday')]
  const activity = [
    { id: 'done', activityState: 'idle' as const, terminalOutcome: 'completed' as const, completedAt },
    { id: 'done', activityState: 'idle' as const, terminalOutcome: 'completed' as const, completedAt },
    { id: 'stopped', activityState: 'idle' as const },
    { id: 'unknown', activityState: 'review' as const },
    { id: 'yesterday', activityState: 'idle' as const, terminalOutcome: 'completed' as const, completedAt: new Date('2026-10-23T10:00:00').getTime() },
  ]
  expect(groupDashboard(sessions, activity, today).completedToday).toBe(1)
  expect(groupDashboard([session('done')], activity, today).completedToday).toBe(1)
  expect(groupDashboard([session('done')], [], today).completedToday).toBe(0)
})
test('elapsed and relative labels never invent running durations or future negatives', () => {
  expect(
    elapsedLabel(
      '2026-10-24T10:00:00',
      new Date('2026-10-24T10:12:04').getTime()
    )
  ).toBe('12:04')
  expect(
    relativeLabel('2026-10-24T10:00:00', new Date('2026-10-24T10:03:00'))
  ).toBe('3 分钟')
})

test('durations roll into hours and never pad the leading unit', () => {
  expect(formatDuration(0)).toBe('0:00')
  expect(formatDuration(242)).toBe('4:02')
  expect(formatDuration(768)).toBe('12:48')
  expect(formatDuration(3921)).toBe('1:05:21')
  expect(formatDuration(125 * 60 + 3)).toBe('2:05:03')
  expect(formatDuration(-5)).toBe('0:00')
  expect(
    elapsedLabel('2026-10-24T10:00:00', new Date('2026-10-24T12:05:03').getTime())
  ).toBe('2:05:03')
})

test('relative labels follow the list wording: minutes, hours today, yesterday, then month/day', () => {
  const now = new Date('2026-10-24T12:30:00')
  expect(relativeLabel('2026-10-24T12:29:40', now)).toBe('刚刚')
  expect(relativeLabel('2026-10-24T12:31:00', now)).toBe('刚刚')
  expect(relativeLabel('2026-10-24T11:50:00', now)).toBe('40 分钟')
  expect(relativeLabel('2026-10-24T11:20:00', now)).toBe('1 小时')
  expect(relativeLabel('2026-10-24T00:10:00', now)).toBe('12 小时')
  expect(relativeLabel('2026-10-23T23:10:00', now)).toBe('昨天')
  expect(relativeLabel('2026-10-21T09:00:00', now)).toBe('10/21')
})
