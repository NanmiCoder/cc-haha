import { formatDuration } from './dashboard'
import type { TaskRun } from './operations'

/**
 * 定时任务页面的展示逻辑。电脑只告诉我们 cron 和运行记录；
 * “下次运行”只对手机端能可靠推算的两种计划（每天 / 工作日 HH:mm）给出，
 * 其他 cron 一律返回空，界面上不显示，避免猜错。
 */

export type DailySchedule = { hour: number; minute: number; weekdays: boolean }

/** 运行记录摘要：summaryOnly 列表不带 taskName/output/error，详情接口才带。 */
export type RunSummary = Pick<TaskRun, 'id' | 'taskId' | 'startedAt' | 'status'> &
  Partial<
    Pick<
      TaskRun,
      | 'taskName'
      | 'completedAt'
      | 'durationMs'
      | 'sessionId'
      | 'output'
      | 'error'
      | 'outputPreview'
      | 'errorPreview'
    >
  > & { hasOutput?: boolean; hasError?: boolean }

export type Tone = 'ok' | 'err' | 'attn' | 'run' | 'none'

export function parseDailyCron(cron: string): DailySchedule | null {
  const match = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5)$/.exec(cron.trim())
  if (!match) return null
  const minute = Number(match[1])
  const hour = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return { hour, minute, weekdays: match[3] === '1-5' }
}

/** 每周固定几天：m h * * d[,d…]，d 为 0–7（0 和 7 都是周日）。 */
export type WeeklySchedule = { hour: number; minute: number; days: number[] }
export function parseWeeklyCron(cron: string): WeeklySchedule | null {
  const match = /^(\d{1,2}) (\d{1,2}) \* \* ([0-7](?:,[0-7])*)$/.exec(cron.trim())
  if (!match) return null
  const minute = Number(match[1])
  const hour = Number(match[2])
  if (hour > 23 || minute > 59) return null
  const days = [...new Set(match[3]!.split(',').map((day) => Number(day) % 7))].sort(
    (a, b) => ((a + 6) % 7) - ((b + 6) % 7)
  )
  return { hour, minute, days }
}
const weekdayDigits = ['日', '一', '二', '三', '四', '五', '六']

const pad = (value: number) => String(value).padStart(2, '0')
export const clockLabel = (date: Date) =>
  `${pad(date.getHours())}:${pad(date.getMinutes())}`

/** 与 operations.dailyCron 同一规则：H:mm 或 HH:mm，0–23 时、0–59 分。 */
export function isClockValid(time: string) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim())
  return !!match && Number(match[1]) <= 23 && Number(match[2]) <= 59
}

/** 编辑执行时间的初始值：能读懂就沿用，读不懂（自定义 cron）就从每天 09:00 开始。 */
export function editableSchedule(cron: string) {
  const parsed = parseDailyCron(cron)
  return parsed
    ? { weekdays: parsed.weekdays, time: `${pad(parsed.hour)}:${pad(parsed.minute)}`, custom: false }
    : { weekdays: false, time: '09:00', custom: true }
}

/** “工作日 / 09:00” 两段，便于时间用等宽字体；不是每天/工作日时返回空。 */
export function scheduleParts(cron: string) {
  const parsed = parseDailyCron(cron)
  if (!parsed) {
    const weekly = parseWeeklyCron(cron)
    return weekly
      ? {
          repeat: `每周${weekly.days.map((day) => weekdayDigits[day]).join('、')}`,
          time: `${pad(weekly.hour)}:${pad(weekly.minute)}`,
        }
      : null
  }
  return {
    repeat: parsed.weekdays ? '工作日' : '每天',
    time: `${pad(parsed.hour)}:${pad(parsed.minute)}`,
  }
}

const isWorkday = (date: Date) => date.getDay() >= 1 && date.getDay() <= 5

/** 下一次触发时间（手机本地时区）；算不出时返回 null。 */
export function nextRunAt(cron: string, now = new Date()): Date | null {
  const parsed = parseDailyCron(cron)
  if (!parsed) {
    const weekly = parseWeeklyCron(cron)
    if (!weekly) return null
    const candidate = new Date(now)
    candidate.setHours(weekly.hour, weekly.minute, 0, 0)
    for (let index = 0; index < 8; index += 1) {
      if (candidate.getTime() > now.getTime() && weekly.days.includes(candidate.getDay()))
        return candidate
      candidate.setDate(candidate.getDate() + 1)
    }
    return null
  }
  const candidate = new Date(now)
  candidate.setHours(parsed.hour, parsed.minute, 0, 0)
  if (candidate.getTime() <= now.getTime())
    candidate.setDate(candidate.getDate() + 1)
  for (let index = 0; index < 7; index += 1) {
    if (!parsed.weekdays || isWorkday(candidate)) return candidate
    candidate.setDate(candidate.getDate() + 1)
  }
  return null
}

