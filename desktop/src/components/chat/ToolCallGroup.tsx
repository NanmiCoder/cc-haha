import { memo, useCallback, useMemo, useState } from 'react'
import { BookMarked, ChevronDown, ChevronRight, CircleCheck, Settings } from 'lucide-react'
import { ToolCallBlock, type ToolCallChrome } from './ToolCallBlock'
import { ActivityGroup } from './ActivityGroup'
import { ThinkingBlock } from './ThinkingBlock'
import {
  activityStepToolCalls,
  toActivitySteps,
  toolCallDurationMs,
  type ActivityStep,
} from './activityGroupModel'
import { ImageGenerationGroup, type ImageGenerationItem } from './ImageGenerationBlock'
import { isImageGenerationToolName } from './imageGenerationTools'
import { useAgentRunActivity } from './useAgentRunActivity'
import { MarkdownRenderer } from '../markdown/MarkdownRenderer'
import { Badge, type Tone } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Modal } from '@/components/ui/Modal'
import { useTranslation } from '../../i18n'
import type { TranslationKey } from '../../i18n'
import { SETTINGS_TAB_ID, useTabStore } from '../../stores/tabStore'
import { useUIStore } from '../../stores/uiStore'
import type { AgentTaskNotification, BackgroundAgentTask, UIMessage } from '../../types/chat'
import { AGENT_LIFECYCLE_TYPES } from '../../types/team'

type ToolCall = Extract<UIMessage, { type: 'tool_use' }>
type ToolResult = Extract<UIMessage, { type: 'tool_result' }>
type MemoryToolAction = 'saved' | 'referenced'

type MemoryToolFile = {
  path: string
  label: string
  action: MemoryToolAction
  lineHint?: string
  preview?: string
}

type MemoryToolActivity = {
  action: MemoryToolAction
  files: MemoryToolFile[]
}

export { toolCallDurationMs } from './activityGroupModel'

function imageGenerationItems(
  toolCalls: ToolCall[],
  resultMap: Map<string, ToolResult>,
): ImageGenerationItem[] {
  return toolCalls.map((toolCall) => {
    const result = resultMap.get(toolCall.toolUseId)
    return {
      id: toolCall.id,
      input: toolCall.input,
      result: result ? { content: result.content, isError: result.isError } : null,
      durationMs: toolCallDurationMs(toolCall, result),
    }
  })
}

function useExpandableCardState() {
  const [expanded, setExpanded] = useState(false)

  const toggleExpanded = useCallback(() => {
    setExpanded((value) => !value)
  }, [])

  return { expanded, toggleExpanded }
}

export type AgentActivityTarget = {
  sessionId: string
  toolUseId: string
  taskId?: string
}

/**
 * Maps a card's own ids onto the run that `/subagents/by-tool` can resolve.
 *
 * The session timeline addresses an Agent card with the session it is rendered
 * in; an agent run's own page renders the same cards but its tab id is
 * `subagent:*`, and a nested child has to be addressed through its parent's
 * tool ref. Without this hook the detail fetch would 404 for both.
 */
export type ResolveAgentActivityTarget = (input: AgentActivityTarget) => AgentActivityTarget | null

type Props = {
  sessionId?: string | null
  onOpenAgentRun?: (payload: OpenAgentRunPayload) => void
  resolveAgentActivityTarget?: ResolveAgentActivityTarget
  toolCalls: ToolCall[]
  /**
   * The run in transcript order, including any thinking blocks that happened
   * between the tool calls. Optional: callers that only have tool calls (and
   * every test predating the activity-group rollup) get an equivalent
   * tools-only run derived from `toolCalls`.
   */
  steps?: ActivityStep[]
  resultMap: Map<string, ToolResult>
  childToolCallsByParent: Map<string, ToolCall[]>
  agentTaskNotifications: Record<string, AgentTaskNotification>
  agentTaskStatuses?: Record<string, BackgroundAgentTask['status']>
  activeThinkingId?: string | null
  showOpenRun?: boolean
  /** When true, the last tool is still executing. */
  isStreaming?: boolean
  /** This run is the tail of a turn that is still producing into it. */
  isLive?: boolean
  /** Stable key that survives virtualized row unmount/remount. */
  disclosureKey?: string
}

export type OpenAgentRunPayload = {
  sessionId: string
  toolUseId: string
  title: string
}

