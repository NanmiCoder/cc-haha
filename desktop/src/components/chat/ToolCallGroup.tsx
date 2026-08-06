import { memo, useCallback, useState } from 'react'
import { BookMarked, ChevronDown, ChevronRight, CircleCheck, Settings } from 'lucide-react'
import { ToolCallBlock } from './ToolCallBlock'
import { ImageGenerationGroup, type ImageGenerationItem } from './ImageGenerationBlock'
import { isImageGenerationToolName } from './imageGenerationTools'
import { MarkdownRenderer } from '../markdown/MarkdownRenderer'
import { Badge, StatusDot, type Tone } from '@/components/ui/Badge'
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

type Props = {
  sessionId?: string | null
  toolCalls: ToolCall[]
  resultMap: Map<string, ToolResult>
  childToolCallsByParent: Map<string, ToolCall[]>
  agentTaskNotifications: Record<string, AgentTaskNotification>
  agentTaskStatuses?: Record<string, BackgroundAgentTask['status']>
  showOpenRun?: boolean
  /** When true, the last tool is still executing. */
  isStreaming?: boolean
}

const TOOL_VERBS: Record<string, (count: number, t: (key: TranslationKey, params?: Record<string, string | number>) => string) => string> = {
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

function generateSummary(toolCalls: ToolCall[], t: (key: TranslationKey, params?: Record<string, string | number>) => string): string {
  const counts = new Map<string, number>()
  for (const tc of toolCalls) {
    counts.set(tc.toolName, (counts.get(tc.toolName) ?? 0) + 1)
  }

  const parts: string[] = []
  for (const [name, count] of counts) {
    const verbFn = TOOL_VERBS[name]
    parts.push(verbFn ? verbFn(count, t) : `${name} (${count})`)
  }

  return parts.join(', ')
}

function toolCallHasError(
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

function groupHasErrors(
  toolCalls: ToolCall[],
  resultMap: Map<string, ToolResult>,
  childToolCallsByParent: Map<string, ToolCall[]>,
): boolean {
  return toolCalls.some((tc) => {
    return toolCallHasError(tc, resultMap, childToolCallsByParent)
  })
}

function isToolCallResolved(
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

function hasUnresolvedToolCalls(
  toolCalls: ToolCall[],
  resultMap: Map<string, ToolResult>,
  childToolCallsByParent: Map<string, ToolCall[]>,
): boolean {
  return toolCalls.some((toolCall) =>
    !isToolCallResolved(toolCall, resultMap, childToolCallsByParent),
  )
}

export const ToolCallGroup = memo(function ToolCallGroup({
  sessionId,
  toolCalls,
  resultMap,
  childToolCallsByParent,
  agentTaskNotifications,
  agentTaskStatuses,
  showOpenRun = true,
  isStreaming,
}: Props) {
  const memoryActivity = getMemoryToolActivity(toolCalls, resultMap)
  if (memoryActivity) {
    const memoryToolCalls = toolCalls.filter(isMemoryToolCall)
    const regularToolCalls = toolCalls.filter((toolCall) => !isMemoryToolCall(toolCall))
    return (
      <div className={regularToolCalls.length > 0 ? 'mb-2 space-y-2' : ''}>
        <MemoryToolActivityGroup
          activity={memoryActivity}
          toolCalls={memoryToolCalls}
          resultMap={resultMap}
          childToolCallsByParent={childToolCallsByParent}
          isStreaming={isStreaming}
        />
        {regularToolCalls.length > 0 ? (
          <ToolCallGroupContent
            sessionId={sessionId}
            toolCalls={regularToolCalls}
            resultMap={resultMap}
            childToolCallsByParent={childToolCallsByParent}
            agentTaskNotifications={agentTaskNotifications}
            agentTaskStatuses={agentTaskStatuses}
            showOpenRun={showOpenRun}
            isStreaming={isStreaming}
          />
        ) : null}
      </div>
    )
  }

  return (
    <ToolCallGroupContent
      sessionId={sessionId}
      toolCalls={toolCalls}
      resultMap={resultMap}
      childToolCallsByParent={childToolCallsByParent}
      agentTaskNotifications={agentTaskNotifications}
      agentTaskStatuses={agentTaskStatuses}
      showOpenRun={showOpenRun}
      isStreaming={isStreaming}
    />
  )
})

function ToolCallGroupContent({
  sessionId,
  toolCalls,
  resultMap,
  childToolCallsByParent,
  agentTaskNotifications,
  agentTaskStatuses,
  showOpenRun = true,
  isStreaming,
}: Props) {
  const hasImageGeneration = toolCalls.some((toolCall) => isImageGenerationToolName(toolCall.toolName))
  if (hasImageGeneration && !toolCalls.every((toolCall) => isImageGenerationToolName(toolCall.toolName))) {
    const segments: Array<
      | { kind: 'images'; toolCalls: ToolCall[] }
      | { kind: 'regular'; toolCalls: ToolCall[] }
    > = []
    let regularToolCalls: ToolCall[] = []
    let imageToolCalls: ToolCall[] = []
    const flushRegularCalls = () => {
      if (regularToolCalls.length === 0) return
      segments.push({ kind: 'regular', toolCalls: regularToolCalls })
      regularToolCalls = []
    }
    const flushImageCalls = () => {
      if (imageToolCalls.length === 0) return
      segments.push({ kind: 'images', toolCalls: imageToolCalls })
      imageToolCalls = []
    }

    for (const toolCall of toolCalls) {
      if (isImageGenerationToolName(toolCall.toolName)) {
        flushRegularCalls()
        imageToolCalls.push(toolCall)
      } else {
        flushImageCalls()
        regularToolCalls.push(toolCall)
      }
    }
    flushRegularCalls()
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
            toolCalls={segment.toolCalls}
            resultMap={resultMap}
            childToolCallsByParent={childToolCallsByParent}
            agentTaskNotifications={agentTaskNotifications}
            agentTaskStatuses={agentTaskStatuses}
            showOpenRun={showOpenRun}
            isStreaming={isStreaming}
          />
        ))}
      </div>
    )
  }

  const allAgents = toolCalls.every((toolCall) => toolCall.toolName === 'Agent')

  if (allAgents) {
    return (
      <AgentToolGroup
        sessionId={sessionId}
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

  // Single tool call — render directly without group wrapper
  if (toolCalls.length === 1) {
    const tc = toolCalls[0]!
    return (
      <ToolCallTree
        toolCall={tc}
        resultMap={resultMap}
        childToolCallsByParent={childToolCallsByParent}
      />
    )
  }

  return (
    <ToolCallGroupMulti
      toolCalls={toolCalls}
      resultMap={resultMap}
      childToolCallsByParent={childToolCallsByParent}
      agentTaskNotifications={agentTaskNotifications}
      isStreaming={isStreaming}
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
    <div className="mb-2">
      <div
        data-testid="memory-tool-activity-card"
        className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-memory-border)] bg-[var(--color-memory-surface)]"
      >
        <button
          type="button"
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
    <div className="mb-2 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)]">
      <button
        type="button"
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
        <div className="relative border-t border-[var(--color-border)] py-3 pl-5 pr-3.5">
          <div className="absolute bottom-6 left-[11px] top-4 w-px rounded-full bg-[var(--color-border)]" />
          <div className="space-y-2">
            {toolCalls.map((toolCall) => (
              <div key={toolCall.id} className="relative pl-7">
                <div className="absolute left-0 top-1/2 -translate-y-1/2">
                  <div className="absolute left-[11px] top-1/2 h-px w-4 -translate-y-1/2 bg-[var(--color-border)]" />
                  <div className="absolute left-[8px] top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] shadow-[0_0_0_2px_var(--color-surface)]" />
                </div>
                <AgentCallCard
                  sessionId={sessionId}
                  toolCall={toolCall}
                  resultMap={resultMap}
                  childToolCallsByParent={childToolCallsByParent}
                  agentTaskNotification={agentTaskNotifications[toolCall.toolUseId]}
                  agentTaskStatus={agentTaskStatuses?.[toolCall.toolUseId]}
                  showOpenRun={showOpenRun}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/** Separated so the useState hook is never called conditionally. */
function ToolCallGroupMulti({ toolCalls, resultMap, childToolCallsByParent, isStreaming }: Props) {
  const { expanded, toggleExpanded } = useExpandableCardState()
  const t = useTranslation()
  const summary = generateSummary(toolCalls, t)
  const errorPresent = groupHasErrors(toolCalls, resultMap, childToolCallsByParent)
  const hasUnresolvedTools = hasUnresolvedToolCalls(toolCalls, resultMap, childToolCallsByParent)
  const isRunning = !!isStreaming || hasUnresolvedTools

  return (
    <div className="mb-2 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)]">
      <button
        type="button"
        onClick={toggleExpanded}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
      >
        <span className="shrink-0 text-[11px] leading-none text-[var(--color-text-tertiary)]" aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
        <span className="flex-1 truncate text-[14px] font-semibold text-[var(--color-text-primary)]">
          {summary}
        </span>
        {!isRunning && !errorPresent && (
          <CircleCheck size={19} strokeWidth={1.6} className="shrink-0 text-[var(--color-success)]" aria-hidden="true" />
        )}
        {!isRunning && errorPresent && (
          <span className="material-symbols-outlined shrink-0 text-[17px] text-[var(--color-error)]">error</span>
        )}
        {isRunning && <StatusDot tone="brand" pulse />}
      </button>

      {expanded && (
        <div className="flex flex-col gap-2.5 border-t border-[var(--color-border)] px-3.5 py-2.5">
          {toolCalls.map((tc) => {
            return (
              <ToolCallTree
                key={tc.id}
                toolCall={tc}
                resultMap={resultMap}
                childToolCallsByParent={childToolCallsByParent}
                compact
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

function AgentCallCard({
  sessionId,
  toolCall,
  resultMap,
  childToolCallsByParent,
  agentTaskNotification,
  agentTaskStatus,
  showOpenRun = true,
}: {
  sessionId?: string | null
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
  const status = getAgentStatus({
    hasResult: !!result,
    isError: !!result?.isError,
    isLaunchResult,
    childCount: childToolCalls.length,
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
    <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)]">
      <div className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--color-surface-hover)]">
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
        <div className="border-t border-[var(--color-border)] px-3 py-3">
          {errorText && (
            <div className="mb-3 rounded-[var(--radius-lg)] border border-[var(--color-error)] bg-[var(--color-error-container)] px-3 py-2 text-[11px] text-[var(--color-on-error-container)]">
              {errorText}
            </div>
          )}
          {childToolCalls.length > 0 ? (
            <div className="space-y-1">
              {childToolCalls.map((childToolCall) => (
                <ToolCallTree
                  key={childToolCall.id}
                  toolCall={childToolCall}
                  resultMap={resultMap}
                  childToolCallsByParent={childToolCallsByParent}
                  compact
                />
              ))}
            </div>
          ) : outputSummary ? (
            <div className="text-[11px] text-[var(--color-text-tertiary)]">
              {t('agentStatus.noActivity')}
            </div>
          ) : (
            <div className="text-[11px] text-[var(--color-text-tertiary)]">
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
}: {
  toolCall: ToolCall
  resultMap: Map<string, ToolResult>
  childToolCallsByParent: Map<string, ToolCall[]>
  compact?: boolean
}) {
  const result = resultMap.get(toolCall.toolUseId)
  const childToolCalls = childToolCallsByParent.get(toolCall.toolUseId) ?? []

  return (
    <div className={compact ? 'space-y-1' : ''}>
      <ToolCallBlock
        toolName={toolCall.toolName}
        input={toolCall.input}
        result={result ? { content: result.content, isError: result.isError } : null}
        compact={compact}
        isPending={toolCall.isPending}
        status={toolCall.status}
        partialInput={toolCall.partialInput}
        durationMs={toolCallDurationMs(toolCall, result)}
      />
      {childToolCalls.length > 0 && (
        <div className={compact ? 'ml-4 border-l border-[var(--color-border)] pl-3' : 'mb-2 ml-16 border-l border-[var(--color-border)] pl-3'}>
          <div className="space-y-1">
            {childToolCalls.map((childToolCall) => (
              <ToolCallTree
                key={childToolCall.id}
                toolCall={childToolCall}
                resultMap={resultMap}
                childToolCallsByParent={childToolCallsByParent}
                compact
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
