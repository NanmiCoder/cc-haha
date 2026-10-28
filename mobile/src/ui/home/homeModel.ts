import type { DashboardRow, MobileActivity } from '../../core/dashboard'
import type { DashboardFailure } from '../../core/dashboardSync'
import type { ScheduledTask } from '../../core/operations'
import type { Host, Session } from '../../core/types'

/* ───────────── 项目 ───────────── */

export type Project = { key: string; name: string; dir: string }

function trimSlashes(path: string) {
  return path.replace(/[\\/]+$/, '')
}

/** 项目 = 仓库根（worktree 会话归到原仓库），没有时退回工作目录。 */
export function projectOf(session: Session): Project | null {
  const dir = trimSlashes(session.projectRoot || session.workDir || '')
  const name = dir.split(/[\\/]/).filter(Boolean).pop()
  return name ? { key: dir, name, dir } : null
}

/** 按最近活动排序的项目列表（行已按 modifiedAt 倒序）。 */
export function projectsOf(rows: DashboardRow[]): (Project & { count: number })[] {
  const projects = new Map<string, Project & { count: number }>()
  for (const row of rows) {
    const project = projectOf(row.session)
    if (!project) continue
    const known = projects.get(project.key)
    if (known) known.count++
    else projects.set(project.key, { ...project, count: 1 })
  }
  return [...projects.values()]
}

export function inProject(row: DashboardRow, key: string | null) {
  return key === null || projectOf(row.session)?.key === key
}

/* ───────────── 等你决定 ───────────── */

export type DecisionKind = 'approval' | 'question' | 'plan' | 'other'

/** 只有带 requestId 的普通工具审批才能在首页直接允许/拒绝（与锁屏通知同一规则）。 */
export function decisionKind(activity?: MobileActivity): DecisionKind {
  if (activity?.toolName === 'AskUserQuestion') return 'question'
  if (activity?.toolName === 'ExitPlanMode') return 'plan'
  if (activity?.requestId && activity.toolName && activity.toolName !== 'ComputerUse')
    return 'approval'
  return 'other'
}

const fileTools = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const readTools = new Set(['Read', 'Glob', 'Grep', 'LS'])

export function decisionAction(activity?: MobileActivity) {
  const tool = activity?.toolName
  switch (decisionKind(activity)) {
    case 'question':
      return '在问你'
    case 'plan':
      return '计划写好了，等你确认'
  }
  if (!tool) return '需要你决定'
  if (tool === 'Bash' || tool === 'PowerShell') return '想运行命令'
  if (fileTools.has(tool)) return '想修改文件'
  if (readTools.has(tool)) return '想读取文件'
  if (tool === 'WebFetch') return '想访问网页'
  if (tool === 'WebSearch') return '想搜索网页'
  if (tool === 'ComputerUse') return '想操作电脑'
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  return `想使用 ${mcp ? `${mcp[1]} · ${mcp[2]}` : tool}`
}

/** 离线时等待行的说明：不同的决定写不同的动词。 */
export function pendingWhileOffline(activity?: MobileActivity) {
  const kind = decisionKind(activity)
  const verb =
    kind === 'question' ? '在等你回答' : kind === 'plan' ? '在等你确认计划' : '在等你批准'
  return `${verb} · 连上后才能处理`
}

/** 电脑在没有可展示内容时填的占位文案，首页不把它们当成命令或计划正文。 */
const placeholders = new Set([
  '需要你做决定',
  '等待你回答问题',
  '计划等待确认',
  '等待工具权限确认',
  '等待电脑操作权限确认',
])
export function previewText(activity?: MobileActivity) {
  const text = activity?.preview?.trim()
  return text && !placeholders.has(text) ? text : ''
}

/** 审批卡里的等宽单行：命令前加提示符，其他工具原样显示。 */
export function approvalPreview(activity?: MobileActivity) {
  const text = previewText(activity)
  if (!text) return ''
  return activity?.toolName === 'Bash' || activity?.toolName === 'PowerShell'
    ? `$ ${text}`
    : text
}