const dayStart = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
/** 相差的自然日：0 今天，-1 昨天，1 明天。按日历日算，不受夏令时影响。 */
function dayOffset(date: Date, now: Date) {
  return Math.round((dayStart(date) - dayStart(now)) / 86400000)
}

function toDate(value: Date | string | number) {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

/** 今天 09:00 · 昨天 23:30 · 明天 09:00 · 10/23 23:30（跨年带年份）。 */
export function dayTimeLabel(value: Date | string | number, now = new Date()) {
  const date = toDate(value)
  if (!date) return ''
  const offset = dayOffset(date, now)
  const time = clockLabel(date)
  if (offset === 0) return `今天 ${time}`
  if (offset === -1) return `昨天 ${time}`
  if (offset === 1) return `明天 ${time}`
  const day = `${date.getMonth() + 1}/${date.getDate()}`
  return date.getFullYear() === now.getFullYear()
    ? `${day} ${time}`
    : `${date.getFullYear()}/${day} ${time}`
}

const weekdayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 只说哪一天（时间已经在计划里写了）：今天 / 今晚 / 明天 / 周一 / 10/27。 */
export function nextDayLabel(value: Date, now = new Date()) {
  const offset = dayOffset(value, now)
  if (offset === 0) return value.getHours() >= 18 ? '今晚' : '今天'
  if (offset === 1) return '明天'
  if (offset > 1 && offset < 7) return weekdayNames[value.getDay()]!
  return `${value.getMonth() + 1}/${value.getDate()}`
}

/** 列表里每个任务的“最近运行”一行。 */
export function latestRunLine(
  run: RunSummary | undefined,
  cron: string,
  now = new Date()
): { tone: Tone; text: string } {
  if (!run) return { tone: 'none', text: '还没有执行记录' }
  const at = dayTimeLabel(run.startedAt, now)
  if (run.status === 'failed')
    return { tone: 'err', text: `${at} 失败 · 点开看结果` }
  if (run.status === 'timeout')
    return { tone: 'err', text: `${at} 超时 · 点开看结果` }
  if (run.status === 'running')
    return { tone: 'run', text: `${at} 开始 · 正在执行` }
  const next = nextRunAt(cron, now)
  return {
    tone: 'ok',
    text: next ? `${at} 完成 · 下次${nextDayLabel(next, now)} ${clockLabel(next)}` : `${at} 完成`,
  }
}

const firstLine = (text?: string) =>
  text
    ?.split('\n')
    .map((line) => line.trim())
    .find(Boolean)

/** 详情页“最近运行”的结果一行：有电脑给的预览就带上，没有就只说状态。 */
export function runResultLine(run: RunSummary): { tone: Tone; text: string } {
  if (run.status === 'running') return { tone: 'run', text: '正在执行' }
  if (run.status === 'completed') {
    const preview = firstLine(run.outputPreview ?? run.output)
    return { tone: 'ok', text: preview ? `完成 · ${preview}` : '完成' }
  }
  const label = run.status === 'timeout' ? '超时' : '失败'
  const preview = firstLine(run.errorPreview ?? run.error)
  return {
    tone: run.status === 'timeout' ? 'attn' : 'err',
    text: preview ? `${label} · ${preview}` : `${label} · 点开看结果`,
  }
}

/** 运行时长：结束的用 durationMs（或起止时间），运行中的算到现在。 */
export function runDuration(run: RunSummary, now = Date.now()) {
  if (typeof run.durationMs === 'number' && Number.isFinite(run.durationMs))
    return formatDuration(run.durationMs / 1000)
  const start = Date.parse(run.startedAt)
  if (!Number.isFinite(start)) return ''
  const end =
    run.status === 'running'
      ? now
      : run.completedAt
        ? Date.parse(run.completedAt)
        : NaN
  return Number.isFinite(end) ? formatDuration((end - start) / 1000) : ''
}

/** 项目名 = 目录最后一段；没指定目录时电脑在用户主目录执行。 */
export function projectLabel(folderPath?: string) {
  const name = folderPath?.split(/[\\/]/).filter(Boolean).pop()
  return name || '电脑默认目录'
}

export function newestFirst<T extends { startedAt: string }>(runs: T[]) {
  return [...runs].sort(
    (a, b) => (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0)
  )
}

/** 每个任务最近的一次运行（summaryOnly 记录也适用）。 */
export function latestByTask<T extends { taskId: string; startedAt: string }>(runs: T[]) {
  const result = new Map<string, T>()
  for (const run of runs) {
    const current = result.get(run.taskId)
    if (!current || (Date.parse(run.startedAt) || 0) > (Date.parse(current.startedAt) || 0))
      result.set(run.taskId, run)
  }
  return result
}
