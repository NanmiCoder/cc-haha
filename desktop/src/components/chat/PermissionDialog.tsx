import { useState } from 'react'
import {
  Check,
  ChevronDown,
  ChevronUp,
  Folder,
  ListChecks,
  Search,
  Shield,
} from 'lucide-react'
import { getPendingPermission, useChatStore } from '../../stores/chatStore'
import { useTabStore } from '../../stores/tabStore'
import { useSessionRuntimeStore } from '../../stores/sessionRuntimeStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useProviderStore } from '../../stores/providerStore'
import { useTranslation } from '../../i18n'
import { Badge, StatusDot } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { ModelSelector } from '../controls/ModelSelector'
import { resolveDefaultRuntimeSelection } from '../../lib/runtimeSelection'
import type { RuntimeSelection } from '../../types/runtime'
import type { PermissionUpdate } from '../../types/chat'
import { DiffViewer } from './DiffViewer'
import { PERMISSION_TOOL_ICONS, extractToolDetails, getPermissionTitle } from './permissionPresentation'
import { PendingDecisionMarker } from './PendingDecisionMarker'
import {
  PlanPreviewCard,
  buildPlanApprovalPermissionUpdates,
  buildPromptPermissionUpdates,
  extractPlanPreview,
  isExitPlanModeTool,
  type PlanApprovalMode,
} from './PlanModePreview'

type Props = {
  sessionId?: string | null
  requestId: string
  toolName: string
  input: unknown
  description?: string
  displayName?: string
  /**
   * While the request waits, draw one marker line instead of the card. The
   * phone answers it from the approval bar in the composer's place.
   */
  markerWhenPending?: boolean
}

/** Card shell shared by the permission and plan-approval cards (「素」). */
const PENDING_CARD =
  'mb-4 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-outline)] bg-[var(--color-surface-container-lowest)] shadow-[var(--shadow-raised)]'

/** A request that has been answered collapses to one quiet line. */
const RESOLVED_ROW =
  'mb-4 flex min-h-9 min-w-0 items-center gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] py-1.5 pl-3 pr-2 text-[13px] text-[var(--color-text-secondary)]'

/** Sunken inset for commands, paths and raw input inside the card. */
const INSET_BLOCK =
  'rounded-[var(--radius-md)] bg-[var(--color-surface-container)] px-3 py-2.5 font-mono text-xs leading-[1.6] text-[var(--color-text-primary)]'

function renderPermissionPreview(toolName: string, input: unknown) {
  const obj = (input && typeof input === 'object') ? input as Record<string, unknown> : {}
  const filePath = typeof obj.file_path === 'string' ? obj.file_path : 'file'

  if (toolName === 'Edit' && typeof obj.old_string === 'string' && typeof obj.new_string === 'string') {
    return <DiffViewer filePath={filePath} oldString={obj.old_string} newString={obj.new_string} />
  }

  if (toolName === 'Write' && typeof obj.content === 'string') {
    return <DiffViewer filePath={filePath} oldString="" newString={obj.content} />
  }

  if (toolName === 'Bash' && typeof obj.command === 'string') {
    return (
      <div className={`overflow-x-auto ${INSET_BLOCK}`}>
        <pre className="whitespace-pre-wrap break-words font-mono">
          <span className="select-none text-[var(--color-brand)]">$ </span>{obj.command}
        </pre>
      </div>
    )
  }

  return null
}

