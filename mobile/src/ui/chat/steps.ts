import type { ChatItem } from '../../core/types'
import type { DiffLine } from '../../core/operations'
import type { IconName } from '../icons'

/** 摘要里的一段：“已读 3 个文件”。 */
export type ActivitySegment = {
  key: string
  icon: IconName
  text: string
  count: number
}

/** 一个已经结束的回合的时间窗口：开始取用户消息，结束取这一轮最后一条消息。 */
export type TurnClock = { startedAt?: number; endedAt?: number }

/** 消息流里的一行：普通消息、连续工具调用/思考合成的一组步骤，或一轮处理过程的折叠条。 */
export type ChatRow =
  | { kind: 'message'; key: string; item: ChatItem; turn?: string }
  | {
      kind: 'steps'
      key: string
      steps: ChatItem[]
      /** 属于正在进行的这一轮：当前步骤由顶栏下方的状态行显示，这里不重复。 */
      live: boolean
      segments: ActivitySegment[]
      /** 属于哪一轮的折叠条（折叠条的 key）；没有就始终显示。 */
      turn?: string
      /** 这一轮处理过程的最后一组：展开时在它后面画一条分隔线，下面是最终回复。 */
      turnEnd?: boolean
    }
  | {
      kind: 'turn'
      key: string
      label: string
      /** 折叠起来的行数（消息 + 步骤组）。 */
      hidden: number
    }

const isStep = (item: ChatItem) => item.type === 'tool' || item.type === 'thinking'

const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskOutput', 'TaskStop'])

const pathOf = (step: ChatItem) => {
  const input = stepInput(step)
  return str(input?.file_path) ?? str(input?.notebook_path) ?? str(input?.path)
}

/** 一类工具的摘要：返回 [归类 key, 文案, 图标]。同一类里按文件去重计数。 */
function classify(step: ChatItem): { key: string; icon: IconName; dedupe?: string } {
  if (step.type === 'thinking') return { key: 'thinking', icon: 'sparkle' }
  const name = step.toolName ?? ''
  switch (name) {
    case 'Read':
    case 'NotebookRead':
      return { key: 'read', icon: 'file', dedupe: pathOf(step) }
    case 'Write':
      return { key: 'write', icon: 'pencil', dedupe: pathOf(step) }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { key: 'edit', icon: 'pencil', dedupe: pathOf(step) }
    case 'Bash':
    case 'PowerShell':
      return { key: 'run', icon: 'terminal' }
    case 'Grep':
      return { key: 'search', icon: 'search' }
    case 'Glob':
    case 'LS':
      return { key: 'find', icon: 'search' }
    case 'WebSearch':
      return { key: 'websearch', icon: 'globe' }
    case 'WebFetch':
      return { key: 'webfetch', icon: 'globe' }
    case 'Task':
    case 'Agent':
      return { key: 'agent', icon: 'users' }
    case 'TodoWrite':
      return { key: 'todo', icon: 'list-checks' }
    case 'ExitPlanMode':
      return { key: 'plan', icon: 'list-checks' }
    case 'AskUserQuestion':
      return { key: 'ask', icon: 'info' }
    default:
      if (TASK_TOOLS.has(name)) return { key: 'todo', icon: 'list-checks' }
      // 同一个 MCP 服务的工具合成一类，不露出内部工具名。
      return { key: `tool:${/^mcp__(.+?)__/.exec(name)?.[1] ?? (name || '工具')}`, icon: 'cpu' }
  }
}

function segmentText(key: string, count: number): string {
  switch (key) {
    case 'thinking':
      return count === 1 ? '思考' : `思考 ${count} 次`
    case 'read':
      return `已读 ${count} 个文件`
    case 'write':
      return `新建 ${count} 个文件`
    case 'edit':
      return `编辑 ${count} 个文件`
    case 'run':
      return `运行 ${count} 条命令`
    case 'search':
      return `搜索 ${count} 次`
    case 'find':
      return count === 1 ? '查找文件' : `查找文件 ${count} 次`
    case 'websearch':
      return count === 1 ? '搜索网页' : `搜索网页 ${count} 次`
    case 'webfetch':
      return `打开 ${count} 个网页`
    case 'agent':
      return `派出 ${count} 个子 Agent`
    case 'todo':
      return '更新待办'
    case 'plan':
      return '提交计划'
    case 'ask':
      return '提问'
    default: {
      const label = key.slice('tool:'.length)
      return count === 1 ? `调用 ${label}` : `调用 ${label} ${count} 次`
    }
  }
}

