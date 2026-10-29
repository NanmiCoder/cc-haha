import { expect, test } from 'bun:test'
import { dailyCron } from './operations'
import {
  dayTimeLabel,
  isClockValid,
  latestByTask,
  latestRunLine,
  newestFirst,
  nextDayLabel,
  nextRunAt,
  parseDailyCron,
  projectLabel,
  runDuration,
  runResultLine,
  scheduleParts,
  taskScheduleParts,
  taskNextRunLabel,
  type RunSummary,
} from './schedulesView'

// 2026-10-23 是周五。全部用本地时间构造，测试不依赖运行机器的时区。
const at = (day: number, hour: number, minute = 0, month = 9, year = 2026) =>
  new Date(year, month, day, hour, minute, 0, 0)
const run = (patch: Partial<RunSummary>): RunSummary => ({
  id: 'r',
  taskId: 't',
  startedAt: at(23, 9).toISOString(),
  status: 'completed',
  ...patch,
})

test('schedule captions cover desktop frequencies without changing their meaning', () => {
  expect(parseDailyCron('0 9 * * *')).toEqual({ hour: 9, minute: 0, weekdays: false })
  expect(parseDailyCron('30 23 * * 1-5')).toEqual({ hour: 23, minute: 30, weekdays: true })
  for (const cron of ['0 10 * * 1', '*/15 * * * *', '0 9 1 * *', '60 9 * * *', '0 24 * * *', ''])
    expect(parseDailyCron(cron)).toBeNull()
  expect(scheduleParts('5 9 * * 1-5')).toEqual({ repeat: '工作日', time: '09:05' })
  expect(scheduleParts('0 18 * * 5')).toEqual({ repeat: '每周五', time: '18:00' })
  expect(scheduleParts('0 10 * * 1,3,5')).toEqual({ repeat: '每周一、三、五', time: '10:00' })
  expect(scheduleParts('0 10 * * 0,6')).toEqual({ repeat: '每周六、日', time: '10:00' })
  expect(scheduleParts('*/15 * * * *')).toEqual({ repeat: '每 15 分钟', time: '' })
  expect(scheduleParts('30 */4 * * *')).toEqual({ repeat: '每 4 小时', time: '第 30 分钟' })
  expect(scheduleParts('0 9 28 * *')).toEqual({ repeat: '每月 28 号', time: '09:00' })
  expect(scheduleParts('0 9 1,15 * *')).toBeNull()
})

test('next run rolls to tomorrow once today has passed, and skips weekends for workdays', () => {
  expect(nextRunAt('0 9 * * *', at(23, 8, 59))).toEqual(at(23, 9))
  // Exactly at the trigger minute counts as already fired.
  expect(nextRunAt('0 9 * * *', at(23, 9))).toEqual(at(24, 9))
  expect(nextRunAt('30 23 * * *', at(23, 23, 40))).toEqual(at(24, 23, 30))
  // Friday evening → Monday morning.
  expect(nextRunAt('0 9 * * 1-5', at(23, 10))).toEqual(at(26, 9))
  // Saturday → Monday; Monday before the time → same day.
  expect(nextRunAt('0 9 * * 1-5', at(24, 7))).toEqual(at(26, 9))
  expect(nextRunAt('0 9 * * 1-5', at(26, 7))).toEqual(at(26, 9))
  // Month rollover.
  expect(nextRunAt('0 9 * * *', at(31, 12))).toEqual(at(1, 9, 0, 10))
  // Weekly: Friday morning → next Monday; same weekday before the time → today.
  expect(nextRunAt('0 10 * * 1', at(23, 8))).toEqual(at(26, 10))
  expect(nextRunAt('0 18 * * 5', at(23, 8))).toEqual(at(23, 18))
  expect(nextRunAt('0 18 * * 5', at(23, 18))).toEqual(at(30, 18))
  expect(nextRunAt('0 9 * * 7', at(23, 8))).toEqual(at(25, 9))
  expect(nextRunAt('*/15 * * * *', at(23, 8))).toBeNull()
})

test('day/time labels say today, yesterday, tomorrow, otherwise M/D', () => {
  const now = at(23, 12)
  expect(dayTimeLabel(at(23, 9), now)).toBe('今天 09:00')
  expect(dayTimeLabel(at(22, 23, 30), now)).toBe('昨天 23:30')
  expect(dayTimeLabel(at(24, 9), now)).toBe('明天 09:00')
  expect(dayTimeLabel(at(21, 23, 30), now)).toBe('10/21 23:30')
  expect(dayTimeLabel(at(1, 0, 5, 0), now)).toBe('1/1 00:05')
  expect(dayTimeLabel(at(31, 8, 0, 11, 2025), now)).toBe('2025/12/31 08:00')
  expect(dayTimeLabel(at(22, 23, 59).toISOString(), at(23, 0, 1))).toBe('昨天 23:59')
  expect(dayTimeLabel('not a date', now)).toBe('')
})

test('next-day label only names the day', () => {
  const now = at(23, 12)
  expect(nextDayLabel(at(23, 23, 30), now)).toBe('今晚')
  expect(nextDayLabel(at(23, 14), now)).toBe('今天')
  expect(nextDayLabel(at(24, 9), now)).toBe('明天')
  expect(nextDayLabel(at(26, 9), now)).toBe('周一')
  expect(nextDayLabel(at(3, 9, 0, 10), now)).toBe('11/3')
})