export function PermissionDialog({ sessionId, requestId, toolName, input, description, displayName, markerWhenPending = false }: Props) {
  const { respondToPermission } = useChatStore()
  const activeTabId = useTabStore((s) => s.activeTabId)
  const targetSessionId = sessionId ?? activeTabId
  const pendingPermission = useChatStore((s) => targetSessionId
    ? getPendingPermission(s.sessions[targetSessionId], requestId)
    : undefined)
  const t = useTranslation()
  const isPending = Boolean(pendingPermission)
  const [showRaw, setShowRaw] = useState(false)

  if (isExitPlanModeTool(toolName)) {
    return (
      <ExitPlanModePermissionDialog
        sessionId={targetSessionId}
        requestId={requestId}
        input={input}
        description={description}
        isPending={isPending}
        markerWhenPending={markerWhenPending}
      />
    )
  }

  const ToolIcon = PERMISSION_TOOL_ICONS[toolName] ?? Shield
  const details = extractToolDetails(toolName, input, t)
  const rawInput = typeof input === 'string' ? input : JSON.stringify(input, null, 2)
  const preview = renderPermissionPreview(toolName, input)
  const title = getPermissionTitle(toolName, input, t, displayName)
  const allowRawToggle = !preview
  const permissionContext = (details.primary || description || toolName).slice(0, 160)

  if (isPending && markerWhenPending) {
    return <PendingDecisionMarker title={title} />
  }

  if (!isPending) {
    return (
      <div role="group" aria-label={`${title}: ${permissionContext}`} className={RESOLVED_ROW}>
        <ToolIcon aria-hidden="true" size={14} strokeWidth={1.75} className="shrink-0 text-[var(--color-text-tertiary)]" />
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {details.primary ? (
          <span className="hidden min-w-0 max-w-[45%] truncate font-mono text-xs text-[var(--color-text-tertiary)] sm:block" title={details.primary}>
            {details.primary}
          </span>
        ) : null}
        <Badge icon={<Check aria-hidden="true" size={12} strokeWidth={2} />}>
          {t('permission.responded')}
        </Badge>
      </div>
    )
  }

  return (
    <div
      role="group"
      aria-label={`${title}: ${permissionContext}`}
      className={PENDING_CARD}
    >
      {/* Header: icon block, title over context, "awaiting" pill. */}
      <div className="flex items-start gap-3 px-4 pb-3 pt-3.5">
        <div className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-warning-container)] text-[var(--color-on-warning-container)]">
          <ToolIcon aria-hidden="true" size={16} strokeWidth={1.75} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold leading-[1.4] text-[var(--color-text-primary)]">
            {title}
          </div>
          {description && (
            <p className="mt-0.5 truncate text-xs text-[var(--color-text-tertiary)]">{description}</p>
          )}
        </div>
        <Badge
          tone="warning"
          icon={<StatusDot tone="warning" pulse />}
          className="shrink-0"
        >
          {t('permission.awaitingApproval')}
        </Badge>
      </div>

      {/* Tool details */}
      <div className="px-4">
        {preview ? (
          <div className="space-y-2">
            {details.primary && toolName !== 'Bash' ? (
              <div className="flex items-center gap-2 rounded-[var(--radius-md)] bg-[var(--color-surface-container)] px-3 py-2 font-mono text-xs text-[var(--color-text-secondary)]">
                <Folder aria-hidden="true" size={14} strokeWidth={1.75} className="shrink-0 text-[var(--color-text-tertiary)]" />
                <span className="truncate">{details.primary}</span>
              </div>
            ) : null}
            {preview}
          </div>
        ) : details.primary ? (
          <div className="flex items-center gap-2 rounded-[var(--radius-md)] bg-[var(--color-surface-container)] px-3 py-2 font-mono text-xs text-[var(--color-text-secondary)]">
            {toolName === 'Glob' || toolName === 'Grep'
              ? <Search aria-hidden="true" size={14} strokeWidth={1.75} className="shrink-0 text-[var(--color-text-tertiary)]" />
              : <Folder aria-hidden="true" size={14} strokeWidth={1.75} className="shrink-0 text-[var(--color-text-tertiary)]" />}
            <span className="truncate">{details.primary}</span>
          </div>
        ) : null}

        {/* Secondary detail */}
        {details.secondary && (
          <p className="mt-2 text-xs text-[var(--color-text-tertiary)]">{details.secondary}</p>
        )}

        {allowRawToggle && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowRaw(!showRaw)}
            className="-ml-2 mt-1.5"
            icon={showRaw
              ? <ChevronUp aria-hidden="true" size={14} strokeWidth={1.75} />
              : <ChevronDown aria-hidden="true" size={14} strokeWidth={1.75} />}
          >
            {showRaw ? t('permission.hideDetails') : t('permission.showFullInput')}
          </Button>
        )}

        {allowRawToggle && showRaw && (
          <pre className={`mt-1.5 max-h-[220px] overflow-auto whitespace-pre-wrap break-words ${INSET_BLOCK}`}>
            {rawInput}
          </pre>
        )}
      </div>

      {/* Actions: confirm on the left, the quiet way out on the right. */}
      <div className="flex flex-wrap items-center gap-2 px-4 pb-3.5 pt-3">
        <Button
          variant="primary"
          size="base"
          aria-label={`${t('permission.allow')}: ${permissionContext}`}
          onClick={() => targetSessionId && respondToPermission(targetSessionId, requestId, true)}
        >
          {t('permission.allow')}
        </Button>
        <Button
          variant="secondary"
          size="base"
          aria-label={`${t('permission.allowForSession')}: ${permissionContext}`}
          onClick={() => targetSessionId && respondToPermission(targetSessionId, requestId, true, { rule: 'always' })}
        >
          {t('permission.allowForSession')}
        </Button>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="base"
          aria-label={`${t('permission.deny')}: ${permissionContext}`}
          onClick={() => targetSessionId && respondToPermission(targetSessionId, requestId, false)}
        >
          {t('permission.deny')}
        </Button>
      </div>
    </div>
  )
}

