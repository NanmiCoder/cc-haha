import type { ChatItem, ToolImage } from '../../core/types'
import type { DiffLine } from '../../core/operations'
import type { IconName } from '../icons'
import { plural } from '../../core/plural'

/** A segment of the summary: "Read 3 files". */
export type ActivitySegment = {
  key: string
  icon: IconName
  text: string
  count: number
}

/** Time window of a finished turn: starts at the user message, ends at the last message of the turn. */
export type TurnClock = { startedAt?: number; endedAt?: number }

/** One row in the message stream: a normal message, a group of steps merged from consecutive tool calls/thinking, or a collapsed bar for a turn's process. */
export type ChatRow =
  | { kind: 'message'; key: string; item: ChatItem; turn?: string }
  | {
      kind: 'steps'
      key: string
      steps: ChatItem[]
      /** Belongs to the turn in progress, so the step timeline is expanded by default. */
      live: boolean
      segments: ActivitySegment[]
      /** Which turn's collapsed bar it belongs to (the bar's key); always shown if absent. */
      turn?: string
      /** The last group of this turn's process: when expanded draw a separator after it, with the final reply below. */
      turnEnd?: boolean
    }
  | {
      kind: 'turn'
      key: string
      label: string
      /** Number of collapsed rows (messages + step groups). */
      hidden: number
      /** Images read in collapsed steps: still shown under the collapsed bar when the turn is collapsed. */
      images?: NamedToolImage[]
    }

export type NamedToolImage = { image: ToolImage; name: string }

/** Images in tool results, named after the file read. */
export function stepImages(item: ChatItem): NamedToolImage[] {
  if (!item.images?.length) return []
  const input = record(item.input)
  const path = str(input?.file_path) ?? str(input?.path) ?? ''
  const base = path.split(/[\\/]/).filter(Boolean).pop()
  return item.images.map((image, index) => ({
    image,
    name: base ? (item.images!.length > 1 ? `${base} (${index + 1})` : base) : `Image ${index + 1}`,
  }))
}

const isStep = (item: ChatItem) => item.type === 'tool' || item.type === 'thinking'

const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskOutput', 'TaskStop'])

const pathOf = (step: ChatItem) => {
  const input = stepInput(step)
  return str(input?.file_path) ?? str(input?.notebook_path) ?? str(input?.path)
}

/** Summary of a tool category: returns [category key, text, icon]. Within a category counts are deduped by file. */
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
      // Tools of the same MCP server merge into one category, without exposing internal tool names.
      return { key: `tool:${/^mcp__(.+?)__/.exec(name)?.[1] ?? (name || 'Tools')}`, icon: 'cpu' }
  }
}

function segmentText(key: string, count: number): string {
  switch (key) {
    case 'thinking':
      return count === 1 ? 'Thinking' : `Thought ${count} times`
    case 'read':
      return `Read ${plural(count, 'file')}`
    case 'write':
      return `Created ${plural(count, 'file')}`
    case 'edit':
      return `Edited ${plural(count, 'file')}`
    case 'run':
      return `Ran ${plural(count, 'command')}`
    case 'search':
      return `Searched ${count} times`
    case 'find':
      return count === 1 ? 'Found files' : `Found files ${count} times`
    case 'websearch':
      return count === 1 ? 'Searched the web' : `Searched the web ${count} times`
    case 'webfetch':
      return `Opened ${plural(count, 'web page')}`
    case 'agent':
      return `Dispatched ${plural(count, 'subagent')}`
    case 'todo':
      return 'Updated todos'
    case 'plan':
      return 'Submit plan'
    case 'ask':
      return 'Ask'
    default: {
      const label = key.slice('tool:'.length)
      return count === 1 ? `Called ${label}` : `Called ${label} ${count} times`
    }
  }
}

/**
 * Summary of a group of steps, counted by category in order of first appearance (rules follow desktop activityGroupModel): 
 * read/write/edit deduped by file, commands and searches by count; calls without a path are still counted.
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

/** "Read 3 files · Ran 2 commands". */
export function activityLabel(segments: readonly ActivitySegment[]) {
  return segments.map((segment) => segment.text).join(' · ')
}

type GroupDisclosure = { open: ReadonlySet<string>; closed: ReadonlySet<string> }

