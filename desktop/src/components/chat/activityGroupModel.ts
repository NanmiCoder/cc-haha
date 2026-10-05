import {
  Bot,
  Box,
  Brain,
  FilePen,
  FilePlus,
  FileText,
  Globe,
  ListTodo,
  MessageSquare,
  Search,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import type { TranslationKey } from '../../i18n'
import type { UIMessage } from '../../types/chat'

type ToolCall = Extract<UIMessage, { type: 'tool_use' }>
type ToolResult = Extract<UIMessage, { type: 'tool_result' }>
type ThinkingMessage = Extract<UIMessage, { type: 'thinking' }>

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string

/**
 * One entry in a turn's activity run. Thinking and tool calls share a single
 * ordered list so the collapsed header can say "Thinking · Read 5 files · ran 2
 * commands" in the order they actually happened (#1177) instead of emitting one
 * card per step.
 */
export type ActivityStep =
  | { kind: 'thinking'; message: ThinkingMessage }
  | { kind: 'tool'; toolCall: ToolCall }

export const THINKING_SEGMENT_KEY = '__thinking__'
const TASKS_FAMILY_KEY = '__tasks__'

export type ActivitySegment = {
  key: string
  label: string
  icon: LucideIcon
}

/**
 * Wall-clock gap between the tool_use and its tool_result, used for the "524ms"
 * badge (#1149). The CLI does not report a real execution duration over the wire
 * — BashProgress never leaves the ink renderer — so this is the transcript
 * timestamp delta and therefore includes any permission-approval wait.
 */
export function toolCallDurationMs(
  toolCall: Pick<ToolCall, 'timestamp'>,
  result?: Pick<ToolResult, 'timestamp'>,
): number | undefined {
  if (!result) return undefined
  const elapsed = result.timestamp - toolCall.timestamp
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : undefined
}

const TOOL_VERBS: Record<string, (count: number, t: Translate) => string> = {
  Read: (n, t) => n === 1 ? t('toolGroup.readOne') : t('toolGroup.readMany', { count: n }),
  Write: (n, t) => n === 1 ? t('toolGroup.createdOne') : t('toolGroup.createdMany', { count: n }),
  Edit: (n, t) => n === 1 ? t('toolGroup.editedOne') : t('toolGroup.editedMany', { count: n }),
  Bash: (n, t) => n === 1 ? t('toolGroup.ranOne') : t('toolGroup.ranMany', { count: n }),
  Glob: (_n, t) => t('toolGroup.foundFiles'),
  Grep: (n, t) => n === 1 ? t('toolGroup.searchedOne') : t('toolGroup.searchedMany', { count: n }),
  Agent: (n, t) => n === 1 ? t('toolGroup.agentOne') : t('toolGroup.agentMany', { count: n }),
  WebSearch: (_n, t) => t('toolGroup.searchedWeb'),
  WebFetch: (n, t) => n === 1 ? t('toolGroup.fetchedOne') : t('toolGroup.fetchedMany', { count: n }),
  // A todo list is one artifact however many times it is rewritten, so the
  // summary says what happened to it rather than counting the rewrites.
  TodoWrite: (_n, t) => t('toolGroup.updatedTodos'),
  [TASKS_FAMILY_KEY]: (_n, t) => t('toolGroup.managedTasks'),
}

/**
 * Tools that share one clause in the summary. The task tools are four names for
 * one activity — "TaskCreate, TaskUpdate (3), TaskList" read as an inventory of
 * internals where "managed tasks" says what the reader needs.
 */
const TOOL_FAMILIES: Record<string, string> = {
  TaskCreate: TASKS_FAMILY_KEY,
  TaskUpdate: TASKS_FAMILY_KEY,
  TaskList: TASKS_FAMILY_KEY,
  TaskGet: TASKS_FAMILY_KEY,
}

const TOOL_SEGMENT_ICONS: Record<string, LucideIcon> = {
  Bash: SquareTerminal,
  PowerShell: SquareTerminal,
  Read: FileText,
  Write: FilePlus,
  Edit: FilePen,
  MultiEdit: FilePen,
  NotebookEdit: FilePen,
  Glob: Search,
  Grep: Search,
  ToolSearch: Search,
  Agent: Bot,
  WebSearch: Globe,
  WebFetch: Globe,
  TodoWrite: ListTodo,
  TaskCreate: ListTodo,
  TaskUpdate: ListTodo,
  TaskList: ListTodo,
  TaskGet: ListTodo,
  [TASKS_FAMILY_KEY]: ListTodo,
  Skill: Box,
  ListSessions: MessageSquare,
  ReadSession: MessageSquare,
  CreateSession: MessageSquare,
  SendSessionMessage: MessageSquare,
  WaitSessions: MessageSquare,
}

export function activitySegmentIcon(toolName: string): LucideIcon {
  return TOOL_SEGMENT_ICONS[toolName] ?? Wrench
}

/**
 * Collapse a run of steps into the `Thinking · Read 5 files · ran 2 commands`
 * header. Families keep first-appearance order — the header is meant to read as
 * a sentence about what just happened, not as a sorted inventory.
 */
export function buildActivitySegments(steps: ActivityStep[], t: Translate): ActivitySegment[] {
  const order: string[] = []
  const counts = new Map<string, number>()
  const editedFilePaths = new Set<string>()

  for (const step of steps) {
    const key = step.kind === 'thinking'
      ? THINKING_SEGMENT_KEY
      : TOOL_FAMILIES[step.toolCall.toolName] ?? step.toolCall.toolName
    if (!counts.has(key)) order.push(key)

    // The Edit label counts files, not operations. Agents commonly refine one
    // file through several Edit calls in a turn; count its structured path once
    // so the summary agrees with the changed-file checkpoint below the turn.
    // Keep counting calls whose input has no usable path rather than silently
    // dropping activity we cannot identify.
    if (step.kind === 'tool' && key === 'Edit') {
      const input = step.toolCall.input
      const filePath = input && typeof input === 'object' && !Array.isArray(input)
        ? (input as Record<string, unknown>).file_path
        : undefined
      if (typeof filePath === 'string' && filePath.length > 0) {
        if (editedFilePaths.has(filePath)) continue
        editedFilePaths.add(filePath)
      }
    }

    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  return order.map((key) => {
    if (key === THINKING_SEGMENT_KEY) {
      // Counted like every other family. A bare "Thinking" was right when this
      // line sat above rows the reader could see anyway; as the only thing shown
      // for a finished run it has to carry scale, and "thought 9 times" says the
      // model went back and forth where "thought once" says it went straight
      // through — that difference is most of what the summary is for.
      const count = counts.get(key) ?? 0
      return {
        key,
        label: count === 1 ? t('toolGroup.thought') : t('toolGroup.thoughtMany', { count }),
        icon: Brain,
      }
    }
    const count = counts.get(key) ?? 0
    const verb = TOOL_VERBS[key]
    // Tools with no verb keep their own name — "used 2 tools" hides which ones,
    // and knowing it called SendMessage is the useful part. A lone call drops
    // the count the way the verb forms do: "ran a command" carries no "(1)"
    // either, and on a line meant to be skimmed that bracket is pure noise.
    const fallback = count === 1 ? key : `${key} (${count})`
    return {
      key,
      label: verb ? verb(count, t) : fallback,
      icon: activitySegmentIcon(key),
    }
  })
}

/**
 * The header sentence. The separator is the locale's own list mark — `、` in
 * Chinese and Japanese, a comma elsewhere — because a Latin comma between
 * Chinese clauses reads as a typo.
 */
export function formatActivitySummary(segments: ActivitySegment[], t: Translate): string {
  return segments.map((segment) => segment.label).join(t('toolGroup.separator'))
}

export function toolCallHasError(
  toolCall: ToolCall,
  resultMap: Map<string, ToolResult>,
  childToolCallsByParent: Map<string, ToolCall[]>,
): boolean {
  const result = resultMap.get(toolCall.toolUseId)
  if (result?.isError) return true

  return (childToolCallsByParent.get(toolCall.toolUseId) ?? []).some((childToolCall) =>
    toolCallHasError(childToolCall, resultMap, childToolCallsByParent),
  )
}

export function groupHasErrors(
  toolCalls: ToolCall[],
  resultMap: Map<string, ToolResult>,
  childToolCallsByParent: Map<string, ToolCall[]>,
): boolean {
  return toolCalls.some((toolCall) => toolCallHasError(toolCall, resultMap, childToolCallsByParent))
}

/** How many root steps in the run failed — drives the `2 failed` header chip. */
export function countFailedToolCalls(
  toolCalls: ToolCall[],
  resultMap: Map<string, ToolResult>,
  childToolCallsByParent: Map<string, ToolCall[]>,
): number {
  return toolCalls.filter((toolCall) =>
    toolCallHasError(toolCall, resultMap, childToolCallsByParent),
  ).length
}

export function isToolCallResolved(
  toolCall: ToolCall,
  resultMap: Map<string, ToolResult>,
  childToolCallsByParent: Map<string, ToolCall[]>,
): boolean {
  if (toolCall.status === 'stopped') return true
  if (!resultMap.has(toolCall.toolUseId)) return false

  return (childToolCallsByParent.get(toolCall.toolUseId) ?? []).every((childToolCall) =>
    isToolCallResolved(childToolCall, resultMap, childToolCallsByParent),
  )
}

export function hasUnresolvedToolCalls(
  toolCalls: ToolCall[],
  resultMap: Map<string, ToolResult>,
  childToolCallsByParent: Map<string, ToolCall[]>,
): boolean {
  return toolCalls.some((toolCall) =>
    !isToolCallResolved(toolCall, resultMap, childToolCallsByParent),
  )
}

/**
 * Wall-clock span of the whole run: first step start to last result. Same
 * transcript-timestamp caveat as {@link toolCallDurationMs} — it is the span the
 * user waited, not billed execution time.
 */
export function activityDurationMs(
  steps: ActivityStep[],
  resultMap: Map<string, ToolResult>,
): number | undefined {
  let start = Number.POSITIVE_INFINITY
  let end = Number.NEGATIVE_INFINITY

  for (const step of steps) {
    const startedAt = step.kind === 'thinking' ? step.message.timestamp : step.toolCall.timestamp
    if (Number.isFinite(startedAt)) start = Math.min(start, startedAt)
    if (step.kind === 'tool') {
      const result = resultMap.get(step.toolCall.toolUseId)
      if (result && Number.isFinite(result.timestamp)) end = Math.max(end, result.timestamp)
    }
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined
  return end - start
}

export function activityStepToolCalls(steps: ActivityStep[]): ToolCall[] {
  return steps.flatMap((step) => (step.kind === 'tool' ? [step.toolCall] : []))
}

export function toActivitySteps(toolCalls: ToolCall[]): ActivityStep[] {
  return toolCalls.map((toolCall) => ({ kind: 'tool', toolCall }))
}