function ExitPlanModePermissionDialog({
  sessionId,
  requestId,
  input,
  description,
  isPending,
  markerWhenPending,
}: {
  sessionId?: string | null
  requestId: string
  input: unknown
  description?: string
  isPending: boolean
  markerWhenPending: boolean
}) {
  const { respondToPermission } = useChatStore()
  const t = useTranslation()
  const [feedback, setFeedback] = useState('')
  // null = execute on the planning model (unchanged); non-null = the staged
  // execution-model switch sent with the approval as runtimeOverride.
  const [executionRuntime, setExecutionRuntime] = useState<RuntimeSelection | null>(null)
  const sessionRuntimeSelection = useSessionRuntimeStore((state) =>
    sessionId ? state.selections[sessionId] : undefined,
  )
  const providers = useProviderStore((state) => state.providers)
  const activeProviderId = useProviderStore((state) => state.activeId)
  const activeProviderName = useSettingsStore((state) => state.activeProviderName)
  const currentModel = useSettingsStore((state) => state.currentModel)
  const currentRuntime = sessionRuntimeSelection ?? resolveDefaultRuntimeSelection(
    activeProviderId,
    activeProviderName,
    providers,
    currentModel?.id,
  )
  const preview = extractPlanPreview(input)
  const permissionUpdates = buildPromptPermissionUpdates(preview.allowedPrompts)
  const trimmedFeedback = feedback.trim()

  // The chip edits no effort level (the controlled selector hides that popover
  // without a runtimeKey), so any effortLevel on the selection is a
  // normalization artifact — strip it and let the server apply the target
  // provider's default instead of forcing the restart path.
  const handleExecutionRuntimeChange = (selection: RuntimeSelection) => {
    const unchanged =
      selection.providerId === currentRuntime.providerId &&
      selection.modelId === currentRuntime.modelId
    setExecutionRuntime(unchanged ? null : selection)
  }

  const approve = (options?: { permissionUpdates?: PermissionUpdate[] }) => {
    if (!sessionId) return
    if (executionRuntime) {
      // Local echo so the composer pill reflects the switch immediately; the
      // server already received the override inside the permission_response,
      // so deliberately do NOT also send set_runtime_config.
      useSessionRuntimeStore.getState().setSelection(sessionId, {
        providerId: executionRuntime.providerId,
        modelId: executionRuntime.modelId,
      })
    }
    respondToPermission(sessionId, requestId, true, {
      ...options,
      ...(executionRuntime
        ? {
            runtimeOverride: {
              providerId: executionRuntime.providerId,
              modelId: executionRuntime.modelId,
            },
          }
        : {}),
    })
  }

  // Without an explicit mode the CLI resumes with whatever the session had
  // before planning, falling back to `default` when there was nothing to
  // restore (a session launched in plan mode) — which is why implementation
  // used to start by asking for every tool. Approving with a mode pins it.
  const approveWithMode = (mode: PlanApprovalMode) => {
    approve({ permissionUpdates: buildPlanApprovalPermissionUpdates(mode, preview.allowedPrompts) })
  }

  if (isPending && markerWhenPending) {
    return <PendingDecisionMarker title={t('permission.planReadyTitle')} />
  }

  if (!isPending) {
    return (
      <div className={RESOLVED_ROW}>
        <ListChecks aria-hidden="true" size={14} strokeWidth={1.75} className="shrink-0 text-[var(--color-text-tertiary)]" />
        <span className="min-w-0 flex-1 truncate">{t('permission.planReadyTitle')}</span>
        <Badge icon={<Check aria-hidden="true" size={12} strokeWidth={2} />}>
          {t('permission.responded')}
        </Badge>
      </div>
    )
  }

  return (
    <div className={PENDING_CARD}>
      <div className="flex h-[42px] items-center gap-2 border-b border-[var(--color-border)] px-3.5">
        <ListChecks aria-hidden="true" size={15} strokeWidth={1.75} className="shrink-0 text-[var(--color-text-tertiary)]" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[var(--color-text-primary)]">
          {t('permission.planReadyTitle')}
        </span>
        <Badge
          tone="warning"
          icon={<StatusDot tone="warning" pulse />}
          className="shrink-0"
        >
          {t('permission.awaitingApproval')}
        </Badge>
      </div>

      <div className="space-y-3 px-4 pt-3">
        {description ? (
          <p className="truncate text-xs text-[var(--color-text-tertiary)]">{description}</p>
        ) : null}
        <PlanPreviewCard
          embedded
          title={t('permission.planPreviewTitle')}
          plan={preview.plan}
          filePath={preview.filePath}
          allowedPrompts={preview.allowedPrompts}
          requestedPermissionsTitle={t('permission.planRequestedPermissions')}
          emptyLabel={t('permission.planEmpty')}
        />
        <textarea
          value={feedback}
          onChange={(event) => setFeedback(event.target.value)}
          placeholder={t('permission.planFeedbackPlaceholder')}
          rows={3}
          className="min-h-[72px] w-full resize-y rounded-[var(--radius-md)] border border-transparent bg-[var(--color-surface-container)] px-3 py-2.5 text-[13px] text-[var(--color-text-primary)] outline-none transition-colors placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-outline)] focus:bg-[var(--color-surface-container-lowest)]"
        />
        <div className="flex items-center justify-between gap-3">
          <span className="shrink-0 text-xs text-[var(--color-text-tertiary)]">
            {t('permission.planExecutionModel')}
          </span>
          <div
            className={`flex min-w-0 items-center gap-1.5 rounded-[var(--radius-sm)] ${
              executionRuntime ? 'bg-[var(--color-surface-container)] pr-2' : ''
            }`}
            data-testid="plan-execution-model"
          >
            <ModelSelector
              compact
              ariaLabel={t('permission.planExecutionModel')}
              runtimeSelection={executionRuntime ?? currentRuntime}
              onRuntimeSelectionChange={handleExecutionRuntimeChange}
            />
            {executionRuntime ? (
              <span className="shrink-0 text-[11px] font-medium text-[var(--color-text-secondary)]">
                {t('permission.planExecutionModelPending')}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 px-4 pb-3.5 pt-3">
        <Button
          variant="primary"
          size="base"
          onClick={() => approve(permissionUpdates.length ? { permissionUpdates } : undefined)}
        >
          {t('permission.planApprove')}
        </Button>
        <Button
          variant="secondary"
          size="base"
          onClick={() => approveWithMode('acceptEdits')}
        >
          {t('permission.planApproveAcceptEdits')}
        </Button>
        <Button
          variant="danger-ghost"
          size="base"
          onClick={() => approveWithMode('bypassPermissions')}
        >
          {t('permission.planApproveBypass')}
        </Button>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="base"
          onClick={() => sessionId && respondToPermission(sessionId, requestId, false, trimmedFeedback ? { denyMessage: trimmedFeedback } : undefined)}
        >
          {t('permission.planKeepPlanning')}
        </Button>
      </div>
    </div>
  )
}