/** Expanded by default while running; the reader's manual open/close choice takes priority over later streaming updates. */
export function groupIsOpen(ui: GroupDisclosure, key: string, live = false): boolean {
  return ui.open.has(key) || (live && !ui.closed.has(key))
}

export function toggleGroupOpen<T extends GroupDisclosure>(ui: T, key: string, live = false): T {
  const open = new Set(ui.open)
  const closed = new Set(ui.closed)
  if (groupIsOpen(ui, key, live)) {
    open.delete(key)
    closed.add(key)
  } else {
    open.add(key)
    closed.delete(key)
  }
  return { ...ui, open, closed }
}

/** done = has a result; missing = the turn ended without a result (e.g. stopped). */
export type StepState = 'running' | 'waiting' | 'background' | 'error' | 'done' | 'missing'

/** Status at the end of the summary row: waiting for approval > failed > running in background, with text besides color. */
export function groupTail(states: readonly StepState[]): { text: string; tone: 'attn' | 'err' | 'run' } | null {
  if (states.includes('waiting')) return { text: 'Waiting for your approval', tone: 'attn' }
  const failed = states.filter((state) => state === 'error').length
  if (failed) return { text: failed === 1 ? 'Failed' : `${failed} failed`, tone: 'err' }
  if (states.includes('background')) return { text: 'Running in background', tone: 'run' }
  return null
}

/** Duration text: 45 sec / 3 min 12 sec / 1 h 2 min; empty under 1 second. */
export function formatTurnDuration(ms: number) {
  const total = Math.floor(ms / 1000)
  if (!Number.isFinite(total) || total < 1) return ''
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours) return minutes ? `${hours} h ${minutes} min` : `${hours} h`
  if (minutes) return seconds ? `${minutes} min ${seconds} sec` : `${minutes} min`
  return `${seconds} sec`
}

const stamp = (value?: string) => {
  const parsed = value ? Date.parse(value) : NaN
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Text on the collapsed bar "Took 3 min 12 sec". History messages use message time; the latest turn witnessed ending on this page
 * (messages without timestamps) uses local start/end time. If the duration cannot be computed just write "Process" without making up numbers.
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
  // Failed tool calls must not disappear silently when folded: the collapsed bar states how many steps failed, and expanding shows which.
  const failed = turnItems.filter((item) => item.type === 'tool' && !item.parentToolUseId && item.isError === true).length
  const base = duration ? `Took ${duration}` : 'Process'
  return failed ? `${base} · ${failed} steps failed` : base
}

type BaseRow = Exclude<ChatRow, { kind: 'turn' }>

/**
 * Short in-process notes ("next, run the tests") can fold into "Took ›"; longer replies, tables or code blocks are substantive content 
 * and must not be hidden even if followed by other tool calls (e.g. waiting on a background task).
 */
export function isSubstantialReply(item: ChatItem): boolean {
  const text = item.text ?? ''
  return text.trim().length > 160 || /^\s*\|.+\|\s*$/m.test(text) || text.includes('```')
}

/**
 * Consecutive tool calls and thinking blocks merge into a group; after each turn (following a user message) ends, the process
 * (all assistant text and step groups before the last tool call group) collapses into one "Took …" row, with the final reply left outside.
 * The turn in progress is not collapsed. The collapsed bar's open state lives on the page and is filtered with {@link visibleChatRows}.
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

  // Split into turns by user message; a turn = from a user message to just before the next one.
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
      // The last assistant reply with text in a turn is the answer, even if followed by wrap-up tool calls (TodoWrite, fetching background output).
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
      const images = turn.flatMap((entry) =>
        entry.row.kind === 'steps' && folded.has(entry.row) ? entry.row.steps.flatMap(stepImages) : []
      )
      rows.push({
        kind: 'turn',
        key,
        label: turnFoldLabel(user, turnItems, end === base.length ? options.clock : undefined),
        hidden: folded.size,
        ...(images.length ? { images } : {}),
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

/** Rows of turns whose collapsed bar is not expanded do not enter the list. */
export function visibleChatRows(rows: readonly ChatRow[], open: ReadonlySet<string>): ChatRow[] {
  return rows.filter((row) => row.kind === 'turn' || !row.turn || open.has(row.turn))
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
const str = (value: unknown) => (typeof value === 'string' ? value : undefined)

/** During streaming there is only partial JSON; use it if parseable, otherwise treat as no input yet. */
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

/** Paths under the working directory show as relative paths, others as is. */
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
  /** Paths, commands, patterns etc use monospace; natural language (subagent descriptions, search terms) uses the body font. */
  mono: boolean
  added?: number
  removed?: number
}