/**
 * 一组步骤的摘要，按首次出现的顺序归类计数（规则参考桌面 activityGroupModel）：
 * 读/写/改按文件去重，命令、搜索按次数；没有路径的调用照数。
 */
export function summarizeActivity(steps: readonly ChatItem[]): ActivitySegment[] {
  const order: string[] = []
  const counts = new Map<string, number>()
  const icons = new Map<string, IconName>()
  const seen = new Map<string, Set<string>>()
  for (const step of steps) {
    const { key, icon, dedupe } = classify(step)
    if (!counts.has(key)) {
      order.push(key)
      icons.set(key, icon)
    }
    if (dedupe) {
      const files = seen.get(key) ?? new Set<string>()
      seen.set(key, files)
      if (files.has(dedupe)) continue
      files.add(dedupe)
    }
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return order.map((key) => ({
    key,
    icon: icons.get(key) ?? 'cpu',
    count: counts.get(key) ?? 0,
    text: segmentText(key, counts.get(key) ?? 0),
  }))
}

/** “已读 3 个文件 · 运行 2 条命令”。 */
export function activityLabel(segments: readonly ActivitySegment[]) {
  return segments.map((segment) => segment.text).join(' · ')
}

/**
 * 进行中的组最后一步（还没结果的工具、正在想的思考）由顶栏下方的状态行显示，
 * 摘要里不重复；等审批、后台进行中的步骤仍然保留。
 */
export function stepsBehindCaption<T>(steps: readonly T[], isCurrent: (step: T) => boolean): T[] {
  const last = steps.at(-1)
  return last !== undefined && isCurrent(last) ? steps.slice(0, -1) : [...steps]
}

/** done = 有结果；missing = 这一轮已经结束却没拿到结果（例如被停止）。 */
export type StepState = 'running' | 'waiting' | 'background' | 'error' | 'done' | 'missing'

/** 摘要行尾的状态：等批准 > 失败 > 后台进行中，颜色之外有文字。 */
export function groupTail(states: readonly StepState[]): { text: string; tone: 'attn' | 'err' | 'run' } | null {
  if (states.includes('waiting')) return { text: '等你批准', tone: 'attn' }
  const failed = states.filter((state) => state === 'error').length
  if (failed) return { text: failed === 1 ? '失败' : `${failed} 项失败`, tone: 'err' }
  if (states.includes('background')) return { text: '后台进行中', tone: 'run' }
  return null
}

/** 时长文案：45 秒 / 3 分 12 秒 / 1 小时 2 分；不到 1 秒返回空。 */
export function formatTurnDuration(ms: number) {
  const total = Math.floor(ms / 1000)
  if (!Number.isFinite(total) || total < 1) return ''
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours) return minutes ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`
  if (minutes) return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`
  return `${seconds} 秒`
}

