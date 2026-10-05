import { memo, useEffect, useMemo, useState, type ReactNode } from 'react'
import { getDisclosure, setDisclosure } from '../../lib/disclosureMemory'
import { toolResultImagesFor, type ToolResultImageExtraction } from '@/lib/toolResultContent'
import { ChevronRight, CirclePause, CircleX, LoaderCircle } from 'lucide-react'
import { ToolCallBlock, formatDuration } from './ToolCallBlock'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolResultImages } from './ToolResultImages'
import {
  activityDurationMs,
  activityStepToolCalls,
  buildActivitySegments,
  countFailedToolCalls,
  formatActivitySummary,
  hasUnresolvedToolCalls,
  toolCallDurationMs,
  type ActivityStep,
} from './activityGroupModel'
import { useTranslation } from '../../i18n'
import type { UIMessage } from '../../types/chat'

type ToolCall = Extract<UIMessage, { type: 'tool_use' }>
type ToolResult = Extract<UIMessage, { type: 'tool_result' }>

type Props = {
  steps: ActivityStep[]
  resultMap: Map<string, ToolResult>
  childToolCallsByParent: Map<string, ToolCall[]>
  activeThinkingId?: string | null
  /** When true, the last step is still executing. */
  isStreaming?: boolean
  /**
   * This run is the tail of a turn that is still going, so more steps may land
   * in it. Distinct from `isStreaming`: that one dips false in the gap between
   * one tool resolving and the next starting, many times inside a single run.
   */
  isLive?: boolean
  /** Stable key that survives virtualized row unmount/remount. */
  disclosureKey?: string
  /**
   * A "locate in chat" jump landed on this call. A folded run would hide it,
   * so the run opens (and stays open, as if the reader had clicked) and the
   * row is marked while the jump's highlight lasts.
   */
  revealToolUseId?: string
  /** Calls whose permission prompt is waiting on the user. */
  awaitingToolUseIds?: ReadonlySet<string>
}

const MAX_HEADER_ICONS = 3

function isAwaiting(toolCall: ToolCall, awaiting?: ReadonlySet<string>): boolean {
  if (!awaiting || awaiting.size === 0) return false
  return awaiting.has(toolCall.toolUseId) ||
    (toolCall.originalToolUseId !== undefined && awaiting.has(toolCall.originalToolUseId))
}

/**
 * The vertical rail of a run: a 1px line through the centres of the rows'
 * 22px nodes. It runs behind the details too, so an opened diff or terminal
 * still reads as hanging off its step.
 */
export function ToolTimeline({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div data-tool-timeline="" className={`relative ${className}`}>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute bottom-3 left-[10.5px] top-3 w-px bg-[var(--color-outline)]"
      />
      {children}
    </div>
  )
}

/**
 * One contiguous run of thinking + tool calls.
 *
 * It plays open while it runs, so the reader can watch the work, then folds
 * itself into a single counted line the moment it finishes: `思考 2 次、读取
 * 1 个文件、运行 1 条命令`. Standing rows open forever flattened the transcript —
 * machinery took as much room as the sentences it produced, and nothing looked
 * more important than anything else. A counted digest is small enough to skip
 * and specific enough to be worth reading, which a vaguer "ran some commands"
 * never was.
 *
 * Clicking pins the reader's choice: from then on that run stays as they left
 * it, instead of snapping shut under them when the next step resolves.
 *
 * A run holding exactly one tool call never summarises: "Read 1 file" over a
 * hidden `Read MessageList.tsx` row is strictly less than the row itself.
 */
