import type { ChatItem } from '../../core/types'
import type { DiffLine } from '../../core/operations'

/** 消息流里的一行：普通消息，或连续工具调用/思考合成的一组步骤。 */
export type ChatRow =
  | { kind: 'message'; key: string; item: ChatItem }
  | {
      kind: 'steps'
      key: string
      steps: ChatItem[]
      /** 属于正在进行的这一轮：保持展开，运行中的步骤显示转圈。 */
      live: boolean
      summary: StepSummary
    }

export type StepSummary = { total: number; read: number; edit: number; run: number }

const isStep = (item: ChatItem) => item.type === 'tool' || item.type === 'thinking'

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead'])
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const RUN_TOOLS = new Set(['Bash', 'PowerShell'])

export function summarizeSteps(steps: readonly ChatItem[]): StepSummary {
  const summary = { total: 0, read: 0, edit: 0, run: 0 }
  for (const step of steps) {
    if (step.type !== 'tool') continue
    summary.total++
    const name = step.toolName ?? ''
    if (READ_TOOLS.has(name)) summary.read++
    else if (EDIT_TOOLS.has(name)) summary.edit++
    else if (RUN_TOOLS.has(name)) summary.run++
  }
  return summary
}

/** “做了 14 步 · 读 6 · 改 2 · 运行 6”；为 0 的类别不出现。 */
export function summaryLabel(summary: StepSummary) {
  return [
    `做了 ${summary.total} 步`,
    summary.read ? `读 ${summary.read}` : '',
    summary.edit ? `改 ${summary.edit}` : '',
    summary.run ? `运行 ${summary.run}` : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

/**
 * 连续的工具调用和思考块合成一组。最后一条用户消息之后、且这一轮还在跑的组是
 * “进行中”，其余组在结束后折叠成摘要。
 */
export function buildChatRows(
  items: readonly ChatItem[],
  turnActive: boolean
): ChatRow[] {
  let lastUser = -1
  items.forEach((item, index) => {
    if (item.type === 'user') lastUser = index
  })
  const rows: ChatRow[] = []
  let group: { start: number; steps: ChatItem[] } | null = null
  const flush = () => {
    if (!group) return
    rows.push({
      kind: 'steps',
      key: `steps:${group.steps[0].id}`,
      steps: group.steps,
      live: turnActive && group.start > lastUser,
      summary: summarizeSteps(group.steps),
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
    rows.push({ kind: 'message', key: item.id, item })
  })
  flush()
  return rows
}

/** 进行中的组最多显示最近 4 步，较早的折成“前面还有 N 步”。 */
export const VISIBLE_LIVE_STEPS = 4
export function visibleSteps(steps: readonly ChatItem[], revealed: boolean) {
  if (revealed || steps.length <= VISIBLE_LIVE_STEPS)
    return { hidden: 0, steps: [...steps] }
  return {
    hidden: steps.length - VISIBLE_LIVE_STEPS,
    steps: steps.slice(-VISIBLE_LIVE_STEPS),
  }
}

/** 结束后的组：两个以上工具调用才折成摘要，单步直接显示那一步。 */
export const collapsible = (summary: StepSummary) => summary.total >= 2

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
