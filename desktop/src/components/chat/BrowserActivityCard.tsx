import { memo, useMemo, useState } from 'react'
import {
  Check,
  ChevronRight,
  CircleAlert,
  CircleCheck,
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
import { extractToolResultImages } from '@/lib/toolResultContent'
import { useBrowserUseStore } from '@/stores/browserUseStore'
import { useUIStore } from '@/stores/uiStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import type { UIMessage } from '@/types/chat'
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

export type BrowserActivityCardProps = {
  sessionId?: string | null
  toolCalls: ToolCall[]
  resultMap: Map<string, ToolResult>
  isStreaming?: boolean
}

/**
 * Collapsible Codex-style activity card for Browser Use tool runs.
 * Shows human-readable steps (with password fields masked), latest screenshot
 * thumbnail, and desktop/H5-aware controls (`View`, `Takeover`, `Stop`).
 */
export const BrowserActivityCard = memo(function BrowserActivityCard({
  sessionId,
  toolCalls,
  resultMap,
  isStreaming = false,
}: BrowserActivityCardProps) {
  const t = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const isDesktop = getDesktopHost().isDesktop

  const liveActivities = useBrowserUseStore((state) =>
    sessionId ? state.activitiesBySession[sessionId] ?? EMPTY_ACTIVITIES : EMPTY_ACTIVITIES,
  )
  const activeTakeover = useBrowserUseStore((state) =>
    sessionId ? state.takeoverBySession[sessionId] ?? null : null,
  )
  const browserUseConfig = useBrowserUseStore((state) => state.config)

  const steps = useMemo(() => {
    const list: Array<{
      id: string
      label: string
      status: 'running' | 'done' | 'error' | 'stopped'
    }> = []
    for (const toolCall of toolCalls) {
      const result = resultMap.get(toolCall.toolUseId)
      const status: 'running' | 'done' | 'error' | 'stopped' = result
        ? result.isError
          ? 'error'
          : 'done'
        : toolCall.status === 'stopped'
          ? 'stopped'
          : 'running'
      const described = describeBrowserToolCall(toolCall.toolName, toolCall.input, t)
      for (const entry of described) {
        list.push({
          id: `${toolCall.id}:${entry.id}`,
          label: entry.label,
          status,
        })
      }
    }
    return list
  }, [resultMap, t, toolCalls])

  const hasUnresolved = toolCalls.some((tc) => !resultMap.has(tc.toolUseId) && tc.status !== 'stopped')
  const isRunning = hasUnresolved || (isStreaming && toolCalls.some((tc) => tc.status !== 'stopped' && !resultMap.has(tc.toolUseId)))
  const hasError = toolCalls.some((tc) => resultMap.get(tc.toolUseId)?.isError)
  const allStopped = !hasUnresolved && !hasError && toolCalls.some((tc) => !resultMap.has(tc.toolUseId) && tc.status === 'stopped')
  const hasDisabledError = toolCalls.some((tc) => {
    const result = resultMap.get(tc.toolUseId)
    if (!result?.isError) return false
    return DISABLED_ERROR_RE.test(extractResultText(result.content))
  })

  // Only consult session-level liveActivities while THIS card is actively running
  // so completed historical cards never bleed screenshots from a later turn.
  const latestScreenshot = useMemo(
    () => extractScreenshotFromResults(toolCalls, resultMap, isRunning ? liveActivities : EMPTY_ACTIVITIES),
    [isRunning, liveActivities, resultMap, toolCalls],
  )

  const latestActivity = isRunning ? liveActivities.at(-1) : undefined
  const activeTabId = latestActivity?.tabId ?? (isRunning ? activeTakeover?.tabId : undefined)
  const targetKind = latestActivity?.target ?? (isRunning ? activeTakeover?.target : undefined) ?? 'workspace'
  const headerLabel = isRunning && steps.length > 0
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
        className={expanded
          ? 'overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container)]'
          : 'overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)]'}
      >
        <div className="flex items-center gap-2 px-3 py-2">
          <button
            type="button"
            data-chat-disclosure="true"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
            className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
          >
            <span aria-hidden="true" className="flex h-5 w-5 shrink-0 items-center justify-center text-[var(--color-info)]">
              {isRunning ? (
                <LoaderCircle size={14} strokeWidth={1.75} className="animate-spin" />
              ) : hasError ? (
                <CircleX size={14} strokeWidth={1.75} className="text-[var(--color-error)]" />
              ) : allStopped ? (
                <CircleStop size={14} strokeWidth={1.75} className="text-[var(--color-text-tertiary)]" />
              ) : (
                <Globe size={14} strokeWidth={1.75} />
              )}
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--color-text-primary)]">
              {headerLabel}
            </span>
            <Badge tone={targetKind === 'chrome' ? 'info' : 'neutral'} size="xs">
              {targetKind === 'chrome'
                ? t('settings.browserUse.targetChrome')
                : t('settings.browserUse.targetWorkspace')}
            </Badge>
            <ChevronRight
              size={14}
              strokeWidth={1.75}
              aria-hidden="true"
              className={`shrink-0 text-[var(--color-text-tertiary)] transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
            />
          </button>

          <div className="flex shrink-0 items-center gap-1">
            {isDesktop && targetKind === 'workspace' ? (
              <Button
                variant="ghost"
                size="xs"
                icon={<Eye size={12} strokeWidth={1.75} aria-hidden="true" />}
                onClick={handleView}
              >
                {t('browserUse.chat.view')}
              </Button>
            ) : null}
            {isDesktop && isRunning && activeTabId ? (
              <Button
                variant="secondary"
                size="xs"
                icon={<Hand size={12} strokeWidth={1.75} aria-hidden="true" />}
                onClick={handleTakeover}
              >
                {t('browserUse.overlay.takeover')}
              </Button>
            ) : null}
          </div>
        </div>

        {/* Compact screenshot preview thumbnail */}
        {latestScreenshot ? (
          <div className="border-t border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
            <button
              type="button"
              onClick={() => setPreviewOpen(true)}
              aria-label={t('browserUse.chat.previewScreenshot')}
              className="group relative block overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
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
            className="divide-y divide-[var(--color-border)] border-t border-[var(--color-border)] px-3 py-1"
          >
            {steps.map((step) => (
              <li key={step.id} className="flex items-center gap-2 py-1.5 text-xs">
                {step.status === 'running' ? (
                  <LoaderCircle size={12} strokeWidth={1.75} aria-hidden="true" className="shrink-0 animate-spin text-[var(--color-info)]" />
                ) : step.status === 'error' ? (
                  <CircleAlert size={12} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-error)]" />
                ) : step.status === 'stopped' ? (
                  <CircleStop size={12} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
                ) : (
                  <CircleCheck size={12} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-success)]" />
                )}
                <span className="min-w-0 flex-1 truncate text-[var(--color-text-secondary)]">
                  {step.label}
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
      className="rounded-[var(--radius-lg)] border border-[var(--color-warning)] bg-[var(--color-warning-container)] p-3.5 text-[var(--color-on-warning-container)]"
    >
      <div className="flex items-start gap-2.5">
        <TriangleAlert size={16} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <StatusDot tone="warning" size="sm" pulse />
            <span className="text-[13px] font-semibold">
              {t('browserUse.takeoverCard.title')}
            </span>
          </div>
          <p className="text-xs leading-[1.5]">
            {displayReason}
          </p>
          {takeover.url ? (
            <p className="truncate font-mono text-[11px] opacity-80">{takeover.url}</p>
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
        <p className="mt-2.5 text-xs opacity-85">
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
        className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container)] p-3.5"
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