test('latest run line covers never-run, success with next, failure and running', () => {
  const now = at(23, 12)
  expect(latestRunLine(undefined, '0 9 * * *', now)).toEqual({ tone: 'none', text: '还没有执行记录' })
  expect(latestRunLine(run({}), '0 9 * * *', now)).toEqual({
    tone: 'ok',
    text: '今天 09:00 完成 · 下次明天 09:00',
  })
  expect(latestRunLine(run({}), '0 10 * * 1', now)).toEqual({
    tone: 'ok',
    text: '今天 09:00 完成 · 下次周一 10:00',
  })
  expect(latestRunLine(run({}), '*/15 * * * *', now)).toEqual({ tone: 'ok', text: '今天 09:00 完成' })
  expect(
    latestRunLine(run({ status: 'failed', startedAt: at(22, 23, 30).toISOString() }), '30 23 * * *', now)
  ).toEqual({ tone: 'err', text: '昨天 23:30 失败 · 点开看结果' })
  expect(latestRunLine(run({ status: 'timeout' }), '0 9 * * *', now).tone).toBe('err')
  expect(latestRunLine(run({ status: 'running' }), '0 9 * * *', now)).toEqual({
    tone: 'run',
    text: '今天 09:00 开始 · 正在执行',
  })
})

test('run result line uses real previews when the computer sends them', () => {
  expect(runResultLine(run({}))).toEqual({ tone: 'ok', text: '完成' })
  expect(runResultLine(run({ outputPreview: '\n  全部通过\n第二行' }))).toEqual({
    tone: 'ok',
    text: '完成 · 全部通过',
  })
  expect(runResultLine(run({ status: 'failed' }))).toEqual({ tone: 'err', text: '失败 · 点开看结果' })
  expect(runResultLine(run({ status: 'failed', error: '2 个用例没过' }))).toEqual({
    tone: 'err',
    text: '失败 · 2 个用例没过',
  })
  expect(runResultLine(run({ status: 'timeout' })).tone).toBe('attn')
  expect(runResultLine(run({ status: 'running' }))).toEqual({ tone: 'run', text: '正在执行' })
})

test('run duration prefers durationMs, then timestamps, and counts running runs to now', () => {
  expect(runDuration(run({ durationMs: 521000 }))).toBe('8:41')
  expect(
    runDuration(run({ durationMs: undefined, completedAt: at(23, 9, 7).toISOString() }))
  ).toBe('7:00')
  expect(runDuration(run({ durationMs: undefined }))).toBe('')
  expect(
    runDuration(run({ status: 'running' }), at(23, 10, 1).getTime())
  ).toBe('1:01:00')
})

test('project label falls back to the computer default directory', () => {
  expect(projectLabel('/Users/me/code/cc-haha/')).toBe('cc-haha')
  expect(projectLabel('C:\\work\\blog')).toBe('blog')
  expect(projectLabel(undefined)).toBe('电脑默认目录')
  expect(projectLabel('')).toBe('电脑默认目录')
})

test('runs are shown newest first', () => {
  const runs = [
    run({ id: 'old', startedAt: at(21, 9).toISOString() }),
    run({ id: 'new', startedAt: at(23, 9).toISOString() }),
    run({ id: 'mid', startedAt: at(22, 9).toISOString() }),
  ]
  expect(newestFirst(runs).map((item) => item.id)).toEqual(['new', 'mid', 'old'])
})

test('time validation matches the cron builder exactly', () => {
  for (const time of ['09:00', '9:05', '0:00', '23:59', ' 07:30 '])
    expect(isClockValid(time)).toBe(true)
  for (const time of ['24:00', '12:60', '9', '09:0', 'ab:cd', '', '123:00'])
    expect(isClockValid(time)).toBe(false)
  for (const time of ['09:00', '24:00', '9:5', '23:59'])
    expect(isClockValid(time)).toBe((() => {
      try {
        dailyCron(time, false)
        return true
      } catch {
        return false
      }
    })())
})

test('explicit plans display their own timezone and use server occurrences, including one-time completion', () => {
  const schedule = { kind: 'once' as const, runAt: '2035-10-27T01:00:00Z', timeZone: 'Asia/Shanghai' }
  const task = { id: 'once', prompt: 'check', cron: '', schedule, createdAt: 0 }
  expect(taskScheduleParts(task)).toEqual({ repeat: '仅一次', time: '2035-10-27 09:00' })
  const now = new Date('2035-10-26T00:00:00Z')
  expect(nextRunAt(task, now)).toEqual(new Date(schedule.runAt))
  expect(nextRunAt({ ...task, scheduleState: 'completed' }, now)).toBeNull()
  expect(nextRunAt({ ...task, enabled: false }, now)).toBeNull()
  expect(nextRunAt({ ...task, schedule: { kind: 'cron', expression: '0 9 * * *', timeZone: 'America/New_York' }, nextRunAt: Date.parse('2035-10-26T13:00:00Z') }, now)).toEqual(new Date('2035-10-26T13:00:00Z'))
  // An older computer without an occurrence must not be guessed using the phone's timezone.
  expect(nextRunAt({ ...task, schedule: undefined, cron: '0 9 * * *' }, now)).toBeNull()
  const boundary = new Date('2035-10-26T23:00:00Z')
  expect(taskNextRunLabel(task, new Date(schedule.runAt), boundary)).toBe('今天 09:00')
  expect(latestRunLine(run({}), task, boundary).text.endsWith('下次今天 09:00')).toBe(true)
})

test('latest run per task keeps the newest start', () => {
  const latest = latestByTask([
    run({ id: 'a1', taskId: 'a', startedAt: at(21, 9).toISOString() }),
    run({ id: 'b1', taskId: 'b', startedAt: at(22, 9).toISOString() }),
    run({ id: 'a2', taskId: 'a', startedAt: at(23, 9).toISOString() }),
    run({ id: 'a0', taskId: 'a', startedAt: at(20, 9).toISOString() }),
  ])
  expect(latest.get('a')?.id).toBe('a2')
  expect(latest.get('b')?.id).toBe('b1')
  expect(latest.has('c')).toBe(false)
})