/** 计划正文的前两步与剩余步数；没有正文时返回 null（不编造计划）。 */
export function planPreview(activity?: MobileActivity) {
  const lines = previewText(activity)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !/^`[^`]*`$/.test(line))
  if (!lines.length) return null
  return { lines: lines.slice(0, 2), more: Math.max(0, lines.length - 2) }
}

/* ───────────── 进行中 ───────────── */

export function stalledLabel(activity: MobileActivity | undefined, now: number) {
  const since = activity?.lastProgressAt
  if (typeof since !== 'number' || !Number.isFinite(since)) return '暂时没有进展'
  const minutes = Math.floor((now - since) / 60000)
  if (minutes < 1) return '暂时没有进展'
  if (minutes < 60) return `${minutes} 分钟没有进展`
  return `${Math.floor(minutes / 60)} 小时没有进展`
}

/* ───────────── 最近 ───────────── */

export type Outcome = 'done' | 'review' | 'failed' | 'stopped' | 'unknown'

export function settledOutcome(activity?: MobileActivity): Outcome {
  if (!activity) return 'unknown'
  if (activity.activityState === 'failed' || activity.terminalOutcome === 'failed')
    return 'failed'
  if (activity.activityState === 'review') return 'review'
  if (activity.terminalOutcome === 'stopped') return 'stopped'
  if (activity.terminalOutcome === 'completed') return 'done'
  return 'unknown'
}

/** 副行：完成写“项目 · 结局”，出错和停止把结局放前面（与设计稿一致）。 */
export function outcomeLine(outcome: Outcome, project?: string | null) {
  const join = (...parts: (string | null | undefined)[]) =>
    parts.filter(Boolean).join(' · ')
  switch (outcome) {
    case 'failed':
      return join('出错停下', project)
    case 'stopped':
      return join('你停止了', project)
    case 'done':
      return join(project, '已完成')
    case 'review':
      return join(project, '已完成', '未查看')
    default:
      return project ?? ''
  }
}

/* ───────────── 搜索 ───────────── */

export function matchesQuery(row: DashboardRow, query: string) {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  // 和旧版一样也匹配完整工作目录，路径里的子目录名也能搜到。
  return `${row.session.title}\n${projectOf(row.session)?.name ?? ''}\n${row.session.workDir ?? ''}`
    .toLowerCase()
    .includes(needle)
}

/** 把文本按关键词切段，用于 mark 高亮；不区分大小写，保留原文。 */
export function highlightParts(text: string, query: string) {
  const needle = query.trim().toLowerCase()
  if (!needle) return [{ text, match: false }]
  const parts: { text: string; match: boolean }[] = []
  const lower = text.toLowerCase()
  let index = 0
  while (index < text.length) {
    const found = lower.indexOf(needle, index)
    if (found < 0) break
    if (found > index) parts.push({ text: text.slice(index, found), match: false })
    parts.push({ text: text.slice(found, found + needle.length), match: true })
    index = found + needle.length
  }
  if (index < text.length) parts.push({ text: text.slice(index), match: false })
  return parts.length ? parts : [{ text, match: false }]
}

/* ───────────── 这台电脑的连接状态 ───────────── */

export type HostLink = 'none' | 'connecting' | 'online' | DashboardFailure

export function hostLink(input: {
  host?: Host | null
  fresh: boolean
  failure: DashboardFailure | null
  credentialError?: string
}): HostLink {
  if (!input.host) return 'none'
  if (input.credentialError) return 'unauthorized'
  if (input.fresh) return 'online'
  return input.failure ?? 'connecting'
}

export function networkName(host: Pick<Host, 'auth'>) {
  return host.auth === 'lan' ? '局域网' : '公网'
}

export function hostAddress(host: Pick<Host, 'auth' | 'url'>) {
  let address = host.url
  try {
    address = new URL(host.url).host
  } catch {
    /* 已保存的地址都校验过；这里只是展示兜底。 */
  }
  return `${networkName(host)} · ${address}`
}

function pad(value: number) {
  return String(value).padStart(2, '0')
}
function sameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

/** “4 分钟前” / “2 小时前” / “10/21”，用于最后同步时间。 */
export function agoLabel(timestamp: number, now: number) {
  const minutes = Math.floor((now - timestamp) / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} 小时前`
  const date = new Date(timestamp)
  return `${date.getMonth() + 1}/${date.getDate()}`
}

/** “23:10” / “昨天 23:10” / “10/21 23:10”，用于最后在线时间。 */
export function clockLabel(timestamp: number, now: number) {
  const date = new Date(timestamp)
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const today = new Date(now)
  if (sameDay(date, today)) return time
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (sameDay(date, yesterday)) return `昨天 ${time}`
  return `${date.getMonth() + 1}/${date.getDate()} ${time}`
}

export type StatusTone = 'ok' | 'faint' | 'attn' | 'err'

/** 大标题下的一行状态：圆点色调 + 文案。 */
export function hostStatusLine(
  link: HostLink,
  host: Pick<Host, 'auth'> | null | undefined,
  lastSyncedAt: number | undefined,
  now: number
): { text: string; tone: StatusTone } {
  const synced = lastSyncedAt ? ` · ${agoLabel(lastSyncedAt, now)}最后同步` : ''
  switch (link) {
    case 'online':
      return { text: `在线 · ${host ? networkName(host) : ''}`, tone: 'ok' }
    case 'offline':
      return { text: `离线${synced}`, tone: 'faint' }
    case 'unauthorized':
      return { text: '授权已失效', tone: 'err' }
    case 'failed':
      return { text: `同步失败${synced}`, tone: 'err' }
    case 'slow':
      return { text: '同步较慢 · 正在重试', tone: 'attn' }
    case 'none':
      return { text: '还没有连接电脑', tone: 'faint' }
    default:
      return { text: '连接中…', tone: 'faint' }
  }
}