const stamp = (value?: string) => {
  const parsed = value ? Date.parse(value) : NaN
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * 折叠条上的文案“用时 3 分 12 秒”。历史消息用消息时间；这一页亲眼看着结束的最新一轮
 * （消息没有时间戳）用本地起止时间。算不出时长就只写“处理过程”，不编数字。
 */
export function turnFoldLabel(
  user: ChatItem | undefined,
  turnItems: readonly ChatItem[],
  clock?: TurnClock
) {
  const lastStamp = [...turnItems].reverse().map((item) => stamp(item.timestamp)).find((value) => value !== undefined)
  const start = stamp(user?.timestamp) ?? clock?.startedAt
  const end = lastStamp ?? clock?.endedAt
  const duration = start !== undefined && end !== undefined ? formatTurnDuration(end - start) : ''
  // 失败的工具调用折进去之后不能无声无息：折叠条上写明有几步失败，展开才看得到是哪一步。
  const failed = turnItems.filter((item) => item.type === 'tool' && !item.parentToolUseId && item.isError === true).length
  const base = duration ? `用时 ${duration}` : '处理过程'
  return failed ? `${base} · ${failed} 步失败` : base
}

type BaseRow = Exclude<ChatRow, { kind: 'turn' }>

/**
 * 过程中的短说明（「接下来跑一遍测试」）可以折进「用时 ›」；较长的回复、表格或代码块是实质内容，
 * 即使后面还跟着别的工具调用（例如等后台任务）也不能被藏起来。
 */
export function isSubstantialReply(item: ChatItem): boolean {
  const text = item.text ?? ''
  return text.trim().length > 160 || /^\s*\|.+\|\s*$/m.test(text) || text.includes('```')
}

/**
 * 连续的工具调用和思考块合成一组；每一轮（用户消息之后）结束后，处理过程
 * （最后一组工具调用之前的全部助手文字和步骤组）折成一行“用时 …”，最终回复留在外面。
 * 正在进行的这一轮不折。折叠条的开合状态放在页面里，用 {@link visibleChatRows} 过滤。
 */
export function buildChatRows(
  items: readonly ChatItem[],
  turnActive: boolean,
  options: { clock?: TurnClock } = {}
): ChatRow[] {
  let lastUser = -1
  items.forEach((item, index) => {
    if (item.type === 'user') lastUser = index
  })
  const base: { row: BaseRow; index: number }[] = []
  let group: { start: number; steps: ChatItem[] } | null = null
  const flush = () => {
    if (!group) return
    const live = turnActive && group.start > lastUser
    base.push({
      index: group.start,
      row: {
        kind: 'steps',
        key: `steps:${group.steps[0].id}`,
        steps: group.steps,
        live,
        segments: summarizeActivity(group.steps),
      },
    })
    group = null
  }
  items.forEach((item, index) => {
    if (isStep(item)) {
      if (!group) group = { start: index, steps: [] }
      group.steps.push(item)
      return
    }
    flush()
    base.push({ index, row: { kind: 'message', key: item.id, item } })
  })
  flush()

  // 按用户消息切成回合；回合 = 用户消息之后到下一条用户消息之前。
  const isUser = (entry: { row: BaseRow }) => entry.row.kind === 'message' && entry.row.item.type === 'user'
  const rows: ChatRow[] = []
  let cursor = 0
  while (cursor < base.length) {
    const user = isUser(base[cursor]) ? (base[cursor].row as { item: ChatItem }).item : undefined
    if (user) rows.push(base[cursor].row)
    const first = cursor + (user ? 1 : 0)
    let end = first
    while (end < base.length && !isUser(base[end])) end++
    const turn = base.slice(first, end)
    const live = turnActive && end === base.length
    const lastSteps = turn.findLastIndex((entry) => entry.row.kind === 'steps')
    if (live || lastSteps < 0) {
      rows.push(...turn.map((entry) => entry.row))
    } else {
      // 一轮里最后一条有文字的助手回复就是答案，哪怕它后面还跟着收尾的工具调用（TodoWrite、取后台输出）。
      const lastReply = turn.findLast(
        (entry) => entry.row.kind === 'message' && entry.row.item.type === 'assistant' && !!entry.row.item.text?.trim()
      )
      const folded = new Set(
        turn
          .slice(0, lastSteps + 1)
          .filter(
            (entry) =>
              entry.row.kind === 'steps' ||
              (entry.row.kind === 'message' &&
                entry.row.item.type === 'assistant' &&
                entry !== lastReply &&
                !isSubstantialReply(entry.row.item))
          )
          .map((entry) => entry.row)
      )
      const key = `turn:${turn.find((entry) => folded.has(entry.row))?.row.key}`
      const turnItems = items.slice(turn[0].index, end < base.length ? base[end].index : items.length)
      rows.push({
        kind: 'turn',
        key,
        label: turnFoldLabel(user, turnItems, end === base.length ? options.clock : undefined),
        hidden: folded.size,
      })
      turn.forEach((entry, position) => {
        if (!folded.has(entry.row)) rows.push(entry.row)
        else if (entry.row.kind === 'steps')
          rows.push({ ...entry.row, turn: key, ...(position === lastSteps ? { turnEnd: true } : {}) })
        else rows.push({ ...entry.row, turn: key })
      })
    }
    cursor = end
  }
  return rows
}

/** 折叠条没展开的回合，里面的行不进列表。 */
export function visibleChatRows(rows: readonly ChatRow[], open: ReadonlySet<string>): ChatRow[] {
  return rows.filter((row) => row.kind === 'turn' || !row.turn || open.has(row.turn))
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
const str = (value: unknown) => (typeof value === 'string' ? value : undefined)

/** 流式阶段只有部分 JSON；能解析就用，不能就当作还没有输入。 */
export function stepInput(item: ChatItem): Record<string, unknown> | null {
  const input = record(item.input)
  if (input) return input
  if (!item.partialInput) return null
  try {
    return record(JSON.parse(item.partialInput))
  } catch {
    return null
  }
}

/** 工作目录下的路径显示为相对路径，其余原样。 */
export function relativePath(path: string, workDir?: string | null) {
  if (!workDir) return path
  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '')
  const base = normalize(workDir)
  const target = normalize(path)
  if (base && target.startsWith(`${base}/`)) return target.slice(base.length + 1)
  return path
}

const firstLine = (value: string) => value.trim().split('\n')[0] ?? ''

export type StepLabel = {
  verb: string
  object?: string
  /** 路径、命令、模式等用等宽；自然语言（子 Agent 说明、搜索词）用正文字体。 */
  mono: boolean
  added?: number
  removed?: number
}

export function describeStep(item: ChatItem, workDir?: string | null): StepLabel {
  if (item.type === 'thinking') return { verb: '思考过程', mono: false }
  const input = stepInput(item)
  const name = item.toolName ?? ''
  const path = str(input?.file_path) ?? str(input?.notebook_path) ?? str(input?.path)
  const file = path ? relativePath(path, workDir) : undefined
  switch (name) {
    case 'Read':
      return { verb: '读取', object: file, mono: true }
    case 'Edit':
    case 'MultiEdit': {
      const counts = editCounts(input)
      return { verb: '编辑', object: file, mono: true, ...counts }
    }
    case 'Write':
    case 'NotebookEdit':
      return { verb: '写入', object: file, mono: true }
    case 'Bash':
    case 'PowerShell': {
      const command = str(input?.command)
      return { verb: '运行', object: command ? firstLine(command) : undefined, mono: true }
    }
    case 'Grep':
      return { verb: '搜索', object: str(input?.pattern), mono: true }
    case 'Glob':
      return { verb: '查找', object: str(input?.pattern), mono: true }
    case 'WebFetch':
      return { verb: '打开', object: str(input?.url), mono: true }
    case 'WebSearch':
      return { verb: '搜网页', object: str(input?.query), mono: false }
    case 'Task':
    case 'Agent':
      return {
        verb: '子 Agent',
        object: str(input?.description) ?? str(input?.subagent_type),
        mono: false,
      }
    case 'TodoWrite': {
      const todos = Array.isArray(input?.todos) ? input.todos.length : undefined
      return { verb: '更新待办', object: todos ? `${todos} 项` : undefined, mono: false }
    }
    case 'ExitPlanMode':
      return { verb: '提交计划', mono: false }
    case 'AskUserQuestion': {
      const first = Array.isArray(input?.questions) ? input.questions[0] : undefined
      const question =
        first && typeof first === 'object' ? str((first as Record<string, unknown>).question) : undefined
      return { verb: '提问', object: question, mono: false }
    }
    default: {
      // MCP 工具名形如 mcp__server__tool，拆成“server · tool”，不直接露出内部名字。
      const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
      if (mcp) return { verb: '调用', object: `${mcp[1]} · ${mcp[2]}`, mono: true }
      const object =
        file ??
        str(input?.command) ??
        str(input?.pattern) ??
        str(input?.url) ??
        str(input?.description) ??
        str(input?.query)
      return {
        verb: name || '工具',
        object: object ? firstLine(object) : undefined,
        mono: !!(file || str(input?.command) || str(input?.pattern) || str(input?.url)),
      }
    }
  }
}

/** Edit / MultiEdit 的输入里能可靠算出的增删行数。 */
export function editCounts(input: Record<string, unknown> | null) {
  const edits = Array.isArray(input?.edits)
    ? input.edits.map(record).filter((edit) => edit !== null)
    : input
      ? [input]
      : []
  let added = 0
  let removed = 0
  let counted = false
  for (const edit of edits) {
    const before = str(edit.old_string)
    const after = str(edit.new_string)
    if (before === undefined || after === undefined) continue
    counted = true
    for (const line of lineDiff(before, after)) {
      if (line.kind === 'add') added++
      else if (line.kind === 'remove') removed++
    }
  }
  return counted ? { added, removed } : {}
}

const splitLines = (value: string) =>
  value === '' ? [] : value.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n')

/**
 * 两段文本的逐行差异。先去掉相同的首尾行；中间部分不大时用最长公共子序列，
 * 太大时整体算作删除+新增，避免在手机上做平方级计算。
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = splitLines(before)
  const b = splitLines(after)
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++
  const context = (text: string): DiffLine => ({ text, kind: 'context' })
  const middleA = a.slice(head, a.length - tail)
  const middleB = b.slice(head, b.length - tail)
  const middle: DiffLine[] = []
  if (middleA.length * middleB.length > 40000) {
    for (const text of middleA) middle.push({ text, kind: 'remove' })
    for (const text of middleB) middle.push({ text, kind: 'add' })
  } else {
    const n = middleA.length
    const m = middleB.length
    const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        table[i][j] =
          middleA[i] === middleB[j]
            ? table[i + 1][j + 1] + 1
            : Math.max(table[i + 1][j], table[i][j + 1])
    let i = 0
    let j = 0
    while (i < n || j < m) {
      if (i < n && j < m && middleA[i] === middleB[j]) {
        middle.push(context(middleA[i]))
        i++
        j++
      } else if (i < n && (j === m || table[i + 1][j] >= table[i][j + 1])) {
        middle.push({ text: middleA[i], kind: 'remove' })
        i++
      } else {
        middle.push({ text: middleB[j], kind: 'add' })
        j++
      }
    }
  }
  return [...a.slice(0, head).map(context), ...middle, ...a.slice(a.length - tail).map(context)]
}

/** Edit / MultiEdit 展开后的差异：多处修改之间用分隔行标出。 */
export function editDiff(input: Record<string, unknown> | null): DiffLine[] {
  const edits = Array.isArray(input?.edits)
    ? input.edits.map(record).filter((edit) => edit !== null)
    : input
      ? [input]
      : []
  const lines: DiffLine[] = []
  edits.forEach((edit, index) => {
    const before = str(edit.old_string)
    const after = str(edit.new_string)
    if (before === undefined || after === undefined) return
    if (edits.length > 1) lines.push({ text: `第 ${index + 1} 处`, kind: 'hunk' })
    lines.push(...lineDiff(before, after))
  })
  return lines
}

/** 长输出只留最后几行，并说明省略了多少。 */
export function outputTail(text: string, maxLines = 12) {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n')
  if (lines.length <= maxLines) return { text: lines.join('\n'), omitted: 0 }
  return { text: lines.slice(-maxLines).join('\n'), omitted: lines.length - maxLines }
}

/** 其他工具的输入：字符串原样，其他值紧凑 JSON；每项一行。 */
export function formatInput(input: Record<string, unknown> | null) {
  if (!input) return ''
  return Object.entries(input)
    .map(([key, value]) => {
      const text = typeof value === 'string' ? value : JSON.stringify(value)
      return `${key}: ${text && text.length > 600 ? `${text.slice(0, 600)}…` : text}`
    })
    .join('\n')
}