export const ToolCallGroup = memo(function ToolCallGroup({
  sessionId,
  onOpenAgentRun,
  resolveAgentActivityTarget,
  toolCalls,
  steps,
  resultMap,
  childToolCallsByParent,
  agentTaskNotifications,
  agentTaskStatuses,
  activeThinkingId,
  showOpenRun = true,
  isStreaming,
  isLive = false,
  disclosureKey,
}: Props) {
  const resolvedSteps = useMemo(() => steps ?? toActivitySteps(toolCalls), [steps, toolCalls])
  const memoryActivity = getMemoryToolActivity(toolCalls, resultMap)
  if (memoryActivity) {
    const memoryToolCalls = toolCalls.filter(isMemoryToolCall)
    // Thinking stays with the remainder: the memory card is a summary of files
    // touched, not a place reasoning belongs.
    const regularSteps = resolvedSteps.filter(
      (step) => step.kind === 'thinking' || !isMemoryToolCall(step.toolCall),
    )
    return (
      <div className={regularSteps.length > 0 ? 'space-y-2' : ''}>
        <MemoryToolActivityGroup
          activity={memoryActivity}
          toolCalls={memoryToolCalls}
          resultMap={resultMap}
          childToolCallsByParent={childToolCallsByParent}
          isStreaming={isStreaming}
        />
        {regularSteps.length > 0 ? (
          <ToolCallGroupContent
            sessionId={sessionId}
            onOpenAgentRun={onOpenAgentRun}
            resolveAgentActivityTarget={resolveAgentActivityTarget}
            steps={regularSteps}
            resultMap={resultMap}
            childToolCallsByParent={childToolCallsByParent}
            agentTaskNotifications={agentTaskNotifications}
            agentTaskStatuses={agentTaskStatuses}
            activeThinkingId={activeThinkingId}
            showOpenRun={showOpenRun}
            isStreaming={isStreaming}
            disclosureKey={disclosureKey}
          />
        ) : null}
      </div>
    )
  }

  return (
    <ToolCallGroupContent
      sessionId={sessionId}
      onOpenAgentRun={onOpenAgentRun}
      resolveAgentActivityTarget={resolveAgentActivityTarget}
      steps={resolvedSteps}
      resultMap={resultMap}
      childToolCallsByParent={childToolCallsByParent}
      agentTaskNotifications={agentTaskNotifications}
      agentTaskStatuses={agentTaskStatuses}
      activeThinkingId={activeThinkingId}
      showOpenRun={showOpenRun}
      isStreaming={isStreaming}
      isLive={isLive}
      disclosureKey={disclosureKey}
    />
  )
})

type ContentProps = Omit<Props, 'toolCalls' | 'steps'> & { steps: ActivityStep[] }

function ToolCallGroupContent({
  sessionId,
  onOpenAgentRun,
  resolveAgentActivityTarget,
  steps,
  resultMap,
  childToolCallsByParent,
  agentTaskNotifications,
  agentTaskStatuses,
  activeThinkingId,
  showOpenRun = true,
  isStreaming,
  isLive = false,
  disclosureKey,
}: ContentProps) {
  const toolCalls = activityStepToolCalls(steps)
  const hasImageGeneration = toolCalls.some((toolCall) => isImageGenerationToolName(toolCall.toolName))
  const hasNonImageSteps = steps.some(
    (step) => step.kind === 'thinking' || !isImageGenerationToolName(step.toolCall.toolName),
  )
  if (hasImageGeneration && hasNonImageSteps) {
    const segments: Array<
      | { kind: 'images'; toolCalls: ToolCall[] }
      | { kind: 'regular'; steps: ActivityStep[] }
    > = []
    let regularSteps: ActivityStep[] = []
    let imageToolCalls: ToolCall[] = []
    const flushRegularSteps = () => {
      if (regularSteps.length === 0) return
      segments.push({ kind: 'regular', steps: regularSteps })
      regularSteps = []
    }
    const flushImageCalls = () => {
      if (imageToolCalls.length === 0) return
      segments.push({ kind: 'images', toolCalls: imageToolCalls })
      imageToolCalls = []
    }

    for (const step of steps) {
      if (step.kind === 'tool' && isImageGenerationToolName(step.toolCall.toolName)) {
        flushRegularSteps()
        imageToolCalls.push(step.toolCall)
      } else {
        flushImageCalls()
        regularSteps.push(step)
      }
    }
    flushRegularSteps()
    flushImageCalls()

    return (
      <div className="space-y-2">
        {segments.map((segment, index) => segment.kind === 'images' ? (
          <ImageGenerationGroup
            key={segment.toolCalls.map((toolCall) => toolCall.id).join(':')}
            items={imageGenerationItems(segment.toolCalls, resultMap)}
          />
        ) : (
          <ToolCallGroupContent
            key={`regular-${index}`}
            sessionId={sessionId}
            onOpenAgentRun={onOpenAgentRun}
            resolveAgentActivityTarget={resolveAgentActivityTarget}
            steps={segment.steps}
            resultMap={resultMap}
            childToolCallsByParent={childToolCallsByParent}
            agentTaskNotifications={agentTaskNotifications}
            agentTaskStatuses={agentTaskStatuses}
            activeThinkingId={activeThinkingId}
            showOpenRun={showOpenRun}
            isStreaming={isStreaming}
          />
        ))}
      </div>
    )
  }

  if (toolCalls.length === 0) {
    return (
      <>
        {steps.map((step) => step.kind === 'thinking' ? (
          <ThinkingBlock
            key={step.message.id}
            content={step.message.content}
            isActive={step.message.id === activeThinkingId}
          />
        ) : null)}
      </>
    )
  }

  const allAgents = toolCalls.length > 0 && toolCalls.every((toolCall) => toolCall.toolName === 'Agent')

  if (allAgents) {
    return (
      <AgentToolGroup
        sessionId={sessionId}
        onOpenAgentRun={onOpenAgentRun}
        resolveAgentActivityTarget={resolveAgentActivityTarget}
        toolCalls={toolCalls}
        resultMap={resultMap}
        childToolCallsByParent={childToolCallsByParent}
        agentTaskNotifications={agentTaskNotifications}
        agentTaskStatuses={agentTaskStatuses}
        showOpenRun={showOpenRun}
      />
    )
  }

  const allImageGeneration = toolCalls.length > 0 && toolCalls.every((toolCall) => isImageGenerationToolName(toolCall.toolName))
  if (allImageGeneration) {
    return (
      <ImageGenerationGroup items={imageGenerationItems(toolCalls, resultMap)} />
    )
  }

  return (
    <ActivityGroup
      steps={steps}
      resultMap={resultMap}
      childToolCallsByParent={childToolCallsByParent}
      activeThinkingId={activeThinkingId}
      isStreaming={isStreaming}
      isLive={isLive}
      disclosureKey={disclosureKey}
    />
  )
}

