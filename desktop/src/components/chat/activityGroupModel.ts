import {
  Bot,
  Brain,
  FilePen,
  FilePlus,
  FileText,
  Globe,
  ListTodo,
  Search,
  Terminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import type { TranslationKey } from '../../i18n'
import type { UIMessage } from '../../types/chat'
import { estimateTokens } from '../../lib/tpsMeter'
import { extractTextContent } from '../../lib/traceViewModel'

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
}

const TOOL_SEGMENT_ICONS: Record<string, LucideIcon> = {
  Bash: Terminal,
  PowerShell: Terminal,
  Read: FileText,
  Write: FilePlus,
  Edit: FilePen,
  MultiEdit: FilePen,
  NotebookEdit: FilePen,
  Glob: Search,
  Grep: Search,
  Agent: Bot,
  WebSearch: Globe,
  WebFetch: Globe,
  TaskCreate: ListTodo,
  TaskUpdate: ListTodo,
  TaskList: ListTodo,
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
    const key = step.kind === 'thinking' ? THINKING_SEGMENT_KEY : step.toolCall.toolName
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
 * Combined "work time" of the whole run: the sum of every settled segment —
 * each thinking block's recorded generation span plus each tool call's
 * execution span — rather than the wall-clock span from first step to last
 * result. The span overcounted: it includes the idle gaps between steps, and a
 * run that ends in thought never had an "end" at all, so its time was not
 * shown. Summing segments counts exactly what the run worked, which is what
 * "thinking + tools time" means. Thinking blocks without a recorded duration
 * (older transcripts) contribute nothing; a run with no measurable segment at
 * all returns undefined, so the header prints no number instead of `0s`.
 */
export function activityDurationMs(
  steps: ActivityStep[],
  resultMap: Map<string, ToolResult>,
): number | undefined {
  let total = 0
  let measured = false

  for (const step of steps) {
    if (step.kind === 'thinking') {
      const durationMs = step.message.thinkingDurationMs
      if (typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0) {
        total += durationMs
        measured = true
      }
      continue
    }
    const result = resultMap.get(step.toolCall.toolUseId)
    const durationMs = toolCallDurationMs(step.toolCall, result)
    if (typeof durationMs === 'number') {
      total += durationMs
      measured = true
    }
  }

  return measured ? total : undefined
}

/** Estimated tokens a run spent: thought content plus the tool results it pulled in. */
export type ActivityTokenUsage = {
  thinkingTokens: number
  toolTokens: number
  /** True when the thought side is an estimate (no real API thinking-token count
   *  was returned). Drives the label: estimated → `thought + tool`, real → one total. */
  thinkingIsEstimated: boolean
}

/**
 * Token usage of a whole activity run. The model does not return a dedicated
 * thinking-token count, so the thought side is estimated from content (the same
 * CJK/ASCII heuristic the per-thought badge and the TPS meter use) and the tool
 * side from the text of each result — the content that actually entered the
 * context. A run that produced neither shows `0 + 0` only if it had steps at all;
 * an empty run returns all zeros with `thinkingIsEstimated` true and the caller
 * decides whether that warrants a label.
 */
export function activityTokenUsage(
  steps: ActivityStep[],
  resultMap: Map<string, ToolResult>,
): ActivityTokenUsage {
  let thinkingTokens = 0
  let toolTokens = 0
  let thinkingIsEstimated = true

  for (const step of steps) {
    if (step.kind === 'thinking') {
      if (step.message.content.trim().length > 0) {
        thinkingTokens += estimateTokens(step.message.content)
      }
      continue
    }
    const result = resultMap.get(step.toolCall.toolUseId)
    if (result && typeof result.content !== 'undefined') {
      toolTokens += estimateTokens(extractTextContent(result.content))
    }
  }

  return { thinkingTokens, toolTokens, thinkingIsEstimated }
}

/**
 * The run's token label parts. Estimated thought → two numbers (thought, then
 * tool); a real thought count → one combined total, because then the number is
 * what the API billed rather than two different measurement methods glued
 * together.
 *
 * Returned as parts rather than a joined string so the separator can be laid
 * out with CSS: the label renders in a monospace font, where a literal space is
 * a full character cell and cannot be tightened to an in-between width.
 */
export function activityTokenParts(usage: ActivityTokenUsage): string[] {
  if (!usage.thinkingIsEstimated) {
    return [formatActivityTokens(usage.thinkingTokens + usage.toolTokens)]
  }
  return [
    formatActivityTokens(usage.thinkingTokens),
    formatActivityTokens(usage.toolTokens),
  ]
}

/** Plain-string form of {@link activityTokenParts}, for tests and fallbacks. */
export function activityTokenLabel(usage: ActivityTokenUsage): string {
  return activityTokenParts(usage).join(' + ')
}

/** Token count as `xx.xxk`, two decimals (`0.80k`, `12.50k`). */
export function formatActivityTokens(tokens: number): string {
  return `${(tokens / 1000).toFixed(2)}k`
}

export function activityStepToolCalls(steps: ActivityStep[]): ToolCall[] {
  return steps.flatMap((step) => (step.kind === 'tool' ? [step.toolCall] : []))
}

export function toActivitySteps(toolCalls: ToolCall[]): ActivityStep[] {
  return toolCalls.map((toolCall) => ({ kind: 'tool', toolCall }))
}