export const ActivityGroup = memo(function ActivityGroup({
  steps,
  resultMap,
  childToolCallsByParent,
  activeThinkingId,
  isStreaming,
  isLive = false,
  disclosureKey,
  revealToolUseId,
  awaitingToolUseIds,
}: Props) {
  const t = useTranslation()
  /** null = follow the run's own state; set = the reader decided. */
  const [pinnedCollapsedLocal, setPinnedCollapsedLocal] = useState<boolean | null>(null)
  const pinnedCollapsed = disclosureKey
    ? (getDisclosure(disclosureKey) ?? pinnedCollapsedLocal)
    : pinnedCollapsedLocal
  const setPinnedCollapsed = (next: boolean | null) => {
    setPinnedCollapsedLocal(next)
    if (disclosureKey && next !== null) setDisclosure(disclosureKey, next)
  }

  const toolCalls = useMemo(() => activityStepToolCalls(steps), [steps])
  const revealsHere = revealToolUseId !== undefined && toolCalls.some((toolCall) => toolCall.toolUseId === revealToolUseId)
  useEffect(() => {
    if (revealsHere) setPinnedCollapsed(false)
    // Pin once per request; `setPinnedCollapsed` is recreated every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealsHere, revealToolUseId])
  const failedCount = countFailedToolCalls(toolCalls, resultMap, childToolCallsByParent)
  const hasActiveThinking = Boolean(activeThinkingId) && steps.some(
    (step) => step.kind === 'thinking' && step.message.id === activeThinkingId,
  )
  const isRunning =
    Boolean(isStreaming) ||
    hasActiveThinking ||
    hasUnresolvedToolCalls(toolCalls, resultMap, childToolCallsByParent)
  // Only a run that is still being written to may claim to be in progress. A
  // transcript whose last call never got a result (the process died) is
  // unresolved forever, and a spinner on it would be a lie.
  const showsProgress = isRunning && (isLive || Boolean(isStreaming) || hasActiveThinking)
  const awaitingCount = toolCalls.filter((toolCall) => !resultMap.has(toolCall.toolUseId) && isAwaiting(toolCall, awaitingToolUseIds)).length
  // Keyed off "still being written to", never off "a tool is executing right
  // now". The latter flickers: a run of six tools resolves and restarts six
  // times, and folding on each gap made the whole block open and shut under the
  // reader while they were trying to watch it.
  // Open in the same render the request arrives in, so the row is in the DOM
  // for the scroll that follows; the effect above makes it stick.
  const collapsed = revealsHere ? false : (pinnedCollapsed ?? !isLive)
  const rowProps = {
    resultMap,
    childToolCallsByParent,
    revealToolUseId,
    awaitingToolUseIds,
    live: showsProgress,
  }

  const soleToolCall = steps.length === 1 && steps[0]?.kind === 'tool' ? steps[0].toolCall : null
  if (soleToolCall) {
    return (
      <div>
        <div
          data-testid="activity-group"
          data-single-step="true"
        >
          <ToolTimeline>
            <ActivityToolRow toolCall={soleToolCall} {...rowProps} />
          </ToolTimeline>
        </div>
      </div>
    )
  }

  const segments = buildActivitySegments(steps, t)
  const elapsed = activityDurationMs(steps, resultMap)
  const durationLabel = !isRunning && typeof elapsed === 'number' ? formatDuration(elapsed) : ''
  const summaryText = formatActivitySummary(segments, t)
  // One glyph per kind of work: searching the web and reading a page share the
  // globe, and two globes side by side read as a rendering glitch.
  const headerIcons = segments
    .filter((segment, index) => segments.findIndex((other) => other.icon === segment.icon) === index)
    .slice(0, MAX_HEADER_ICONS)

  return (
    <div>
      <div
        data-testid="activity-group"
        data-expanded={collapsed ? 'false' : 'true'}
        data-running={isRunning ? 'true' : 'false'}
      >
        {/*
          One quiet line: the families' glyphs, the counted sentence, then what
          needs the reader — failures in red, a pending approval in amber, live
          work in blue — and otherwise the run's duration. The counts are what
          make it worth having at all.
        */}
        <button
          type="button"
          data-chat-disclosure="true"
          onClick={() => setPinnedCollapsed(!collapsed)}
          aria-expanded={!collapsed}
          title={summaryText}
          className="group/activity flex min-h-[28px] w-full items-center gap-2 rounded-[var(--radius-sm)] text-left text-[13px] focus:outline-none focus-visible:shadow-[var(--shadow-focus-ring)]"
        >
          <span aria-hidden="true" className="flex shrink-0 items-center gap-0.5 text-[var(--color-text-tertiary)]">
            {headerIcons.map((segment) => {
              const Icon = segment.icon
              return <Icon key={segment.key} size={14} strokeWidth={1.75} />
            })}
          </span>
          <span
            data-activity-summary=""
            className="min-w-0 flex-1 truncate text-[var(--color-text-secondary)] transition-colors group-hover/activity:text-[var(--color-text-primary)]"
          >
            {summaryText}
          </span>
          {failedCount > 0 && (
            <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-[12px] text-[var(--color-error)]">
              <CircleX size={12} strokeWidth={2} aria-hidden="true" />
              {t('toolGroup.failedCount', { count: failedCount })}
            </span>
          )}
          {awaitingCount > 0 ? (
            <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-[12px] font-medium text-[var(--color-on-warning-container)]">
              <CirclePause size={12} strokeWidth={2} aria-hidden="true" />
              {t('permission.awaitingApproval')}
            </span>
          ) : showsProgress ? (
            <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-[12px] text-[var(--color-info)]">
              <LoaderCircle size={12} strokeWidth={2} className="animate-spin" aria-hidden="true" />
              {t('agentStatus.running')}
            </span>
          ) : durationLabel ? (
            <span className="shrink-0 whitespace-nowrap font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]">{durationLabel}</span>
          ) : null}
          <ChevronRight
            size={14}
            strokeWidth={1.75}
            aria-hidden="true"
            className={`shrink-0 text-[var(--color-text-tertiary)] transition-transform duration-150 ${collapsed ? '' : 'rotate-90'}`}
          />
        </button>

        {/* Folding hides the rows, and with them any picture a tool returned.
            Open, each row shows its own, so these exist only while folded. */}
        {collapsed ? <CollapsedRunImages toolCalls={toolCalls} resultMap={resultMap} /> : null}

        {!collapsed && (
          <ToolTimeline className="mt-0.5">
            {steps.map((step) => step.kind === 'thinking' ? (
              <TimelineThinking
                key={step.message.id}
                content={step.message.content}
                isActive={step.message.id === activeThinkingId}
              />
            ) : (
              <ActivityToolRow key={step.toolCall.id} toolCall={step.toolCall} {...rowProps} />
            ))}
          </ToolTimeline>
        )}
      </div>
    </div>
  )
})

/** A thought on the rail: a small hollow stop, its row hung on the text column. */
function TimelineThinking({ content, isActive }: { content: string; isActive: boolean }) {
  return (
    <div className="relative pl-[30px]">
      <span
        aria-hidden="true"
        className="absolute left-[7px] top-[10px] h-2 w-2 rounded-full border border-[var(--color-outline)] bg-[var(--color-surface)]"
      />
      <ThinkingBlock content={content} isActive={isActive} />
    </div>
  )
}

type RunImageStrip = ToolResultImageExtraction & {
  id: string
  toolName: string
  originalPath?: string
}

/**
 * The pictures a folded run's tools returned, under its summary line.
 *
 * A picture is what the tool was called for, not machinery to skim past, so it
 * does not vanish with the rows. One strip per top-level call, in step order, each
 * named for its own tool and offering its own original; calls the run dispatched
 * are left to their rows.
 *
 * Read from the result map on every render, but each result's content is
 * validated once: the map is rebuilt for every streamed token (and so is this
 * component's input), which is why the memoization sits on the content object in
 * `extractToolResultImages` rather than on the map or the calls.
 */
function CollapsedRunImages({
  toolCalls,
  resultMap,
}: {
  toolCalls: ToolCall[]
  resultMap: Map<string, ToolResult>
}) {
  const strips = useMemo(() => {
    const found: RunImageStrip[] = []
    for (const toolCall of toolCalls) {
      const result = resultMap.get(toolCall.toolUseId)
      if (!result) continue
      const shown = toolResultImagesFor({
        toolName: toolCall.toolName,
        input: toolCall.input,
        content: result.content,
      })
      if (shown.images.length > 0 || shown.dropped > 0) {
        found.push({ ...shown, id: toolCall.id, toolName: toolCall.toolName })
      }
    }
    return found
  }, [resultMap, toolCalls])

  return (
    <>
      {strips.map((strip) => (
        <ToolResultImages
          key={strip.id}
          images={strip.images}
          omitted={strip.dropped}
          originalPath={strip.originalPath}
          toolName={strip.toolName}
          className="pb-1 pt-1"
        />
      ))}
    </>
  )
}

/** A tool row plus, indented under it on its own rail, the rows of anything it dispatched. */
function ActivityToolRow({
  toolCall,
  resultMap,
  childToolCallsByParent,
  revealToolUseId,
  awaitingToolUseIds,
  live = false,
}: {
  toolCall: ToolCall
  resultMap: Map<string, ToolResult>
  childToolCallsByParent: Map<string, ToolCall[]>
  revealToolUseId?: string
  awaitingToolUseIds?: ReadonlySet<string>
  /** The run is still being written to, so a resultless call is executing. */
  live?: boolean
}) {
  const result = resultMap.get(toolCall.toolUseId)
  const childToolCalls = childToolCallsByParent.get(toolCall.toolUseId) ?? []

  return (
    <div data-chat-anchor-id={toolCall.id}>
      <ToolCallBlock
        chrome="row"
        toolName={toolCall.toolName}
        input={toolCall.input}
        result={result ? { content: result.content, isError: result.isError } : null}
        isPending={toolCall.isPending}
        status={toolCall.status}
        partialInput={toolCall.partialInput}
        durationMs={toolCallDurationMs(toolCall, result)}
        toolUseId={toolCall.parentToolUseId ? undefined : toolCall.toolUseId}
        navigationHighlighted={revealToolUseId !== undefined && toolCall.toolUseId === revealToolUseId}
        awaitingApproval={!result && isAwaiting(toolCall, awaitingToolUseIds)}
        running={live && !result && toolCall.status !== 'stopped'}
      />
      {childToolCalls.length > 0 && (
        <ToolTimeline className="ml-[30px]">
          {childToolCalls.map((childToolCall) => (
            <ActivityToolRow
              key={childToolCall.id}
              toolCall={childToolCall}
              resultMap={resultMap}
              childToolCallsByParent={childToolCallsByParent}
              awaitingToolUseIds={awaitingToolUseIds}
              live={live}
            />
          ))}
        </ToolTimeline>
      )}
    </div>
  )
}