export function describeStep(item: ChatItem, workDir?: string | null): StepLabel {
  if (item.type === 'thinking') return { verb: 'Thinking process', mono: false }
  const input = stepInput(item)
  const name = item.toolName ?? ''
  const path = str(input?.file_path) ?? str(input?.notebook_path) ?? str(input?.path)
  const file = path ? relativePath(path, workDir) : undefined
  switch (name) {
    case 'Read':
      return { verb: 'Read', object: file, mono: true }
    case 'Edit':
    case 'MultiEdit': {
      const counts = editCounts(input)
      return { verb: 'Edit', object: file, mono: true, ...counts }
    }
    case 'Write':
    case 'NotebookEdit':
      return { verb: 'Write', object: file, mono: true }
    case 'Bash':
    case 'PowerShell': {
      const command = str(input?.command)
      return { verb: 'Run', object: command ? firstLine(command) : undefined, mono: true }
    }
    case 'Grep':
      return { verb: 'Search', object: str(input?.pattern), mono: true }
    case 'Glob':
      return { verb: 'Find', object: str(input?.pattern), mono: true }
    case 'WebFetch':
      return { verb: 'Open', object: str(input?.url), mono: true }
    case 'WebSearch':
      return { verb: 'Web search', object: str(input?.query), mono: false }
    case 'Task':
    case 'Agent':
      return {
        verb: 'Subagent',
        object: str(input?.description) ?? str(input?.subagent_type),
        mono: false,
      }
    case 'TodoWrite': {
      const todos = Array.isArray(input?.todos) ? input.todos.length : undefined
      return { verb: 'Updated todos', object: todos ? plural(todos, 'item') : undefined, mono: false }
    }
    case 'ExitPlanMode':
      return { verb: 'Submit plan', mono: false }
    case 'AskUserQuestion': {
      const first = Array.isArray(input?.questions) ? input.questions[0] : undefined
      const question =
        first && typeof first === 'object' ? str((first as Record<string, unknown>).question) : undefined
      return { verb: 'Ask', object: question, mono: false }
    }
    default: {
      // MCP tool names like mcp__server__tool are split into "server · tool" without exposing the internal name directly.
      const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
      if (mcp) return { verb: 'Called', object: `${mcp[1]} · ${mcp[2]}`, mono: true }
      const object =
        file ??
        str(input?.command) ??
        str(input?.pattern) ??
        str(input?.url) ??
        str(input?.description) ??
        str(input?.query)
      return {
        verb: name || 'Tools',
        object: object ? firstLine(object) : undefined,
        mono: !!(file || str(input?.command) || str(input?.pattern) || str(input?.url)),
      }
    }
  }
}

/** Edit / MultiEdit added/removed line counts that can be reliably computed from the input. */
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
 * Line diff of two texts. Strip identical leading and trailing lines first; use longest common subsequence when the middle is small, 
 * and treat it all as delete + add when large, avoiding quadratic computation on the phone.
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

/** Edit / MultiEdit Expanded diff: separator rows mark multiple changes. */
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
    if (edits.length > 1) lines.push({ text: `Change ${index + 1}`, kind: 'hunk' })
    lines.push(...lineDiff(before, after))
  })
  return lines
}

/** Long output keeps only the last few lines and says how many were omitted. */
export function outputTail(text: string, maxLines = 12) {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n')
  if (lines.length <= maxLines) return { text: lines.join('\n'), omitted: 0 }
  return { text: lines.slice(-maxLines).join('\n'), omitted: lines.length - maxLines }
}

/** Input of other tools: strings as is, other values as compact JSON; one item per line. */
export function formatInput(input: Record<string, unknown> | null) {
  if (!input) return ''
  return Object.entries(input)
    .map(([key, value]) => {
      const text = typeof value === 'string' ? value : JSON.stringify(value)
      return `${key}: ${text && text.length > 600 ? `${text.slice(0, 600)}…` : text}`
    })
    .join('\n')
}
