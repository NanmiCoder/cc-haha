import { memo, useEffect, useMemo, useState, type ReactNode } from 'react'
import { getDisclosure, setDisclosure } from '../../lib/disclosureMemory'
import { toolResultImagesFor, type ToolResultImageExtraction } from '@/lib/toolResultContent'
import { Check, ChevronRight, CirclePause, CircleX, LoaderCircle } from 'lucide-react'
import { MobileBottomSheet } from '@/components/ui/MobileBottomSheet'
import { ToolCallBlock, formatDuration } from './ToolCallBlock'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolResultImages } from './ToolResultImages'
import {
  activityDurationMs,
  activityStepToolCalls,
  buildActivitySegments,
  countBlockingFailedToolCalls,
  describeLiveActivityStep,
  describeToolStep,
  formatActivitySummary,
  hasUnresolvedToolCalls,
  resolveToolErrorSeverity,
  singleMutatedFileBasename,
  toolCallDurationMs,
  type ActivityStep,
  type ToolErrorSeverity,
} from './activityGroupModel'
import { useTranslation } from '../../i18n'
import type { UIMessage } from '../../types/chat'

type ToolCall = Extract<UIMessage, { type: 'tool_use' }>
type ToolResult = Extract<UIMessage, { type: 'tool_result' }>

type Props = {
  steps: ActivityStep[]
  resultMap: Map<string, ToolResult>
  childToolCallsByParent: Map<string, ToolCall[]>
  /** Turn-scoped error classification distinguishing recovered vs blocking failures. */
  errorSeverityByToolUseId?: ReadonlyMap<string, ToolErrorSeverity>
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
  /**
   * `inline` opens the run in place. `sheet` (the phone) keeps every run one
   * card: the counted summary, plus the step under way while it runs; a tap
   * opens the whole timeline in a sheet. A run unfolding in place on a phone
   * pushed the conversation off the screen a step at a time.
   */
  presentation?: 'inline' | 'sheet'
}

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
        className="pointer-events-none absolute bottom-3 left-[11.5px] top-3 w-px bg-[var(--color-border)]"
      />
      {children}
    </div>
  )
}

/**
 * One contiguous run of thinking + tool calls (Codex calm work row).
 *
 * Defaults collapsed even while live so active work stays a single quiet
 * borderless shimmer line (`Reading foo.ts`, `Running bun test`, `Thinking`)
 * with zero live-to-collapsed layout cliff. Clicking toggles the full step
 * timeline on demand, and clicking pins the reader's choice across rerenders.
 *
 * Intermediate tool errors that the agent self-recovers from never trigger red
 * rings or `"N failed"` badges; only terminal blocking errors surface a subtle
 * failure indicator.
 */
