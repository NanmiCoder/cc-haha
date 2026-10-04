import { memo, useEffect, useMemo, useState } from 'react'
import { getDisclosure, setDisclosure } from '../../lib/disclosureMemory'
import { toolResultImagesFor, type ToolResultImageExtraction } from '@/lib/toolResultContent'
import { CircleX } from 'lucide-react'
import { ToolCallBlock, formatDuration } from './ToolCallBlock'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolResultImages } from './ToolResultImages'
import {
  activityDurationMs,
  activityStepToolCalls,
  buildActivitySegments,
  countFailedToolCalls,
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
}

/**
 * One contiguous run of thinking + tool calls.
 *
 * It plays open while it runs, so the reader can watch the work, then folds
 * itself into a single counted line the moment it finishes: `thought 5 times,
 * read 2 files, ran 1 command`. Standing rows open forever flattened the
 * transcript — machinery took as much room as the sentences it produced, and
 * nothing looked more important than anything else. A counted digest is small
 * enough to skip and specific enough to be worth reading, which a vaguer
 * "ran some commands" never was.
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
  // Keyed off "still being written to", never off "a tool is executing right
  // now". The latter flickers: a run of six tools resolves and restarts six
  // times, and folding on each gap made the whole block open and shut under the
  // reader while they were trying to watch it.
  // Open in the same render the request arrives in, so the row is in the DOM
  // for the scroll that follows; the effect above makes it stick.
  const collapsed = revealsHere ? false : (pinnedCollapsed ?? !isLive)

  const soleToolCall = steps.length === 1 && steps[0]?.kind === 'tool' ? steps[0].toolCall : null
  if (soleToolCall) {
    return (
      <div>
        <div
          data-testid="activity-group"
          data-single-step="true"
        >
          <ActivityToolRow
            toolCall={soleToolCall}
            resultMap={resultMap}
            childToolCallsByParent={childToolCallsByParent}
            revealToolUseId={revealToolUseId}
          />
        </div>
      </div>
    )
  }

  const segments = buildActivitySegments(steps, t)
  const elapsed = activityDurationMs(steps, resultMap)
  const durationLabel = !isRunning && typeof elapsed === 'number' ? formatDuration(elapsed) : ''
  const summaryText = segments.map((segment) => segment.label).join(', ')

  return (
    <div>
      <div
        data-testid="activity-group"
        data-expanded={collapsed ? 'false' : 'true'}
        data-running={isRunning ? 'true' : 'false'}
        className="rounded-[var(--radius-md)]"
      >
        {/*
          Deliberately a whisper: 12px, tertiary, no icons, commas rather than
          middots. Its whole job is to be skippable — the prose above and below
          it is the conversation, and anything with weight here competes with
          that. The counts are what make it worth having at all.
        */}
        <button
          type="button"
          data-chat-disclosure="true"
          onClick={() => setPinnedCollapsed(!collapsed)}
          aria-expanded={!collapsed}
          title={summaryText}
          className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-2 rounded-[var(--radius-md)] px-2 py-1 text-left text-[12px] leading-[1.6] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-secondary)] focus:outline-none focus-visible:shadow-[var(--shadow-focus-ring)]"
        >
          <span className="min-w-0 flex-1 truncate">{summaryText}</span>
          <span className="flex shrink-0 items-center gap-2">
            {failedCount > 0 && (
              <span className="flex items-center gap-[5px] whitespace-nowrap font-medium text-[var(--color-error)]">
                <CircleX size={12} strokeWidth={2} aria-hidden="true" />
                {t('toolGroup.failedCount', { count: failedCount })}
              </span>
            )}
            {durationLabel && (
              <span className="whitespace-nowrap font-mono tabular-nums">{durationLabel}</span>
            )}
            <span aria-hidden="true" className={`w-3 text-center text-[8px] ${collapsed ? '' : 'rotate-90'}`}>▸</span>
          </span>
        </button>

        {/* Folding hides the rows, and with them any picture a tool returned.
            Open, each row shows its own, so these exist only while folded. */}
        {collapsed ? <CollapsedRunImages toolCalls={toolCalls} resultMap={resultMap} /> : null}

        {/* Rows hang off the summary that names them, so they take the guide
            line and its indent. That is also why they can afford it here and not
            when there is no summary — nothing to hang from, nothing to indent. */}
        {!collapsed && (
          <div className="ml-[3px] flex flex-col border-l border-[var(--color-border)] pl-3">
            {steps.map((step) => step.kind === 'thinking' ? (
              <ThinkingBlock
                key={step.message.id}
                content={step.message.content}
                isActive={step.message.id === activeThinkingId}
              />
            ) : (
              <ActivityToolRow
                key={step.toolCall.id}
                toolCall={step.toolCall}
                resultMap={resultMap}
                childToolCallsByParent={childToolCallsByParent}
                revealToolUseId={revealToolUseId}
              />
            ))}
          </div>
        )}
      </div>
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

/** A tool row plus, indented under it, the rows of anything it dispatched. */
function ActivityToolRow({
  toolCall,
  resultMap,
  childToolCallsByParent,
  revealToolUseId,
}: {
  toolCall: ToolCall
  resultMap: Map<string, ToolResult>
  childToolCallsByParent: Map<string, ToolCall[]>
  revealToolUseId?: string
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
      />
      {childToolCalls.length > 0 && (
        <div className="ml-2 border-l border-[var(--color-border)] pl-3">
          {childToolCalls.map((childToolCall) => (
            <ActivityToolRow
              key={childToolCall.id}
              toolCall={childToolCall}
              resultMap={resultMap}
              childToolCallsByParent={childToolCallsByParent}
            />
          ))}
        </div>
      )}
    </div>
  )
}
