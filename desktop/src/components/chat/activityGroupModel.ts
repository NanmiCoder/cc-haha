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
import { isExitPlanModeTool, isPlanRevisionResult } from './PlanModePreview'
import { toolVerb } from './toolCallPresentation'

type ToolCall = Extract<UIMessage, { type: 'tool_use' }>
type ToolResult = Extract<UIMessage, { type: 'tool_result' }>
type ThinkingMessage = Extract<UIMessage, { type: 'thinking' }>

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string

/**
 * Distinguishes intermediate/self-recovered tool failures from terminal/blocking
 * ones. An agent routinely hits non-zero exit codes, missing files, or stale
 * edit matches while exploring and immediately retries or answers — showing loud
 * red chrome for those floods the transcript with false alarms.
 */
export type ToolErrorSeverity = 'none' | 'recovered' | 'blocking'

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
 * Per-tool execution duration for the "524ms" badge (#1149, #1915). Prefers the
 * runtime's measured `tool.call` duration (`result.durationMs`, which excludes
 * assistant streaming buffer, serial queue wait, and permission dialog wait),
 * falling back to the `tool_use` → `tool_result` timestamp delta for legacy
 * transcripts recorded before `durationMs` existed.
 */
export function toolCallDurationMs(
  toolCall: Pick<ToolCall, 'timestamp'>,
  result?: Pick<ToolResult, 'timestamp' | 'durationMs'>,
): number | undefined {
  if (!result) return undefined
  if (
    typeof result.durationMs === 'number' &&
    Number.isFinite(result.durationMs) &&
    result.durationMs >= 0
  ) {
    return result.durationMs
  }
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
  // Keep planning is returned as a refusal so the model stays in plan mode.
  if (result?.isError && !(isExitPlanModeTool(toolCall.toolName) && isPlanRevisionResult(result.content))) {
    return true
  }

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

/** How many root steps in the run failed — drives legacy callers/tests. */
export function countFailedToolCalls(
  toolCalls: ToolCall[],
  resultMap: Map<string, ToolResult>,
  childToolCallsByParent: Map<string, ToolCall[]>,
): number {
  return toolCalls.filter((toolCall) =>
    toolCallHasError(toolCall, resultMap, childToolCallsByParent),
  ).length
}

function isRealToolResultError(toolName: string, result: ToolResult | undefined): boolean {
  if (!result?.isError) return false
  return !(isExitPlanModeTool(toolName) && isPlanRevisionResult(result.content))
}

/**
 * Classify every failed tool call in the transcript as `'recovered'` (followed
 * by further tool calls, thinking, or an assistant answer in the same turn, or
 * occurring in an active still-running turn) vs `'blocking'` (the terminal
 * unrecovered failure of a settled turn).
 */
export function classifyTurnToolErrors(
  messages: UIMessage[],
  resultMap: Map<string, ToolResult>,
  options: { turnActive?: boolean } = {},
): Map<string, ToolErrorSeverity> {
  const severities = new Map<string, ToolErrorSeverity>()
  const turns: UIMessage[][] = []
  let currentTurn: UIMessage[] = []

  for (const message of messages) {
    if (message.type === 'user_text' && !message.pending && !message.optimisticQueued) {
      if (currentTurn.length > 0) turns.push(currentTurn)
      currentTurn = []
      continue
    }
    currentTurn.push(message)
  }
  if (currentTurn.length > 0) turns.push(currentTurn)

  const lastTurnIndex = turns.length - 1
  turns.forEach((turnMessages, turnIndex) => {
    const isActiveTurn = options.turnActive === true && turnIndex === lastTurnIndex

    // Track the latest index in this turn where forward progress occurred
    // (another tool call, thinking, or a non-empty assistant answer).
    let lastProgressIndex = -1
    const resultIndexByToolUseId = new Map<string, number>()

    turnMessages.forEach((message, index) => {
      if (message.type === 'tool_result') {
        resultIndexByToolUseId.set(message.toolUseId, index)
      } else if (
        message.type === 'tool_use' ||
        message.type === 'thinking' ||
        (message.type === 'assistant_text' && message.content.trim().length > 0)
      ) {
        lastProgressIndex = index
      }
    })

    turnMessages.forEach((message, index) => {
      if (message.type !== 'tool_use') return
      const result = resultMap.get(message.toolUseId)
      if (!isRealToolResultError(message.toolName, result)) return

      const settledAtIndex = Math.max(index, resultIndexByToolUseId.get(message.toolUseId) ?? index)
      const hasRecoveryAfter = lastProgressIndex > settledAtIndex
      severities.set(
        message.toolUseId,
        isActiveTurn || hasRecoveryAfter ? 'recovered' : 'blocking',
      )
    })
  })

  return severities
}

/**
 * Resolve a single tool call's effective error severity (including its child
 * calls). When no turn-level severity map is supplied (e.g. a standalone
 * `ActivityGroup` in unit tests), intermediate failures followed by a later
 * step or occurring while live still classify as `'recovered'`.
 */
export function resolveToolErrorSeverity(
  toolCall: ToolCall,
  resultMap: Map<string, ToolResult>,
  childToolCallsByParent: Map<string, ToolCall[]>,
  errorSeverityByToolUseId?: ReadonlyMap<string, ToolErrorSeverity>,
  options: { hasLaterStep?: boolean; isLive?: boolean } = {},
): ToolErrorSeverity {
  if (!toolCallHasError(toolCall, resultMap, childToolCallsByParent)) return 'none'

  if (errorSeverityByToolUseId) {
    const direct = errorSeverityByToolUseId.get(toolCall.toolUseId)
    if (direct === 'blocking') return 'blocking'

    const children = childToolCallsByParent.get(toolCall.toolUseId) ?? []
    for (const child of children) {
      if (
        resolveToolErrorSeverity(child, resultMap, childToolCallsByParent, errorSeverityByToolUseId, options) === 'blocking'
      ) {
        return 'blocking'
      }
    }
    if (direct === 'recovered') return 'recovered'
    if (children.some((child) => toolCallHasError(child, resultMap, childToolCallsByParent))) {
      return 'recovered'
    }
  }

  if (options.isLive || options.hasLaterStep) return 'recovered'
  return 'blocking'
}

/** Count ONLY unrecovered/blocking failed steps in a run. */
export function countBlockingFailedToolCalls(
  steps: ActivityStep[],
  resultMap: Map<string, ToolResult>,
  childToolCallsByParent: Map<string, ToolCall[]>,
  errorSeverityByToolUseId?: ReadonlyMap<string, ToolErrorSeverity>,
  isLive = false,
): number {
  let count = 0
  steps.forEach((step, index) => {
    if (step.kind !== 'tool') return
    const hasLaterStep = index < steps.length - 1
    const severity = resolveToolErrorSeverity(
      step.toolCall,
      resultMap,
      childToolCallsByParent,
      errorSeverityByToolUseId,
      { hasLaterStep, isLive },
    )
    if (severity === 'blocking') count += 1
  })
  return count
}

function compactToolTarget(toolCall: ToolCall): string {
  const input = toolCall.input && typeof toolCall.input === 'object' && !Array.isArray(toolCall.input)
    ? (toolCall.input as Record<string, unknown>)
    : {}
  const str = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
  const filePath = str(input.file_path) || (toolCall.toolName === 'NotebookEdit' ? str(input.notebook_path) : '')
  if (filePath) return filePath.split(/[/\\]/).pop() || filePath

  switch (toolCall.toolName) {
    case 'Bash':
    case 'PowerShell':
      return str(input.description) || str(input.command)
    case 'Grep':
    case 'Glob':
      return str(input.pattern)
    case 'WebSearch':
    case 'ToolSearch':
      return str(input.query)
    case 'WebFetch':
      return str(input.url)
    case 'Agent':
      return str(input.description)
    case 'Skill':
      return str(input.skill)
    case 'TaskCreate':
      return str(input.subject)
    case 'TaskUpdate':
    case 'TaskGet':
      return str(input.subject) || (str(input.taskId) ? `#${str(input.taskId)}` : '')
    default:
      return ''
  }
}

/**
 * Concise single-line label for a single-step work row (`Read MessageList.tsx`,
 * `Create ui-smoke-output.txt`, `Run bun test`).
 */
export function describeToolStep(toolCall: ToolCall, t: Translate): { action: string; detail: string } {
  const input = toolCall.input && typeof toolCall.input === 'object' && !Array.isArray(toolCall.input)
    ? (toolCall.input as Record<string, unknown>)
    : {}
  if (
    (toolCall.toolName === 'Bash' || toolCall.toolName === 'PowerShell') &&
    typeof input.description === 'string' &&
    input.description.trim()
  ) {
    return { action: input.description.trim(), detail: '' }
  }
  return {
    action: toolVerb(toolCall.toolName, t),
    detail: compactToolTarget(toolCall),
  }
}

/**
 * Concise active label for a collapsed live activity strip (Codex style):
 * smoothly reflects what the model is doing right now without opening 30 rows.
 */
export function describeLiveActivityStep(
  steps: ActivityStep[],
  resultMap: Map<string, ToolResult>,
  activeThinkingId: string | null | undefined,
  t: Translate,
): { action: string; detail: string } {
  if (
    activeThinkingId &&
    steps.some((step) => step.kind === 'thinking' && step.message.id === activeThinkingId)
  ) {
    return { action: t('thinking.label'), detail: '' }
  }

  // Prefer the newest unresolved tool call.
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index]
    if (step?.kind === 'tool' && !resultMap.has(step.toolCall.toolUseId) && step.toolCall.status !== 'stopped') {
      return describeToolStep(step.toolCall, t)
    }
  }

  // Otherwise reflect the tail step while waiting between tools.
  const lastStep = steps[steps.length - 1]
  if (lastStep?.kind === 'thinking') {
    return { action: t('thinking.label'), detail: '' }
  }
  if (lastStep?.kind === 'tool') {
    return describeToolStep(lastStep.toolCall, t)
  }
  return { action: t('serverVerb.Working'), detail: '' }
}

/**
 * Surface the basename when a settled run wrote or edited a single file so
 * filenames remain scannable (and smoke/replay assertions find written paths)
 * even while the activity group is collapsed.
 */
export function singleMutatedFileBasename(steps: ActivityStep[]): string | null {
  const paths = new Set<string>()
  for (const step of steps) {
    if (step.kind !== 'tool') continue
    if (step.toolCall.toolName !== 'Write' && step.toolCall.toolName !== 'Edit' && step.toolCall.toolName !== 'MultiEdit') {
      continue
    }
    const input = step.toolCall.input
    if (!input || typeof input !== 'object' || Array.isArray(input)) continue
    const filePath = (input as Record<string, unknown>).file_path
    if (typeof filePath === 'string' && filePath.trim()) {
      const basename = filePath.trim().split(/[/\\]/).pop()
      if (basename) paths.add(basename)
    }
  }
  if (paths.size === 1) return [...paths][0] ?? null
  return null
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