export const ActivityGroup = memo(function ActivityGroup({
  steps,
  resultMap,
  childToolCallsByParent,
  errorSeverityByToolUseId,
  activeThinkingId,
  isStreaming,
  isLive = false,
  disclosureKey,
  revealToolUseId,
  awaitingToolUseIds,
  presentation = 'inline',
}: Props) {
  const t = useTranslation()
  const [sheetOpen, setSheetOpen] = useState(false)
  /** null = default collapsed (Codex calm rhythm); set = the reader decided. */
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
  const blockingFailedCount = countBlockingFailedToolCalls(
    steps,
    resultMap,
    childToolCallsByParent,
    errorSeverityByToolUseId,
    showsProgress || isLive,
  )
  const awaitingCount = toolCalls.filter((toolCall) => !resultMap.has(toolCall.toolUseId) && isAwaiting(toolCall, awaitingToolUseIds)).length
  // Always default collapsed (even while live) to avoid the live-to-collapsed
  // layout cliff and keep the transcript calm. Readers can click to expand
  // live or settled runs at any time.
  const collapsed = revealsHere ? false : (pinnedCollapsed ?? true)

  const [liveNow, setLiveNow] = useState(() => Date.now())
  useEffect(() => {
    if (!showsProgress) return undefined
    setLiveNow(Date.now())
    const timer = window.setInterval(() => setLiveNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [showsProgress])

  const firstStepTimestamp = useMemo(() => {
    let min = Number.POSITIVE_INFINITY
    for (const step of steps) {
      const ts = step.kind === 'thinking' ? step.message.timestamp : step.toolCall.timestamp
      if (Number.isFinite(ts) && ts > 0) min = Math.min(min, ts)
    }
    return Number.isFinite(min) ? min : undefined
  }, [steps])

  const rowBaseProps = {
    resultMap,
    childToolCallsByParent,
    errorSeverityByToolUseId,
    revealToolUseId,
    awaitingToolUseIds,
    live: showsProgress,
  }

  const segments = buildActivitySegments(steps, t)
  const elapsed = activityDurationMs(steps, resultMap)
  const liveElapsedMs = showsProgress && firstStepTimestamp !== undefined
    ? Math.max(0, liveNow - firstStepTimestamp)
    : undefined
  const durationLabel = !isRunning && typeof elapsed === 'number'
    ? formatDuration(elapsed)
    : liveElapsedMs !== undefined && liveElapsedMs >= 1000
      ? formatDuration(liveElapsedMs)
      : ''

  const soleToolCall = steps.length === 1 && steps[0]?.kind === 'tool' ? steps[0].toolCall : null
  const soleStepLabel = soleToolCall ? describeToolStep(soleToolCall, t) : null
  const soleToolStopped = Boolean(
    soleToolCall && soleToolCall.status === 'stopped' && !resultMap.has(soleToolCall.toolUseId),
  )
  const baseSummaryText = formatActivitySummary(segments, t)
  const mutatedFile = singleMutatedFileBasename(steps)
  const summaryText = soleStepLabel
    ? [soleStepLabel.action, soleStepLabel.detail].filter(Boolean).join(' ')
    : mutatedFile && !baseSummaryText.includes(mutatedFile)
      ? `${baseSummaryText} · ${mutatedFile}`
      : baseSummaryText

  const liveStep = showsProgress
    ? describeLiveActivityStep(steps, resultMap, activeThinkingId, t)
    : null

  const renderTimeline = () => (
    <ToolTimeline>
      {steps.map((step, index) => step.kind === 'thinking' ? (
        <TimelineThinking
          key={step.message.id}
          content={step.message.content}
          isActive={step.message.id === activeThinkingId}
        />
      ) : (
        <ActivityToolRow
          key={step.toolCall.id}
          toolCall={step.toolCall}
          hasLaterStep={index < steps.length - 1}
          defaultExpanded={Boolean(soleToolCall)}
          {...rowBaseProps}
        />
      ))}
    </ToolTimeline>
  )

  if (presentation === 'sheet') {
    const lastToolStep = [...steps].reverse().find((step) => step.kind === 'tool')
    const liveToolCall = showsProgress && lastToolStep?.kind === 'tool' ? lastToolStep.toolCall : null
    const mobileRingClass = awaitingCount > 0
      ? 'v6c-ring-waiting'
      : 'border border-[var(--color-border)]'
    return (
      <div
        data-testid="activity-group"
        data-presentation="sheet"
        data-running={isRunning ? 'true' : 'false'}
        className={`overflow-hidden rounded-[var(--radius-lg)] bg-[var(--color-surface-container-lowest)] ${mobileRingClass}`}
      >
        <button
          type="button"
          data-chat-disclosure="true"
          aria-haspopup="dialog"
          onClick={() => setSheetOpen(true)}
          className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left text-[13px] focus:outline-none focus-visible:shadow-[var(--shadow-focus-ring)]"
        >
          <span
            aria-hidden="true"
            className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border ${
              awaitingCount > 0
                ? 'border-[var(--color-warning)] bg-[var(--color-warning-container)] text-[var(--color-on-warning-container)]'
                : showsProgress
                  ? 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-tertiary)]'
                  : blockingFailedCount > 0
                    ? 'border-[var(--color-error-container)] bg-[var(--color-error-container)] text-[var(--color-on-error-container)]'
                    : 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-tertiary)]'
            }`}
          >
            {awaitingCount > 0 ? <CirclePause size={12} strokeWidth={1.75} />
              : showsProgress ? <LoaderCircle size={12} strokeWidth={1.75} className="animate-spin" />
              : blockingFailedCount > 0 ? <CircleX size={12} strokeWidth={1.75} />
              : <Check size={12} strokeWidth={1.75} />}
          </span>
          <span
            data-activity-summary=""
            className={`min-w-0 flex-1 truncate font-medium ${
              showsProgress ? 'codex-shimmer-text' : 'text-[var(--color-text-secondary)]'
            }`}
          >
            {showsProgress && liveStep
              ? [liveStep.action, liveStep.detail].filter(Boolean).join(' ')
              : summaryText}
          </span>
          {blockingFailedCount > 0 && (
            <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-[12px] text-[var(--color-error)]">
              {t('toolGroup.failedCount', { count: blockingFailedCount })}
            </span>
          )}
          {awaitingCount > 0 ? (
            <span className="shrink-0 whitespace-nowrap text-[12px] font-medium text-[var(--color-on-warning-container)]">
              {t('permission.awaitingApproval')}
            </span>
          ) : durationLabel ? (
            <span className="shrink-0 whitespace-nowrap font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]">{durationLabel}</span>
          ) : null}
          <ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
        </button>
        {liveToolCall ? (
          <div data-testid="activity-live-step" className="border-t border-[var(--color-border)] px-2 pb-1 pt-1">
            <ToolTimeline>
              <ActivityToolRow
                toolCall={liveToolCall}
                hasLaterStep={false}
                {...rowBaseProps}
              />
            </ToolTimeline>
          </div>
        ) : null}
        {!liveToolCall ? <CollapsedRunImages toolCalls={toolCalls} resultMap={resultMap} /> : null}
        <MobileBottomSheet
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          title={summaryText}
          closeLabel={t('common.close')}
          testId="activity-timeline-sheet"
          tall
          contentClassName="px-3 py-2"
        >
          {renderTimeline()}
        </MobileBottomSheet>
      </div>
    )
  }

  return (
    <div>
      <div
        data-testid="activity-group"
        data-single-step={soleToolCall ? 'true' : undefined}
        data-tool-use-id={soleToolCall && collapsed ? soleToolCall.toolUseId : undefined}
        data-expanded={collapsed ? 'false' : 'true'}
        data-running={isRunning ? 'true' : 'false'}
        className={awaitingCount > 0 ? 'rounded-[var(--radius-md)] v6c-ring-waiting px-2 py-0.5' : undefined}
      >
        {/*
          Quiet borderless Codex-style work disclosure line:
          - While running: subtle horizontal shimmer on the active step (`Thinking`,
            `Read foo.ts`, `Run bun test`) + compact duration.
          - When settled: low-contrast muted summary (`Read 2 files, ran a command`)
            + duration, brightening smoothly on hover. Zero glass card or red ring.
        */}
        <button
          type="button"
          data-chat-disclosure="true"
          onClick={() => setPinnedCollapsed(!collapsed)}
          aria-expanded={!collapsed}
          title={summaryText}
          className="codex-work-row group/activity inline-flex min-h-6 max-w-full items-center gap-1.5 rounded-[var(--radius-sm)] py-0.5 text-left text-[13px] text-[var(--color-text-tertiary)] transition-colors hover:text-[var(--color-text-primary)] focus:outline-none focus-visible:shadow-[var(--shadow-focus-ring)]"
        >
          {showsProgress && liveStep ? (
            <span
              data-activity-summary=""
              data-activity-live-label="true"
              className="inline-flex min-w-0 items-baseline gap-1.5 truncate"
            >
              <span className="codex-shimmer-text shrink-0 font-medium">{liveStep.action}</span>
              {liveStep.detail ? (
                <span className="min-w-0 truncate font-mono text-[12px] text-[var(--color-text-tertiary)]">
                  {liveStep.detail}
                </span>
              ) : null}
            </span>
          ) : soleStepLabel ? (
            <span
              data-activity-summary=""
              className="inline-flex min-w-0 items-baseline gap-1.5 truncate text-[var(--color-text-tertiary)] transition-colors group-hover/activity:text-[var(--color-text-primary)]"
            >
              <span className="shrink-0">{soleStepLabel.action}</span>
              {soleStepLabel.detail ? (
                <span className="min-w-0 truncate font-mono text-[12px]">{soleStepLabel.detail}</span>
              ) : null}
            </span>
          ) : (
            <span
              data-activity-summary=""
              className="min-w-0 truncate text-[var(--color-text-tertiary)] transition-colors group-hover/activity:text-[var(--color-text-primary)]"
            >
              {summaryText}
            </span>
          )}
          {blockingFailedCount > 0 && (
            <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-[12px] tabular-nums text-[var(--color-error)]">
              <CircleX size={12} strokeWidth={1.75} aria-hidden="true" />
              {t('toolGroup.failedCount', { count: blockingFailedCount })}
            </span>
          )}
          {soleToolStopped ? (
            <span className="shrink-0 whitespace-nowrap text-[12px] text-[var(--color-text-tertiary)]">
              {t('tool.stopped')}
            </span>
          ) : null}
          {awaitingCount > 0 ? (
            <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-[12px] font-medium text-[var(--color-on-warning-container)]">
              <CirclePause size={12} strokeWidth={1.75} aria-hidden="true" />
              {t('permission.awaitingApproval')}
            </span>
          ) : durationLabel ? (
            <span className="shrink-0 whitespace-nowrap font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]">
              {durationLabel}
            </span>
          ) : null}
          <ChevronRight
            size={14}
            strokeWidth={1.75}
            aria-hidden="true"
            className={`shrink-0 opacity-60 transition-transform duration-150 motion-reduce:transition-none group-hover/activity:opacity-100 ${collapsed ? '' : 'rotate-90'}`}
          />
        </button>

        {/* Folding hides the rows, and with them any picture a tool returned.
            Open, each row shows its own, so these exist only while folded. */}
        {collapsed ? <CollapsedRunImages toolCalls={toolCalls} resultMap={resultMap} /> : null}

        {!collapsed && (
          <div className="mt-1 pb-1 pl-0.5">
            {renderTimeline()}
          </div>
        )}
      </div>
    </div>
  )
})

/** A thought on the rail: a small hollow stop, its row hung on the text column. */
const TimelineThinking = memo(function TimelineThinking({ content, isActive }: { content: string; isActive: boolean }) {
  return (
    <div className="relative pl-7">
      <span
        aria-hidden="true"
        className="absolute left-[8px] top-[9px] h-2 w-2 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)]"
      />
      <ThinkingBlock content={content} isActive={isActive} />
    </div>
  )
})

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

type ActivityToolRowProps = {
  toolCall: ToolCall
  resultMap: Map<string, ToolResult>
  childToolCallsByParent: Map<string, ToolCall[]>
  errorSeverityByToolUseId?: ReadonlyMap<string, ToolErrorSeverity>
  hasLaterStep?: boolean
  defaultExpanded?: boolean
  revealToolUseId?: string
  awaitingToolUseIds?: ReadonlySet<string>
  /** The run is still being written to, so a resultless call is executing. */
  live?: boolean
}

const NO_CHILD_TOOL_CALLS: ToolCall[] = []

/**
 * Whether `toolCall`'s row, and the rows it dispatched, read the same inputs
 * from both prop sets. The maps themselves are rebuilt from the whole
 * transcript on every streamed token, so comparing them by identity would
 * re-render every row of a run on every token — a live /goal run reached 1,400
 * rows and stalled the window for seconds (#1480). The message objects inside
 * them keep their identity until that message itself changes.
 */
function sameRowInputs(
  toolCall: ToolCall,
  prev: ActivityToolRowProps,
  next: ActivityToolRowProps,
): boolean {
  if (prev.resultMap.get(toolCall.toolUseId) !== next.resultMap.get(toolCall.toolUseId)) return false
  if (isAwaiting(toolCall, prev.awaitingToolUseIds) !== isAwaiting(toolCall, next.awaitingToolUseIds)) return false
  if (
    prev.errorSeverityByToolUseId?.get(toolCall.toolUseId) !==
    next.errorSeverityByToolUseId?.get(toolCall.toolUseId)
  ) {
    return false
  }
  const prevChildren = prev.childToolCallsByParent.get(toolCall.toolUseId) ?? NO_CHILD_TOOL_CALLS
  const nextChildren = next.childToolCallsByParent.get(toolCall.toolUseId) ?? NO_CHILD_TOOL_CALLS
  if (prevChildren.length !== nextChildren.length) return false
  return nextChildren.every((child, index) => (
    child === prevChildren[index] && sameRowInputs(child, prev, next)
  ))
}

/** A tool row plus, indented under it on its own rail, the rows of anything it dispatched. */
const ActivityToolRow = memo(function ActivityToolRow({
  toolCall,
  resultMap,
  childToolCallsByParent,
  errorSeverityByToolUseId,
  hasLaterStep = false,
  defaultExpanded = false,
  revealToolUseId,
  awaitingToolUseIds,
  live = false,
}: ActivityToolRowProps) {
  const result = resultMap.get(toolCall.toolUseId)
  const childToolCalls = childToolCallsByParent.get(toolCall.toolUseId) ?? NO_CHILD_TOOL_CALLS
  const errorSeverity = resolveToolErrorSeverity(
    toolCall,
    resultMap,
    childToolCallsByParent,
    errorSeverityByToolUseId,
    { hasLaterStep, isLive: live },
  )

  return (
    <div data-chat-anchor-id={toolCall.id}>
      <ToolCallBlock
        chrome="row"
        toolName={toolCall.toolName}
        input={toolCall.input}
        // The transcript's own result object, not a copy: `ToolCallBlock` is
        // memoized, and a fresh `{ content, isError }` here defeated it.
        result={result ?? null}
        errorSeverity={errorSeverity}
        isPending={toolCall.isPending}
        status={toolCall.status}
        partialInput={toolCall.partialInput}
        defaultExpanded={defaultExpanded}
        durationMs={toolCallDurationMs(toolCall, result)}
        toolUseId={toolCall.parentToolUseId ? undefined : toolCall.toolUseId}
        navigationHighlighted={revealToolUseId !== undefined && toolCall.toolUseId === revealToolUseId}
        awaitingApproval={!result && isAwaiting(toolCall, awaitingToolUseIds)}
        running={live && !result && toolCall.status !== 'stopped'}
      />
      {childToolCalls.length > 0 && (
        <ToolTimeline className="ml-7">
          {childToolCalls.map((childToolCall, index) => (
            <ActivityToolRow
              key={childToolCall.id}
              toolCall={childToolCall}
              resultMap={resultMap}
              childToolCallsByParent={childToolCallsByParent}
              errorSeverityByToolUseId={errorSeverityByToolUseId}
              hasLaterStep={hasLaterStep || index < childToolCalls.length - 1}
              awaitingToolUseIds={awaitingToolUseIds}
              live={live}
            />
          ))}
        </ToolTimeline>
      )}
    </div>
  )
}, (prev, next) => (
  prev.toolCall === next.toolCall &&
  prev.live === next.live &&
  prev.hasLaterStep === next.hasLaterStep &&
  prev.defaultExpanded === next.defaultExpanded &&
  prev.revealToolUseId === next.revealToolUseId &&
  sameRowInputs(next.toolCall, prev, next)
))