/** 单个状态词（在线 / 离线 / 授权已失效…），不带网络和同步时间。 */
export function hostStateName(link: HostLink): { text: string; tone: StatusTone } {
  switch (link) {
    case 'online':
      return { text: '在线', tone: 'ok' }
    case 'offline':
      return { text: '离线', tone: 'faint' }
    case 'unauthorized':
      return { text: '授权已失效', tone: 'err' }
    case 'failed':
      return { text: '同步失败', tone: 'err' }
    case 'slow':
      return { text: '同步较慢', tone: 'attn' }
    default:
      return { text: '连接中', tone: 'faint' }
  }
}

/** 离线卡与“新任务”：只有没有电脑或确实连不上时才拦住，快照不新鲜不算。 */
export function canStartTask(link: HostLink) {
  return !['none', 'offline', 'unauthorized'].includes(link)
}

/* ───────────── 其他电脑的连通检查 ───────────── */

export type HostCheck = {
  state: 'checking' | 'online' | 'offline' | 'unauthorized'
  message?: string
  expiresAt?: number
  checkedAt?: number
  waiting?: number
  running?: number
  lastOnlineAt?: number
}

export function hostCheckLine(host: Pick<Host, 'auth'>, check: HostCheck, now: number) {
  switch (check.state) {
    case 'checking':
      return '正在检查连接…'
    case 'unauthorized':
      return '授权已失效 · 请重新连接'
    case 'offline':
      return check.lastOnlineAt
        ? `离线 · ${clockLabel(check.lastOnlineAt, now)} 最后在线`
        : '离线 · 暂时连不上'
  }
  if (host.auth === 'lan') return '局域网 · 在线'
  if (check.expiresAt === undefined) return '公网 · 在线'
  const days = Math.max(
    0,
    Math.ceil((check.expiresAt - (check.checkedAt ?? check.expiresAt)) / 86400000)
  )
  return days < 1 ? '公网 · 授权不足 1 天' : `公网 · 授权还剩 ${days} 天`
}

export function hostCheckBadge(check: HostCheck): { text: string; tone: 'attn' | 'ink3' } | null {
  if (check.state !== 'online') return null
  if (check.waiting) return { text: `${check.waiting} 件等你`, tone: 'attn' }
  if (check.running) return { text: `${check.running} 个进行中`, tone: 'ink3' }
  return null
}

/* ───────────── 定时任务 ───────────── */

function parseField(field: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>()
  for (const part of field.split(',')) {
    const range = /^(\d+)(?:-(\d+))?$/.exec(part)
    if (!range) return null
    const from = Number(range[1])
    const to = range[2] === undefined ? from : Number(range[2])
    if (from < min || to > max || from > to) return null
    for (let value = from; value <= to; value++) values.add(value)
  }
  return values
}

/**
 * 只认“每天 / 工作日 / 指定星期 HH:mm”这类 `分 时 * * 星期` 表达式；
 * 其他写法返回 null，调用方不显示下次时间，避免猜错。
 */
export function nextCronRun(cron: string, now: Date): Date | null {
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields
  if (!/^\d+$/.test(minute!) || !/^\d+$/.test(hour!)) return null
  if (dayOfMonth !== '*' || month !== '*') return null
  const m = Number(minute)
  const h = Number(hour)
  if (m > 59 || h > 23) return null
  const days =
    dayOfWeek === '*' ? null : parseField(dayOfWeek!, 0, 7)
  if (dayOfWeek !== '*' && !days) return null
  if (days?.has(7)) days.add(0)
  for (let offset = 0; offset <= 7; offset++) {
    const candidate = new Date(now)
    candidate.setDate(candidate.getDate() + offset)
    candidate.setHours(h, m, 0, 0)
    if (candidate.getTime() <= now.getTime()) continue
    if (!days || days.has(candidate.getDay())) return candidate
  }
  return null
}

const weekdayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** “3 个开启 · 下次 18:00”；有任何一个开启的任务算不出时间时只显示数量。 */
export function scheduleSummary(tasks: ScheduledTask[], now: Date) {
  const enabled = tasks.filter((task) => task.enabled !== false)
  if (!tasks.length) return '未设置'
  if (!enabled.length) return '全部暂停'
  const runs = enabled.map((task) => nextCronRun(task.cron, now))
  if (runs.some((run) => !run)) return `${enabled.length} 个开启`
  const next = new Date(Math.min(...runs.map((run) => run!.getTime())))
  const time = `${pad(next.getHours())}:${pad(next.getMinutes())}`
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const day = sameDay(next, now)
    ? ''
    : sameDay(next, tomorrow)
      ? '明天 '
      : `${weekdayNames[next.getDay()]} `
  return `${enabled.length} 个开启 · 下次 ${day}${time}`
}
