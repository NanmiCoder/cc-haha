import { memo, useMemo, useState } from 'react'
import {
  Check,
  ChevronRight,
  CircleAlert,
  CircleStop,
  CircleX,
  Eye,
  Globe,
  Hand,
  LoaderCircle,
  TriangleAlert,
  X,
} from 'lucide-react'
import type { BrowserTakeoverState, BrowserUseActivityEvent } from '@/api/browserUse'
import { BrowserUseEnableDialog } from '@/components/browser-use/BrowserUseEnableDialog'
import { Badge, StatusDot } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { useTranslation } from '@/i18n'
import { getDesktopHost } from '@/lib/desktopHost'
import { getDisclosure, setDisclosure } from '@/lib/disclosureMemory'
import { extractToolResultImages } from '@/lib/toolResultContent'
import { useBrowserUseStore } from '@/stores/browserUseStore'
import { useUIStore } from '@/stores/uiStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import type { UIMessage } from '@/types/chat'
import type { ActivityStep, ToolErrorSeverity } from './activityGroupModel'
import { ThinkingBlock } from './ThinkingBlock'
import { describeBrowserToolCall, formatTakeoverReason } from './toolCallPresentation'

type ToolCall = Extract<UIMessage, { type: 'tool_use' }>
type ToolResult = Extract<UIMessage, { type: 'tool_result' }>

const EMPTY_ACTIVITIES: BrowserUseActivityEvent[] = []
const DISABLED_ERROR_RE = /browser[_\s-]?use[_\s-]?disabled|browser use is (?:not enabled|disabled)/i

function extractResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block
        if (block && typeof block === 'object' && 'text' in block && typeof (block as { text?: unknown }).text === 'string') {
          return (block as { text: string }).text
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (content && typeof content === 'object') {
    try {
      return JSON.stringify(content)
    } catch {
      return ''
    }
  }
  return ''
}

function extractScreenshotFromResults(
  toolCalls: ToolCall[],
  resultMap: Map<string, ToolResult>,
  liveActivities: BrowserUseActivityEvent[],
): string | null {
  for (let i = liveActivities.length - 1; i >= 0; i--) {
    const src = liveActivities[i]?.screenshotDataUrl
    if (src) return src
  }
  for (let i = toolCalls.length - 1; i >= 0; i--) {
    const result = resultMap.get(toolCalls[i]!.toolUseId)
    if (!result) continue
    const extracted = extractToolResultImages(result.content)
    const lastImage = extracted.images.at(-1)
    if (lastImage) {
      return `data:${lastImage.mediaType};base64,${lastImage.data}`
    }
    const text = extractResultText(result.content)
    const dataUrlMatch = /data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+/.exec(text)
    if (dataUrlMatch) return dataUrlMatch[0]
  }
  return null
}

function focusWorkspaceBrowserTab(sessionId: string | null | undefined, tabId?: string) {
  const workspaceStore = useWorkspaceStore.getState()
  if (tabId) {
    const owner = workspaceStore.findBrowserTabOwner(tabId)
    if (owner) {
      workspaceStore.activateTab(owner.sessionId, owner.tabId)
      if (workspaceStore.getSession(owner.sessionId).layout === 'hidden') {
        workspaceStore.setLayout(owner.sessionId, 'split')
      }
      return
    }
  }
  if (!sessionId) return
  const sessionWorkspace = workspaceStore.getSession(sessionId)
  const browserTab = sessionWorkspace.tabs.find((tab) => tab.kind === 'browser')
  if (browserTab) {
    workspaceStore.activateTab(sessionId, browserTab.id)
    if (sessionWorkspace.layout === 'hidden') {
      workspaceStore.setLayout(sessionId, 'split')
    }
  }
}

function isBlockingBrowserError(
  toolUseId: string,
  result: ToolResult | undefined,
  errorSeverityByToolUseId?: ReadonlyMap<string, ToolErrorSeverity>,
): boolean {
  if (!result?.isError) return false
  if (!errorSeverityByToolUseId) return true
  return errorSeverityByToolUseId.get(toolUseId) !== 'recovered'
}

export type BrowserActivityCardProps = {
  sessionId?: string | null
  toolCalls: ToolCall[]
  /**
   * Chronological activity steps (browser tool calls plus any interleaved
   * thinking blocks in the same browser run). Falls back to `toolCalls` when omitted.
   */
  steps?: ActivityStep[]
  resultMap: Map<string, ToolResult>
  errorSeverityByToolUseId?: ReadonlyMap<string, ToolErrorSeverity>
  activeThinkingId?: string | null
  isStreaming?: boolean
  /** True while this card is the tail of an active turn (bridges thinking gaps between tool calls). */
  isLive?: boolean
  disclosureKey?: string
  presentation?: 'inline' | 'sheet'
}