function MemoryToolActivityGroup({
  activity,
  toolCalls,
  resultMap,
  childToolCallsByParent,
  isStreaming,
}: {
  activity: MemoryToolActivity
  toolCalls: ToolCall[]
  resultMap: Map<string, ToolResult>
  childToolCallsByParent: Map<string, ToolCall[]>
  isStreaming?: boolean
}) {
  const { expanded, toggleExpanded } = useExpandableCardState()
  const [detailsExpanded, setDetailsExpanded] = useState(false)
  const t = useTranslation()
  const titleKey = activity.action === 'saved'
    ? 'chat.memorySavedFromToolsTitle'
    : 'chat.memoryReferencedTitle'
  const visibleFiles = activity.files.slice(0, 4)
  const hiddenCount = Math.max(0, activity.files.length - visibleFiles.length)

  return (
    <div>
      <div
        data-testid="memory-tool-activity-card"
        className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-memory-border)] bg-[var(--color-memory-surface)]"
      >
        <button
          type="button"
          data-chat-disclosure="true"
          aria-expanded={expanded}
          onClick={toggleExpanded}
          className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
        >
          {expanded ? (
            <ChevronDown size={15} className="shrink-0 text-[var(--color-text-tertiary)]" aria-hidden="true" />
          ) : (
            <ChevronRight size={15} className="shrink-0 text-[var(--color-text-tertiary)]" aria-hidden="true" />
          )}
          <BookMarked size={15} className="shrink-0 text-[var(--color-memory-accent)]" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--color-text-primary)]">
            {t(titleKey, { count: activity.files.length })}
          </span>
          {isStreaming ? (
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-memory-accent)] animate-pulse-dot" />
          ) : null}
        </button>

        {expanded ? (
          <div className="border-t border-[var(--color-border)] px-3 py-2.5">
            <div className="space-y-1.5">
              {visibleFiles.map((file) => (
                <button
                  key={file.path}
                  type="button"
                  title={file.path}
                  onClick={() => openMemorySettings(file.path)}
                  className="group flex w-full items-start gap-2 rounded-[var(--radius-md)] px-2 py-1.5 text-left transition-colors hover:bg-[var(--color-surface-hover)] focus:outline-none focus-visible:shadow-[var(--shadow-focus-ring)]"
                >
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-[var(--color-memory-border)] bg-[var(--color-memory-icon-bg)] text-[var(--color-text-tertiary)] group-hover:text-[var(--color-memory-accent)]">
                    <Settings size={12} aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="truncate text-[13px] font-medium text-[var(--color-text-primary)]">
                        {file.label}
                      </span>
                      {file.lineHint ? (
                        <span className="shrink-0 text-[12px] text-[var(--color-text-tertiary)]">
                          {file.lineHint}
                        </span>
                      ) : null}
                    </span>
                    {file.preview ? (
                      <span className="mt-0.5 line-clamp-2 text-[12px] leading-5 text-[var(--color-text-secondary)]">
                        {file.preview}
                      </span>
                    ) : null}
                  </span>
                </button>
              ))}
              {hiddenCount > 0 ? (
                <div className="px-2 py-1 text-[12px] text-[var(--color-text-tertiary)]">
                  {t('chat.memoryMoreFiles', { count: hiddenCount })}
                </div>
              ) : null}
            </div>

            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDetailsExpanded((value) => !value)}
              className="mt-2 border border-[var(--color-border)]"
              icon={detailsExpanded
                ? <ChevronDown size={13} aria-hidden="true" />
                : <ChevronRight size={13} aria-hidden="true" />}
            >
              {t('chat.memoryTechnicalDetails')}
            </Button>

            {detailsExpanded ? (
              <div className="mt-2 space-y-1">
                {toolCalls.map((toolCall) => (
                  <ToolCallTree
                    key={toolCall.id}
                    toolCall={toolCall}
                    resultMap={resultMap}
                    childToolCallsByParent={childToolCallsByParent}
                    compact
                  />
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function AgentToolGroup({
  sessionId,
  onOpenAgentRun,
  resolveAgentActivityTarget,
  toolCalls,
  resultMap,
  childToolCallsByParent,
  agentTaskNotifications,
  agentTaskStatuses,
  showOpenRun = true,
}: Props) {
  const { expanded, toggleExpanded } = useExpandableCardState()
  const t = useTranslation()
  const statuses = toolCalls.map((toolCall) =>
    getAgentStatus({
      hasResult: resultMap.has(toolCall.toolUseId),
      isError: !!resultMap.get(toolCall.toolUseId)?.isError,
      isLaunchResult: isAgentLaunchResult(resultMap.get(toolCall.toolUseId)?.content),
      childCount: (childToolCallsByParent.get(toolCall.toolUseId) ?? []).length,
      taskStatus: agentTaskNotifications[toolCall.toolUseId]?.status ?? agentTaskStatuses?.[toolCall.toolUseId],
    }),
  )
  const isAnyRunning = statuses.some((status) => status === 'running' || status === 'starting')
  const errorPresent = statuses.some((status) => status === 'failed')
  const allComplete = statuses.every((status) => status === 'done')
  const anyStopped = statuses.some((status) => status === 'stopped')

  return (
    <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)]">
      <button
        type="button"
        data-chat-disclosure="true"
        aria-expanded={expanded}
        onClick={toggleExpanded}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
      >
        <span className="shrink-0 text-[11px] leading-none text-[var(--color-text-tertiary)]" aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
        <span className="flex-1 truncate text-[14px] font-semibold text-[var(--color-text-primary)]">
          {toolCalls.length === 1 ? t('toolGroup.agentOne') : t('toolGroup.agentMany', { count: toolCalls.length })}
        </span>
        {isAnyRunning && (
          <Badge tone="warning" className="font-semibold">
            {t('agentStatus.running')}
          </Badge>
        )}
        {!isAnyRunning && errorPresent && (
          <span className="material-symbols-outlined shrink-0 text-[17px] text-[var(--color-error)]">error</span>
        )}
        {!isAnyRunning && !errorPresent && allComplete && (
          <CircleCheck size={19} strokeWidth={1.6} className="shrink-0 text-[var(--color-success)]" aria-hidden="true" />
        )}
        {!isAnyRunning && !errorPresent && !allComplete && !anyStopped && (
          <span className="material-symbols-outlined shrink-0 text-[17px] text-[var(--color-text-tertiary)]">pending</span>
        )}
        {!isAnyRunning && !errorPresent && !allComplete && anyStopped && (
          <span className="material-symbols-outlined shrink-0 text-[17px] text-[var(--color-text-tertiary)]">stop_circle</span>
        )}
      </button>

      {expanded && (
        <div className="px-3.5 pb-2.5 pt-0.5">
          <div className="ml-1.5 flex flex-col border-l border-[var(--color-border)] pl-4">
            {toolCalls.map((toolCall) => (
              <AgentCallCard
                key={toolCall.id}
                sessionId={sessionId}
                onOpenAgentRun={onOpenAgentRun}
                resolveAgentActivityTarget={resolveAgentActivityTarget}
                toolCall={toolCall}
                resultMap={resultMap}
                childToolCallsByParent={childToolCallsByParent}
                agentTaskNotification={agentTaskNotifications[toolCall.toolUseId]}
                agentTaskStatus={agentTaskStatuses?.[toolCall.toolUseId]}
                showOpenRun={showOpenRun}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function AgentCallCard({
  sessionId,
  onOpenAgentRun,
  resolveAgentActivityTarget,
  toolCall,
  resultMap,
  childToolCallsByParent,
  agentTaskNotification,
  agentTaskStatus,
  showOpenRun = true,
}: {
  sessionId?: string | null
  onOpenAgentRun?: (payload: OpenAgentRunPayload) => void
  resolveAgentActivityTarget?: ResolveAgentActivityTarget
  toolCall: ToolCall
  resultMap: Map<string, ToolResult>
  childToolCallsByParent: Map<string, ToolCall[]>
  agentTaskNotification?: AgentTaskNotification
  agentTaskStatus?: BackgroundAgentTask['status']
  showOpenRun?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const t = useTranslation()
  const input = toolCall.input && typeof toolCall.input === 'object'
    ? toolCall.input as Record<string, unknown>
    : {}
  const result = resultMap.get(toolCall.toolUseId)
  const childToolCalls = childToolCallsByParent.get(toolCall.toolUseId) ?? []
  const isLaunchResult = isAgentLaunchResult(result?.content)
  const recentToolCalls = childToolCalls.slice(-2)
  // The timeline no longer carries child tool messages, so a card that has none
  // reads the run from its own endpoint the moment it is expanded. Live cards
  // still stream children in, and those stay the source of truth.
  const activityTarget = useMemo(() => {
    if (!sessionId) return null
    const target = { sessionId, toolUseId: toolCall.toolUseId, taskId: agentTaskNotification?.taskId }
    return resolveAgentActivityTarget ? resolveAgentActivityTarget(target) : target
  }, [agentTaskNotification?.taskId, resolveAgentActivityTarget, sessionId, toolCall.toolUseId])
  const { state: activityState, retry: retryActivity } = useAgentRunActivity({
    enabled: expanded && childToolCalls.length === 0 && activityTarget !== null,
    sessionId: activityTarget?.sessionId,
    toolUseId: activityTarget?.toolUseId,
    taskId: activityTarget?.taskId,
  })
  const lazyActivity = activityState.status === 'ready' ? activityState.activity : null
  // The hook starts in `idle` and only flips to `loading` after paint; without
  // this the expanded panel would flash "No tool activity yet" for one frame.
  const showActivityLoading =
    expanded && childToolCalls.length === 0 && activityTarget !== null &&
    lazyActivity === null && activityState.status !== 'error'
  const status = getAgentStatus({
    hasResult: !!result,
    isError: !!result?.isError,
    isLaunchResult,
    childCount: childToolCalls.length || (lazyActivity?.toolCalls.length ?? 0),
    taskStatus: agentTaskNotification?.status ?? agentTaskStatus,
  })
  const statusTone = getAgentStatusTone(status)
  const statusLabel = getAgentStatusLabel(status, t)
  const taskSummary = agentTaskNotification?.summary?.trim() || ''
  const taskResult = agentTaskNotification?.result?.trim() || ''
  const errorText =
    status === 'failed'
      ? taskSummary || (result?.isError ? getAgentErrorSummary(result.content) : '')
      : result?.isError
        ? getAgentErrorSummary(result.content)
        : ''
  const fullOutputText =
    result && !result.isError && !isLaunchResult && !isAgentLifecycleResult(result.content)
      ? extractAgentDisplayText(result.content).trim()
      : ''
  const terminalTaskReport = status === 'done' || status === 'stopped' ? taskResult : ''
  const terminalTaskSummary = status === 'done' || status === 'stopped' ? taskSummary : ''
  const previewText = terminalTaskReport || fullOutputText || terminalTaskSummary
  const outputSummary = previewText ? getAgentOutputSummary(previewText) : ''
  const description = typeof input.description === 'string' ? input.description : ''
  const openRunTitle = description.trim() || 'Agent'
  const canOpenRun = showOpenRun && !!sessionId && !!toolCall.toolUseId

  return (
    <div data-agent-call-layout="row">
      <div className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-[var(--radius-md)] px-2 py-1.5 text-left transition-colors hover:bg-[var(--color-surface-hover)]">
        <span className="material-symbols-outlined text-[18px] text-[var(--color-outline)]">smart_toy</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold text-[var(--color-text-primary)]">Agent</span>
            {description && (
              <span className="truncate text-[12px] text-[var(--color-text-secondary)]">
                {description}
              </span>
            )}
          </div>
          {!expanded && outputSummary && (
            <div className="mt-1 line-clamp-2 text-[11px] text-[var(--color-text-tertiary)]">
              {outputSummary}
            </div>
          )}
          {!expanded && !outputSummary && recentToolCalls.length > 0 && (
            <div className="mt-1 space-y-1">
              {recentToolCalls.map((recentToolCall) => (
                <div
                  key={recentToolCall.id}
                  className="truncate text-[11px] text-[var(--color-text-tertiary)]"
                >
                  {formatRecentToolUseSummary(recentToolCall, resultMap)}
                </div>
              ))}
            </div>
          )}
          {!expanded && !outputSummary && !recentToolCalls.length && errorText && (
            <div className="mt-1 truncate text-[11px] text-[var(--color-error)]">
              {errorText}
            </div>
          )}
        </div>
        {outputSummary && (
          <Button
            variant="ghost"
            size="sm"
            onClick={(event) => {
              event.stopPropagation()
              setPreviewOpen(true)
            }}
            className="shrink-0 border border-[var(--color-border)]"
          >
            {t('agentStatus.viewResult')}
          </Button>
        )}
        {canOpenRun && (
          <Button
            variant="ghost"
            size="sm"
            aria-label={t('toolGroup.openRunNamed', { title: openRunTitle })}
            onClick={(event) => {
              event.stopPropagation()
              if (onOpenAgentRun) {
                onOpenAgentRun({
                  sessionId,
                  toolUseId: toolCall.toolUseId,
                  title: openRunTitle,
                })
                return
              }
              useTabStore.getState().openSubagentTab(sessionId, toolCall.toolUseId, openRunTitle)
            }}
            className="shrink-0 border border-[var(--color-border)]"
          >
            {t('toolGroup.openRun')}
          </Button>
        )}
        <Badge tone={statusTone} className="font-semibold">
          {statusLabel}
        </Badge>
        <IconButton
          size="sm"
          shape="circle"
          tone="muted"
          onClick={() => setExpanded((value) => !value)}
          label={t(expanded ? 'toolGroup.collapseAgent' : 'toolGroup.expandAgent')}
          showTooltip={false}
          icon={(
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
              {expanded ? 'expand_less' : 'expand_more'}
            </span>
          )}
        />
      </div>

      {expanded && (
        <div className="mb-2 ml-2 mt-1 border-l border-[var(--color-border)] py-1 pl-3">
          {errorText && (
            <div className="mb-2 bg-[var(--color-error-soft)] px-3 py-2 text-[11px] text-[var(--color-error)]">
              {errorText}
            </div>
          )}
          {childToolCalls.length > 0 ? (
            <div className="space-y-0.5">
              {childToolCalls.map((childToolCall) => (
                <ToolCallTree
                  key={childToolCall.id}
                  toolCall={childToolCall}
                  resultMap={resultMap}
                  childToolCallsByParent={childToolCallsByParent}
                  compact
                  chrome="row"
                />
              ))}
            </div>
          ) : showActivityLoading ? (
            <div
              data-testid="agent-call-activity-loading"
              className="px-2 py-1 text-[11px] text-[var(--color-text-tertiary)]"
            >
              {t('agentActivity.loading')}
            </div>
          ) : activityState.status === 'error' ? (
            <div
              data-testid="agent-call-activity-error"
              className="flex items-center gap-2 px-2 py-1 text-[11px] text-[var(--color-text-tertiary)]"
            >
              <span>{t('agentActivity.failed')}</span>
              <Button variant="ghost" size="sm" onClick={retryActivity}>
                {t('agentActivity.retry')}
              </Button>
            </div>
          ) : lazyActivity && lazyActivity.toolCalls.length > 0 ? (
            <div className="space-y-0.5" data-testid="agent-call-activity">
              {lazyActivity.toolCalls.map((childToolCall) => (
                <ToolCallTree
                  key={childToolCall.id}
                  toolCall={childToolCall}
                  resultMap={lazyActivity.resultMap}
                  childToolCallsByParent={lazyActivity.childToolCallsByParent}
                  compact
                  chrome="row"
                />
              ))}
              {lazyActivity.truncated && (
                <div className="px-2 py-1 text-[11px] text-[var(--color-text-tertiary)]">
                  {t('agentActivity.truncated')}
                </div>
              )}
            </div>
          ) : outputSummary ? (
            <div className="px-2 py-1 text-[11px] text-[var(--color-text-tertiary)]">
              {t('agentStatus.noActivity')}
            </div>
          ) : (
            <div className="px-2 py-1 text-[11px] text-[var(--color-text-tertiary)]">
              {status === 'starting' ? t('agentStatus.starting') : t('agentStatus.noActivity')}
            </div>
          )}
        </div>
      )}
      <Modal
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        title={description || t('agentStatus.resultTitle')}
        width={900}
      >
        <div className="max-h-[70vh] overflow-y-auto">
          <MarkdownRenderer content={previewText || errorText} />
        </div>
      </Modal>
    </div>
  )
}

function ToolCallTree({
  toolCall,
  resultMap,
  childToolCallsByParent,
  compact = false,
  chrome = 'card',
}: {
  toolCall: ToolCall
  resultMap: Map<string, ToolResult>
  childToolCallsByParent: Map<string, ToolCall[]>
  compact?: boolean
  chrome?: ToolCallChrome
}) {
  const result = resultMap.get(toolCall.toolUseId)
  const childToolCalls = childToolCallsByParent.get(toolCall.toolUseId) ?? []
  const isRow = chrome === 'row'

  return (
    <div className={!isRow && compact ? 'space-y-1' : ''}>
      <ToolCallBlock
        toolName={toolCall.toolName}
        input={toolCall.input}
        result={result ? { content: result.content, isError: result.isError } : null}
        compact={compact}
        chrome={chrome}
        isPending={toolCall.isPending}
        status={toolCall.status}
        partialInput={toolCall.partialInput}
        durationMs={toolCallDurationMs(toolCall, result)}
      />
      {childToolCalls.length > 0 && (
        <div className={
          isRow
            ? 'ml-2 border-l border-[var(--color-border)] pl-3'
            : compact
              ? 'ml-4 border-l border-[var(--color-border)] pl-3'
              : 'mb-2 ml-16 border-l border-[var(--color-border)] pl-3'
        }>
          <div className={isRow ? 'space-y-0.5' : 'space-y-1'}>
            {childToolCalls.map((childToolCall) => (
              <ToolCallTree
                key={childToolCall.id}
                toolCall={childToolCall}
                resultMap={resultMap}
                childToolCallsByParent={childToolCallsByParent}
                compact
                chrome={chrome}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function openMemorySettings(path?: string) {
  const ui = useUIStore.getState()
  if (path) ui.setPendingMemoryPath(path)
  ui.setPendingSettingsTab('memory')
  useTabStore.getState().openTab(SETTINGS_TAB_ID, 'Settings', 'settings')
}

function getMemoryToolActivity(
  toolCalls: ToolCall[],
  resultMap: Map<string, ToolResult>,
): MemoryToolActivity | null {
  const filesByPath = new Map<string, MemoryToolFile>()
  let sawSave = false

  for (const toolCall of toolCalls) {
    if (toolCall.isPending) continue
    const path = getToolFilePath(toolCall.input)
    if (!path || !isMemoryMarkdownPath(path)) continue

    const isSave = isMemoryWriteTool(toolCall.toolName)
    const isReference = toolCall.toolName === 'Read'
    if (!isSave && !isReference) continue
    sawSave ||= isSave

    const result = resultMap.get(toolCall.toolUseId)
    const preview = extractMemoryPreview(result?.content)
    const current = filesByPath.get(path)
    filesByPath.set(path, {
      path,
      label: memoryFileLabel(path),
      action: isSave ? 'saved' : (current?.action ?? 'referenced'),
      lineHint: preview.lineHint || current?.lineHint,
      preview: preview.text || current?.preview,
    })
  }

  if (filesByPath.size === 0) return null
  return {
    action: sawSave ? 'saved' : 'referenced',
    files: [...filesByPath.values()],
  }
}

function isMemoryToolCall(toolCall: ToolCall): boolean {
  if (toolCall.isPending) return false
  const path = getToolFilePath(toolCall.input)
  if (!path || !isMemoryMarkdownPath(path)) return false
  return toolCall.toolName === 'Read' || isMemoryWriteTool(toolCall.toolName)
}

function isMemoryWriteTool(toolName: string): boolean {
  return toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit'
}

function getToolFilePath(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  const filePath = record.file_path ?? record.path
  return typeof filePath === 'string' ? filePath : null
}

function isMemoryMarkdownPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/')
  return normalized.endsWith('.md') && normalized.includes('/memory/')
}

function memoryFileLabel(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  return normalized.split('/').pop() || normalized
}

function extractMemoryPreview(content: unknown): { text?: string; lineHint?: string } {
  const raw = extractTextContent(content)
  if (!raw) return {}
  const lineHint = extractLineHint(raw)
  const lines = raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\d+\s*/, '').trim())
    .filter(Boolean)

  let inFrontmatter = false
  for (const line of lines) {
    if (line === '---') {
      inFrontmatter = !inFrontmatter
      continue
    }
    if (inFrontmatter) continue
    const normalized = line.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '').trim()
    if (!normalized || normalized === '---') continue
    if (/^(file|lines?|total)\b/i.test(normalized)) continue
    return {
      text: normalized.length > 140 ? `${normalized.slice(0, 140)}...` : normalized,
      lineHint,
    }
  }
  return { lineHint }
}

function extractLineHint(text: string): string | undefined {
  const match = text.match(/(\d+)\s+lines?\b/i) ?? text.match(/(\d+)\s+行/)
  return match?.[1] ? `${match[1]} lines` : undefined
}

type AgentStatus = 'starting' | 'running' | 'done' | 'failed' | 'stopped'
type AgentTaskStatus = AgentTaskNotification['status'] | BackgroundAgentTask['status']

function getAgentStatus({
  hasResult,
  isError,
  isLaunchResult,
  childCount,
  taskStatus,
}: {
  hasResult: boolean
  isError: boolean
  isLaunchResult: boolean
  childCount: number
  taskStatus?: AgentTaskStatus
}): AgentStatus {
  if (taskStatus === 'failed') return 'failed'
  if (taskStatus === 'stopped') return 'stopped'
  if (taskStatus === 'completed') return 'done'
  if (taskStatus === 'running') return 'running'
  if (hasResult && isError && !isLaunchResult) return 'failed'
  if (hasResult && !isLaunchResult) return 'done'
  if (childCount > 0 || isLaunchResult) return 'running'
  return 'starting'
}

function getAgentStatusLabel(
  status: AgentStatus,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string {
  switch (status) {
    case 'failed':
      return t('agentStatus.failed')
    case 'stopped':
      return t('agentStatus.stopped')
    case 'done':
      return t('agentStatus.done')
    case 'running':
      return t('agentStatus.running')
    case 'starting':
    default:
      return t('agentStatus.starting')
  }
}

function getAgentStatusTone(status: AgentStatus): Tone {
  switch (status) {
    case 'failed':
      return 'danger'
    case 'done':
      return 'success'
    case 'running':
      return 'warning'
    case 'stopped':
    case 'starting':
    default:
      return 'neutral'
  }
}

function formatRecentToolUseSummary(
  toolCall: ToolCall,
  resultMap: Map<string, ToolResult>,
): string {
  const input = toolCall.input && typeof toolCall.input === 'object'
    ? toolCall.input as Record<string, unknown>
    : {}
  const result = resultMap.get(toolCall.toolUseId)
  const suffix = result?.isError ? ' • failed' : result ? ' • done' : ' • running'

  switch (toolCall.toolName) {
    case 'Bash':
      return `Bash · ${typeof input.command === 'string' ? input.command : ''}${suffix}`
    case 'Read':
      return `Read · ${typeof input.file_path === 'string' ? input.file_path.split('/').pop() : 'file'}${suffix}`
    case 'Glob':
      return `Glob · ${typeof input.pattern === 'string' ? input.pattern : ''}${suffix}`
    case 'Grep':
      return `Grep · ${typeof input.pattern === 'string' ? input.pattern : ''}${suffix}`
    case 'Agent':
      return `Agent · ${typeof input.description === 'string' ? input.description : ''}${suffix}`
    default:
      return `${toolCall.toolName}${suffix}`
  }
}

function getAgentErrorSummary(content: unknown): string {
  const text = extractTextContent(content).replace(/\s+/g, ' ').trim()
  if (!text) return ''
  if (text.includes(`Agent type 'Explore' not found`)) {
    return 'Explore agent unavailable in this session'
  }
  return text.length > 120 ? `${text.slice(0, 120)}...` : text
}

function getAgentOutputSummary(content: string): string {
  const text = content.replace(/\s+\n/g, '\n').trim()
  if (!text) return ''
  return text.length > 220 ? `${text.slice(0, 220)}...` : text
}

function extractAgentDisplayText(content: unknown): string {
  return stripAgentResultMetadata(formatAgentStructuredResult(content) || extractTextContent(content))
}

function formatAgentStructuredResult(content: unknown): string {
  const structured = parseStructuredAgentContent(content)
  if (!structured || Array.isArray(structured)) return ''

  const results = structured.results
  if (!Array.isArray(results) || results.length === 0) return ''

  const items = results
    .map((result, index) => formatAgentStructuredResultItem(result, index))
    .filter(Boolean)

  return items.join('\n')
}

function parseStructuredAgentContent(content: unknown): Record<string, unknown> | unknown[] | null {
  if (typeof content === 'string') {
    return parseStructuredAgentText(content)
  }

  if (Array.isArray(content)) {
    return parseStructuredAgentText(extractTextContent(content))
  }

  if (content && typeof content === 'object') {
    if ('results' in content) return content as Record<string, unknown>

    const extracted = extractTextContent(content)
    return extracted ? parseStructuredAgentText(extracted) : null
  }

  return null
}

function parseStructuredAgentText(text: string): Record<string, unknown> | unknown[] | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
  try {
    const parsed = JSON.parse(trimmed) as unknown
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> | unknown[] : null
  } catch {
    return null
  }
}

function formatAgentStructuredResultItem(result: unknown, index: number): string {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    const text = extractTextContent(result).trim()
    return text ? `${index + 1}. ${text}` : ''
  }

  const record = result as Record<string, unknown>
  const location = formatAgentResultLocation(record)
  const context = getStringField(record, 'context')
  const snippet = getStringField(record, 'snippet')
  const message = getStringField(record, 'message') || getStringField(record, 'text') || getStringField(record, 'summary')
  const nestedItems = Array.isArray(record.items) ? record.items : []

  if (nestedItems.length > 0) {
    const label = getStringField(record, 'risk') || getStringField(record, 'title') || message || 'Grouped results'
    const lines = [`${index + 1}. ${formatAgentGroupLabel(label)}`]
    if (context) lines.push(`   - ${context}`)
    if (snippet) lines.push(`   - ${snippet}`)

    nestedItems
      .map(formatAgentStructuredNestedItem)
      .filter(Boolean)
      .forEach((item) => {
        lines.push(
          item
            .split('\n')
            .map((line, lineIndex) => `${lineIndex === 0 ? '   - ' : '     '}${line}`)
            .join('\n'),
        )
      })

    return lines.join('\n')
  }

  const lines = [`${index + 1}. ${location ? formatInlineCode(location) : 'Result'}`]

  if (message) lines.push(`   - ${message}`)
  if (context) lines.push(`   - ${context}`)
  if (snippet) lines.push(`   - ${snippet}`)

  return lines.join('\n')
}

function formatAgentStructuredNestedItem(item: unknown): string {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return extractTextContent(item).trim()
  }

  const record = item as Record<string, unknown>
  const location = formatAgentResultLocation(record)
  const context = getStringField(record, 'context')
  const snippet = getStringField(record, 'snippet')
  const message = getStringField(record, 'message') || getStringField(record, 'text') || getStringField(record, 'summary')
  const headingParts = [location ? formatInlineCode(location) : '', message].filter(Boolean)
  const lines = [headingParts.join(' - ') || 'Result']

  if (context) lines.push(context)
  if (snippet) lines.push(snippet)

  return lines.join('\n')
}

function formatAgentGroupLabel(label: string): string {
  const normalized = label.trim()
  if (!normalized) return 'Grouped results'
  return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`
}

function formatAgentResultLocation(record: Record<string, unknown>): string {
  const file = getStringField(record, 'file')
  if (!file) return ''
  const line = typeof record.line === 'number' ? record.line : null
  return line !== null ? `${file}:${line}` : file
}

function getStringField(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value.trim() : ''
}

function formatInlineCode(value: string): string {
  return `\`${value.replace(/`/g, '\\`')}\``
}

function stripAgentResultMetadata(text: string): string {
  return text
    .replace(/^\s*agentId:.*(?:\r?\n)?/gm, '')
    .replace(/<usage>[\s\S]*?<\/usage>/g, '')
    .replace(/^\s*(?:total_tokens|tool_uses|duration_ms):\s*\d+\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function isAgentLaunchResult(content: unknown): boolean {
  const text = extractTextContent(content).trim()
  if (!text) return false

  return (
    text.startsWith('Async agent launched successfully.') ||
    text.startsWith('Remote agent launched in CCR.') ||
    (text.startsWith('Spawned successfully.') &&
      text.includes('The agent is now running and will receive instructions via mailbox.')) ||
    text.includes('The agent is working in the background. You will be notified automatically when it completes.') ||
    text.includes('The agent is running remotely. You will be notified automatically when it completes.')
  )
}

/**
 * Check if agent result content is a lifecycle notification (shutdown, terminated, etc.)
 * rather than actual agent output. These should not be shown to the user as results.
 */
function isAgentLifecycleResult(content: unknown): boolean {
  const text = extractTextContent(content).trim()
  if (!text) return false
  // Detect JSON lifecycle messages: shutdown_approved, shutdown_rejected, teammate_terminated
  if (text.startsWith('{') && text.endsWith('}')) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>
      if (typeof parsed.type === 'string' && AGENT_LIFECYCLE_TYPES.has(parsed.type)) {
        return true
      }
    } catch {
      // Not valid JSON, not a lifecycle message
    }
  }
  return false
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((chunk) => {
        if (typeof chunk === 'string') return chunk
        if (chunk && typeof chunk === 'object' && 'text' in chunk) {
          return typeof chunk.text === 'string' ? chunk.text : ''
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (content && typeof content === 'object') {
    if (
      'status' in content &&
      (content as Record<string, unknown>).status === 'completed' &&
      Array.isArray((content as Record<string, unknown>).content)
    ) {
      return extractTextContent((content as Record<string, unknown>).content)
    }
    }
  if (content && typeof content === 'object') {
    return JSON.stringify(content)
  }
  return ''
}