/**
 * Collapsible Codex-style calm work row for Browser Use tool runs.
 * Stays calm and flicker-free across multi-step browser turns: keeps a single
 * stable action button (`View` for Workspace Browser; `Take over` only for
 * live System Chrome runs) and never swaps buttons or headers between steps.
 */
export const BrowserActivityCard = memo(function BrowserActivityCard({
  sessionId,
  toolCalls,
  steps: activitySteps,
  resultMap,
  errorSeverityByToolUseId,
  activeThinkingId,
  isStreaming = false,
  isLive = false,
  disclosureKey,
  presentation = 'inline',
}: BrowserActivityCardProps) {
  const t = useTranslation()
  const [localDisclosure, setLocalDisclosure] = useState({ expanded: false, rev: 0 })
  const expanded = disclosureKey
    ? (getDisclosure(disclosureKey) ?? localDisclosure.expanded)
    : localDisclosure.expanded
  const toggleExpanded = () => {
    const next = !expanded
    if (disclosureKey) setDisclosure(disclosureKey, next)
    setLocalDisclosure((current) => ({ expanded: next, rev: current.rev + 1 }))
  }
  const [previewOpen, setPreviewOpen] = useState(false)
  const isDesktop = getDesktopHost().isDesktop

  const liveActivities = useBrowserUseStore((state) =>
    sessionId ? state.activitiesBySession[sessionId] ?? EMPTY_ACTIVITIES : EMPTY_ACTIVITIES,
  )
  const activeTakeover = useBrowserUseStore((state) =>
    sessionId ? state.takeoverBySession[sessionId] ?? null : null,
  )
  const browserUseConfig = useBrowserUseStore((state) => state.config)

  const hasActiveThinking = Boolean(activeThinkingId) && Boolean(
    activitySteps?.some((step) => step.kind === 'thinking' && step.message.id === activeThinkingId),
  )
  const hasUnresolved = toolCalls.some((tc) => !resultMap.has(tc.toolUseId) && tc.status !== 'stopped')
  const showsProgress = (hasUnresolved && (Boolean(isLive) || Boolean(isStreaming))) || hasActiveThinking
  const lastToolCall = toolCalls.at(-1)
  const lastResult = lastToolCall ? resultMap.get(lastToolCall.toolUseId) : undefined
  const hasDisabledError = toolCalls.some((tc) => {
    const result = resultMap.get(tc.toolUseId)
    if (!result?.isError) return false
    return DISABLED_ERROR_RE.test(extractResultText(result.content))
  })
  const allStopped = !showsProgress && !lastResult?.isError && toolCalls.some((tc) => !resultMap.has(tc.toolUseId))
  // Bridge brief LLM thinking gaps between consecutive Browser* tool calls in
  // the same live turn so the header, icon, and controls never flicker on/off.
  const isActive = showsProgress || (Boolean(isLive) && !allStopped && !hasDisabledError)
  // Only surface a terminal red error when the run has settled and its final
  // step failed (or Browser Use is disabled) — intermediate self-recovered
  // errors stay visible inside the expanded timeline without flashing red.
  const hasTerminalError = !isActive && (
    Boolean(lastToolCall && isBlockingBrowserError(lastToolCall.toolUseId, lastResult, errorSeverityByToolUseId)) ||
    hasDisabledError
  )

  const { steps, timelineEntries } = useMemo(() => {
    type ActionEntry = {
      kind: 'action'
      id: string
      label: string
      status: 'running' | 'done' | 'error' | 'recovered' | 'stopped'
    }
    type TimelineEntry =
      | ActionEntry
      | {
          kind: 'thinking'
          id: string
          content: string
          isActive: boolean
        }

    const actionList: ActionEntry[] = []
    const entryList: TimelineEntry[] = []
    const sourceSteps: ActivityStep[] = activitySteps ?? toolCalls.map((toolCall) => ({ kind: 'tool', toolCall }))

    for (const sourceStep of sourceSteps) {
      if (sourceStep.kind === 'thinking') {
        entryList.push({
          kind: 'thinking',
          id: `thinking:${sourceStep.message.id}`,
          content: sourceStep.message.content,
          isActive: sourceStep.message.id === activeThinkingId,
        })
        continue
      }
      const toolCall = sourceStep.toolCall
      const result = resultMap.get(toolCall.toolUseId)
      const status: ActionEntry['status'] = result
        ? result.isError
          ? isBlockingBrowserError(toolCall.toolUseId, result, errorSeverityByToolUseId)
            ? 'error'
            : 'recovered'
          : 'done'
        : toolCall.status === 'stopped' || !showsProgress
          ? 'stopped'
          : 'running'
      const described = describeBrowserToolCall(toolCall.toolName, toolCall.input, t)
      for (const entry of described) {
        const actionEntry: ActionEntry = {
          kind: 'action',
          id: `${toolCall.id}:${entry.id}`,
          label: entry.label,
          status,
        }
        actionList.push(actionEntry)
        entryList.push(actionEntry)
      }
    }
    return { steps: actionList, timelineEntries: entryList }
  }, [activeThinkingId, activitySteps, errorSeverityByToolUseId, resultMap, showsProgress, t, toolCalls])

  // Only consult session-level liveActivities while THIS card is actively live
  // so completed historical cards never bleed screenshots from a later turn.
  const latestScreenshot = useMemo(
    () => extractScreenshotFromResults(toolCalls, resultMap, isActive ? liveActivities : EMPTY_ACTIVITIES),
    [isActive, liveActivities, resultMap, toolCalls],
  )

  const latestActivity = isActive ? liveActivities.at(-1) : undefined
  const activeTabId = latestActivity?.tabId ?? (isActive ? activeTakeover?.tabId : undefined)
  const targetKind = latestActivity?.target ?? (isActive ? activeTakeover?.target : undefined) ?? 'workspace'
  const headerLabel = isActive && steps.length > 0
    ? steps[steps.length - 1]!.label
    : t(steps.length === 1 ? 'browserUse.chat.summaryOne' : 'browserUse.chat.summaryMany', {
        count: steps.length,
      })

  const handleView = () => {
    if (!isDesktop) return
    focusWorkspaceBrowserTab(sessionId, activeTabId)
  }

  const handleTakeover = () => {
    if (!isDesktop || !activeTabId) return
    void getDesktopHost().browserUse.sendUserAction({
      tabId: activeTabId,
      action: 'takeover',
      reason: 'user_requested',
    }).catch(() => {})
  }

  return (
    <div className="space-y-2" data-testid="browser-activity-group">
      {hasDisabledError && !browserUseConfig?.enabled ? (
        <BrowserUseEnableCard />
      ) : null}

      <div
        data-testid="browser-activity-card"
        data-expanded={expanded ? 'true' : 'false'}
        data-running={isActive ? 'true' : 'false'}
        data-presentation={presentation}
      >
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-chat-disclosure="true"
            aria-expanded={expanded}
            onClick={toggleExpanded}
            className={`codex-work-row group/browser inline-flex max-w-full items-center gap-1.5 rounded-[var(--radius-sm)] py-0.5 text-left text-[13px] text-[var(--color-text-tertiary)] transition-colors hover:text-[var(--color-text-primary)] focus:outline-none focus-visible:shadow-[var(--shadow-focus-ring)] ${
              presentation === 'sheet' ? 'min-h-11' : 'min-h-6'
            }`}
          >
            <span aria-hidden="true" className="flex h-4 w-4 shrink-0 items-center justify-center">
              {isActive ? (
                <LoaderCircle size={13} strokeWidth={1.75} className="animate-spin text-[var(--color-text-tertiary)]" />
              ) : hasTerminalError ? (
                <CircleX size={13} strokeWidth={1.75} className="text-[var(--color-error)]" />
              ) : allStopped ? (
                <CircleStop size={13} strokeWidth={1.75} />
              ) : (
                <Globe size={13} strokeWidth={1.75} />
              )}
            </span>
            <span
              className={`min-w-0 truncate ${
                isActive
                  ? 'codex-shimmer-text font-medium'
                  : 'text-[var(--color-text-tertiary)] transition-colors group-hover/browser:text-[var(--color-text-primary)]'
              }`}
            >
              {headerLabel}
            </span>
            <Badge tone={targetKind === 'chrome' ? 'info' : 'neutral'} size="xs" pill={false}>
              {targetKind === 'chrome'
                ? t('settings.browserUse.targetChrome')
                : t('settings.browserUse.targetWorkspace')}
            </Badge>
            <ChevronRight
              size={14}
              strokeWidth={1.75}
              aria-hidden="true"
              className={`shrink-0 opacity-60 transition-transform duration-150 motion-reduce:transition-none group-hover/browser:opacity-100 ${expanded ? 'rotate-90' : ''}`}
            />
          </button>

          {isDesktop && (targetKind === 'workspace' || (targetKind === 'chrome' && isActive && activeTabId)) ? (
            <div className="flex shrink-0 items-center gap-1">
              {targetKind === 'workspace' ? (
                <Button
                  variant="ghost"
                  size="xs"
                  icon={<Eye size={12} strokeWidth={1.75} aria-hidden="true" />}
                  onClick={handleView}
                >
                  {t('browserUse.chat.view')}
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  size="xs"
                  icon={<Hand size={12} strokeWidth={1.75} aria-hidden="true" />}
                  onClick={handleTakeover}
                >
                  {t('browserUse.overlay.takeover')}
                </Button>
              )}
            </div>
          ) : null}
        </div>

        {/* Compact screenshot preview thumbnail */}
        {latestScreenshot ? (
          <div className="mt-1.5">
            <button
              type="button"
              onClick={() => setPreviewOpen(true)}
              aria-label={t('browserUse.chat.previewScreenshot')}
              className="group relative block overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
            >
              <img
                src={latestScreenshot}
                alt={t('browserUse.chat.screenshotAlt')}
                className="max-h-36 w-auto object-contain"
              />
            </button>
          </div>
        ) : null}

        {/* Expanded step timeline */}
        {expanded ? (
          <ul
            data-testid="browser-activity-steps"
            className="mt-1 divide-y divide-[var(--color-border)] rounded-[var(--radius-card-inner)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-3 py-1"
          >
            {timelineEntries.map((entry) => entry.kind === 'thinking' ? (
              <li key={entry.id} className="py-1">
                <ThinkingBlock content={entry.content} isActive={entry.isActive} />
              </li>
            ) : (
              <li key={entry.id} className="flex items-center gap-2 py-1.5 text-xs">
                {entry.status === 'running' ? (
                  <LoaderCircle size={12} strokeWidth={1.75} aria-hidden="true" className="shrink-0 animate-spin text-[var(--color-info)]" />
                ) : entry.status === 'error' ? (
                  <CircleAlert size={12} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-error)]" />
                ) : entry.status === 'stopped' ? (
                  <CircleStop size={12} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
                ) : entry.status === 'recovered' ? (
                  <CircleAlert size={12} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
                ) : (
                  <Check size={12} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
                )}
                <span className="min-w-0 flex-1 truncate text-[var(--color-text-secondary)]">
                  {entry.label}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {latestScreenshot ? (
        <Modal
          open={previewOpen}
          onClose={() => setPreviewOpen(false)}
          title={t('browserUse.chat.screenshotAlt')}
          width={920}
        >
          <div className="flex justify-center p-2">
            <img
              src={latestScreenshot}
              alt={t('browserUse.chat.screenshotAlt')}
              className="max-h-[70vh] w-auto rounded-[var(--radius-md)] border border-[var(--color-border)] object-contain"
            />
          </div>
        </Modal>
      ) : null}
    </div>
  )
})

/**
 * Non-collapsible inline Takeover Card synced with the right-side browser pill.
 */
export function BrowserTakeoverCard({
  sessionId,
  takeover,
}: {
  sessionId: string
  takeover: BrowserTakeoverState
}) {
  const t = useTranslation()
  const isDesktop = getDesktopHost().isDesktop
  const [submitting, setSubmitting] = useState<'resume' | 'abort' | null>(null)

  const handleResume = async () => {
    setSubmitting('resume')
    if (sessionId) {
      await useBrowserUseStore.getState().resumeTakeover(sessionId, takeover.takeoverId)
    } else if (isDesktop && takeover.tabId) {
      await getDesktopHost().browserUse.sendUserAction({
        tabId: takeover.tabId,
        action: 'resume',
      }).catch(() => {})
    }
    setSubmitting(null)
  }

  const handleAbort = async () => {
    setSubmitting('abort')
    if (sessionId) {
      await useBrowserUseStore.getState().abortTakeover(sessionId, takeover.takeoverId, 'user_cancelled')
    } else if (isDesktop && takeover.tabId) {
      await getDesktopHost().browserUse.sendUserAction({
        tabId: takeover.tabId,
        action: 'cancel',
      }).catch(() => {})
    }
    setSubmitting(null)
  }

  const displayReason = formatTakeoverReason(takeover.reason, takeover.message, t)

  return (
    <div
      role="alert"
      data-testid="browser-takeover-card"
      className="v6c-glass-card v6c-ring-waiting overflow-hidden rounded-[var(--radius-lg)] p-3.5 backdrop-blur-[var(--glass-blur)]"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-[var(--color-warning-container)] text-[var(--color-on-warning-container)]">
          <TriangleAlert size={16} strokeWidth={1.75} aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <StatusDot tone="warning" size="sm" pulse />
            <span className="text-[13px] font-semibold text-[var(--color-text-primary)]">
              {t('browserUse.takeoverCard.title')}
            </span>
          </div>
          <p className="text-xs leading-[1.5] text-[var(--color-text-secondary)]">
            {displayReason}
          </p>
          {takeover.url ? (
            <p className="truncate font-mono text-[11px] text-[var(--color-text-tertiary)]">{takeover.url}</p>
          ) : null}
        </div>
      </div>

      {isDesktop ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {takeover.target === 'workspace' ? (
            <Button
              variant="secondary"
              size="sm"
              icon={<Eye size={13} strokeWidth={1.75} aria-hidden="true" />}
              onClick={() => focusWorkspaceBrowserTab(sessionId, takeover.tabId)}
            >
              {t('browserUse.chat.view')}
            </Button>
          ) : null}
          <Button
            variant="primary"
            size="sm"
            loading={submitting === 'resume'}
            disabled={submitting !== null}
            icon={<Check size={13} strokeWidth={1.75} aria-hidden="true" />}
            onClick={() => { void handleResume() }}
          >
            {t('browserUse.overlay.resume')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            loading={submitting === 'abort'}
            disabled={submitting !== null}
            icon={<X size={13} strokeWidth={1.75} aria-hidden="true" />}
            onClick={() => { void handleAbort() }}
          >
            {t('browserUse.overlay.cancel')}
          </Button>
        </div>
      ) : (
        <p className="mt-2.5 text-xs text-[var(--color-text-secondary)]">
          {t('browserUse.takeoverCard.desktopOnlyHint')}
        </p>
      )}
    </div>
  )
}

/**
 * Renders the single session-level pending BrowserTakeoverCard at the tail of
 * the active transcript so subagent-triggered takeovers are visible and
 * historical BrowserActivityCards never duplicate the prompt.
 */
export function SessionBrowserTakeoverBanner({ sessionId }: { sessionId: string | null | undefined }) {
  const takeover = useBrowserUseStore((state) => (sessionId ? state.takeoverBySession[sessionId] ?? null : null))
  if (!sessionId || !takeover || takeover.status !== 'pending') return null
  return (
    <div className="mb-4">
      <BrowserTakeoverCard sessionId={sessionId} takeover={takeover} />
    </div>
  )
}

/**
 * Inline 1-click Enable Card shown when Browser Use is currently disabled.
 */
export function BrowserUseEnableCard() {
  const t = useTranslation()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [saving, setSaving] = useState(false)

  const handleConfirm = async () => {
    setSaving(true)
    const saved = await useBrowserUseStore.getState().updateConfig({
      enabled: true,
      consentAcceptedAt: new Date().toISOString(),
    })
    setSaving(false)
    if (saved) {
      setDialogOpen(false)
      useUIStore.getState().addToast({
        type: 'success',
        message: t('browserUse.enableCard.enabledToast'),
      })
    } else {
      useUIStore.getState().addToast({
        type: 'error',
        message: t('settings.browserUse.configSaveFailed'),
      })
    }
  }

  return (
    <>
      <div
        data-testid="browser-use-enable-card"
        className="v6c-glass-card flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] p-3.5"
      >
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          <Globe size={16} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--color-info)]" />
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-[var(--color-text-primary)]">
              {t('browserUse.enableCard.title')}
            </div>
            <p className="mt-0.5 text-xs leading-[1.5] text-[var(--color-text-secondary)]">
              {t('browserUse.enableCard.description')}
            </p>
          </div>
        </div>
        <Button
          variant="primary"
          size="sm"
          onClick={() => setDialogOpen(true)}
        >
          {t('browserUse.enableCard.action')}
        </Button>
      </div>
      <BrowserUseEnableDialog
        open={dialogOpen}
        loading={saving}
        onClose={() => setDialogOpen(false)}
        onConfirm={handleConfirm}
      />
    </>
  )
}
