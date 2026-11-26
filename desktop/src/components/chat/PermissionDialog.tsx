import { useId, useState } from 'react'
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
import { Kbd } from '@/components/ui/Kbd'
import { ModelSelector } from '../controls/ModelSelector'
import { ANTIGRAVITY_ACP_PROVIDER_ID } from '../../constants/antigravityAcp'
import { isSideChatSession } from '@/lib/sideChatSessions'
import { detectPlatform } from '@/lib/workspace/shortcuts'
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
  antigravityToolName?: string
  subagentName?: string
  supportsAllowAlways?: boolean
  /**
   * While the request waits, draw one marker line instead of the card. The
   * phone answers it from the approval bar in the composer's place.
   */
  markerWhenPending?: boolean
}

/** Card shell shared by the permission and plan-approval cards (「素」). */
const PENDING_CARD =
  'mb-4 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-outline)] border-l-2 border-l-[var(--color-warning)] bg-[var(--color-surface-container)] shadow-[var(--shadow-card)]'

/** A request that has been answered collapses to one quiet line. */
const RESOLVED_ROW =
  'mb-4 flex min-h-9 min-w-0 items-center gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] py-1.5 pl-3 pr-2 text-[13px] text-[var(--color-text-secondary)]'

/** Sunken inset for commands, paths and raw input inside the card. */
const INSET_BLOCK =
  'rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-code-bg)] px-3 py-2.5 font-mono text-xs leading-[1.6] text-[var(--color-code-fg)]'

function renderPermissionPreview(toolName: string, input: unknown, antigravityToolName?: string) {
  const obj = (input && typeof input === 'object') ? input as Record<string, unknown> : {}
  const filePath = typeof obj.file_path === 'string'
    ? obj.file_path
    : typeof obj.Path === 'string'
      ? obj.Path
      : typeof obj.TargetFile === 'string'
        ? obj.TargetFile
        : typeof obj.path === 'string'
          ? obj.path
          : 'file'
  const effectiveTool = antigravityToolName ?? toolName
  const isAntigravityEdit =
    effectiveTool === 'edit_file' ||
    effectiveTool === 'replace_file_content' ||
    effectiveTool === 'multi_replace_file_content'
  const isAntigravityWrite = effectiveTool === 'write_file' || effectiveTool === 'write_to_file'
  const isAntigravityCommand = effectiveTool === 'run_command'

  const oldText = typeof obj.old_string === 'string'
    ? obj.old_string
    : typeof obj.Target === 'string'
      ? obj.Target
      : typeof obj.TargetContent === 'string'
        ? obj.TargetContent
        : undefined
  const newText = typeof obj.new_string === 'string'
    ? obj.new_string
    : typeof obj.Replacement === 'string'
      ? obj.Replacement
      : typeof obj.ReplacementContent === 'string'
        ? obj.ReplacementContent
        : undefined
  if ((toolName === 'Edit' || isAntigravityEdit || Boolean(antigravityToolName)) && oldText !== undefined && newText !== undefined) {
    return <DiffViewer filePath={filePath} oldString={oldText} newString={newText} />
  }

  const writeContent = typeof obj.content === 'string'
    ? obj.content
    : typeof obj.Content === 'string'
      ? obj.Content
      : typeof obj.CodeContent === 'string'
        ? obj.CodeContent
        : undefined
  if ((toolName === 'Write' || isAntigravityWrite) && writeContent !== undefined) {
    return <DiffViewer filePath={filePath} oldString="" newString={writeContent} />
  }

  const command = typeof obj.command === 'string'
    ? obj.command
    : typeof obj.CommandLine === 'string'
      ? obj.CommandLine
      : undefined
  if ((toolName === 'Bash' || isAntigravityCommand) && command !== undefined) {
    return (
      <div className={`scrollbar-autohide scroll-edge-fade max-h-[240px] overflow-auto ${INSET_BLOCK}`}>
        <pre className="whitespace-pre-wrap break-words font-mono">
          <span className="select-none text-[var(--color-brand)]">$ </span>{command}
        </pre>
      </div>
    )
  }

  return null
}

export function PermissionDialog({
  sessionId,
  requestId,
  toolName,
  input,
  description,
  displayName,
  antigravityToolName,
  subagentName,
  supportsAllowAlways,
  markerWhenPending = false,
}: Props) {
  const respondToPermission = useChatStore((s) => s.respondToPermission)
  const activeTabId = useTabStore((s) => s.activeTabId)
  const targetSessionId = sessionId ?? activeTabId
  const pendingPermission = useChatStore((s) => targetSessionId
    ? getPendingPermission(s.sessions[targetSessionId], requestId)
    : undefined)
  const t = useTranslation()
  const submitShortcut = detectPlatform() === 'mac' ? '⌘↵' : 'Ctrl+↵'
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
        submittingRuntime={Boolean(pendingPermission?.planRuntimeSubmission)}
        runtimeError={pendingPermission?.planRuntimeError}
        markerWhenPending={markerWhenPending}
      />
    )
  }

  const effectiveDisplayName = displayName ?? pendingPermission?.displayName
  const effectiveDescription = description ?? pendingPermission?.description
  const effectiveAntigravityToolName = antigravityToolName ?? pendingPermission?.antigravityToolName
  const effectiveSubagentName = subagentName ?? pendingPermission?.subagentName
  const inputSupportsAllowAlways =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as { supportsAllowAlways?: unknown }).supportsAllowAlways
      : undefined
  const allowAlways =
    (supportsAllowAlways ?? pendingPermission?.supportsAllowAlways) !== false &&
    inputSupportsAllowAlways !== false
  const ToolIcon = PERMISSION_TOOL_ICONS[toolName]
    ?? (effectiveAntigravityToolName ? PERMISSION_TOOL_ICONS[effectiveAntigravityToolName] : undefined)
    ?? Shield
  const details = extractToolDetails(toolName, input, t)
  const rawInput = typeof input === 'string' ? input : JSON.stringify(input, null, 2)
  const preview = renderPermissionPreview(toolName, input, effectiveAntigravityToolName)
  const title = getPermissionTitle(toolName, input, t, effectiveDisplayName, effectiveAntigravityToolName)
  const allowRawToggle = !preview
  const permissionContext = (details.primary || effectiveDescription || toolName).slice(0, 160)

  if (isPending && markerWhenPending) {
    return <PendingDecisionMarker title={title} />
  }

  if (!isPending) {
    return (
      <div role="group" aria-label={`${title}: ${permissionContext}`} className={RESOLVED_ROW}>
        <ToolIcon aria-hidden="true" size={14} strokeWidth={1.75} className="shrink-0 text-[var(--color-text-tertiary)]" />
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {effectiveSubagentName ? (
          <Badge tone="info" data-testid="permission-subagent-badge" className="shrink-0">
            {t('permission.fromSubagent', { name: effectiveSubagentName })}
          </Badge>
        ) : null}
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
      onKeyDown={(event) => {
        if (!targetSessionId) return
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          respondToPermission(targetSessionId, requestId, true)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          respondToPermission(targetSessionId, requestId, false)
        }
      }}
      className={PENDING_CARD}
    >
      {/* Header: icon block, title over context, "awaiting" pill. */}
      <div className="flex items-start gap-3 px-4 pb-3 pt-3.5">
        <div className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-warning-container)] text-[var(--color-on-warning-container)]">
          <ToolIcon aria-hidden="true" size={16} strokeWidth={1.75} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-semibold leading-[1.4] text-[var(--color-text-primary)]">
              {title}
            </span>
            {effectiveSubagentName ? (
              <Badge tone="info" data-testid="permission-subagent-badge" className="shrink-0">
                {t('permission.fromSubagent', { name: effectiveSubagentName })}
              </Badge>
            ) : null}
          </div>
          {effectiveDescription && (
            <p className="mt-0.5 truncate text-xs text-[var(--color-text-tertiary)]">{effectiveDescription}</p>
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
            {details.primary && toolName !== 'Bash' && toolName !== 'run_command' && effectiveAntigravityToolName !== 'run_command' ? (
              <div className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-3 py-2 font-mono text-xs text-[var(--color-text-secondary)]">
                <Folder aria-hidden="true" size={14} strokeWidth={1.75} className="shrink-0 text-[var(--color-text-tertiary)]" />
                <span className="truncate">{details.primary}</span>
              </div>
            ) : null}
            {preview}
          </div>
        ) : details.primary ? (
          <div className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-3 py-2 font-mono text-xs text-[var(--color-text-secondary)]">
            {toolName === 'Glob' || toolName === 'Grep'
              ? <Search aria-hidden="true" size={14} strokeWidth={1.75} className="shrink-0 text-[var(--color-text-tertiary)]" />
              : <Folder aria-hidden="true" size={14} strokeWidth={1.75} className="shrink-0 text-[var(--color-text-tertiary)]" />}
            <span className="truncate">{details.primary}</span>
          </div>
        ) : null}

        {/* Secondary detail */}
        {details.secondary && details.secondary.trim() !== effectiveDescription?.trim() && (
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
          <pre className={`scrollbar-autohide scroll-edge-fade mt-1.5 max-h-[220px] overflow-auto whitespace-pre-wrap break-words ${INSET_BLOCK}`}>
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
          <span>{t('permission.allow')}</span>
          <Kbd size="xs" appearance="inverse" aria-hidden="true" className="ml-0.5 opacity-85">{submitShortcut}</Kbd>
        </Button>
        {allowAlways ? (
          <Button
            variant="secondary"
            size="base"
            aria-label={`${t('permission.allowForSession')}: ${permissionContext}`}
            onClick={() => targetSessionId && respondToPermission(targetSessionId, requestId, true, { rule: 'always' })}
          >
            {t('permission.allowForSession')}
          </Button>
        ) : null}
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="base"
          aria-label={`${t('permission.deny')}: ${permissionContext}`}
          onClick={() => targetSessionId && respondToPermission(targetSessionId, requestId, false)}
        >
          <span>{t('permission.deny')}</span>
          <Kbd size="xs" appearance="subtle" aria-hidden="true" className="ml-0.5">Esc</Kbd>
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
  submittingRuntime,
  runtimeError,
  markerWhenPending,
}: {
  sessionId?: string | null
  requestId: string
  input: unknown
  description?: string
  isPending: boolean
  submittingRuntime: boolean
  runtimeError?: string
  markerWhenPending: boolean
}) {
  const errorId = useId()
  const respondToPermission = useChatStore((s) => s.respondToPermission)
  const t = useTranslation()
  const submitShortcut = detectPlatform() === 'mac' ? '⌘↵' : 'Ctrl+↵'
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
  const isAntigravity = currentRuntime.providerId === ANTIGRAVITY_ACP_PROVIDER_ID
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

  const submitPlanDecision = (
    allowed: boolean,
    options?: { permissionUpdates?: PermissionUpdate[]; denyMessage?: string },
  ) => {
    if (!sessionId || submittingRuntime) return
    const runtimeOverride = executionRuntime
      ? {
          providerId: executionRuntime.providerId,
          modelId: executionRuntime.modelId,
        }
      : undefined
    const nextOptions = {
      ...options,
      ...(runtimeOverride ? { runtimeOverride } : {}),
    }
    respondToPermission(
      sessionId,
      requestId,
      allowed,
      Object.keys(nextOptions).length > 0 ? nextOptions : undefined,
    )
  }

  const approve = (options?: { permissionUpdates?: PermissionUpdate[] }) => {
    submitPlanDecision(true, options)
  }

  const keepPlanning = () => {
    submitPlanDecision(false, trimmedFeedback ? { denyMessage: trimmedFeedback } : undefined)
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
    <div
      className={PENDING_CARD}
      onKeyDown={(event) => {
        if (submittingRuntime) return
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          const isEditableTarget = event.target instanceof HTMLElement && (
            event.target.tagName === 'TEXTAREA'
            || event.target.tagName === 'INPUT'
            || event.target.isContentEditable
          )
          if (trimmedFeedback.length > 0) {
            event.preventDefault()
            keepPlanning()
          } else if (!isEditableTarget) {
            event.preventDefault()
            approve(permissionUpdates.length ? { permissionUpdates } : undefined)
          }
        }
      }}
    >
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
          disabled={submittingRuntime}
          className="scrollbar-autohide min-h-[72px] w-full resize-y rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-3 py-2.5 text-[13px] text-[var(--color-text-primary)] outline-none transition-colors placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-outline)] focus:bg-[var(--color-surface-container-lowest)]"
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
              lockedProviderId={isAntigravity
                ? ANTIGRAVITY_ACP_PROVIDER_ID
                : sessionId && isSideChatSession(sessionId)
                  ? currentRuntime.providerId
                  : undefined}
              disabled={submittingRuntime}
              onRuntimeSelectionChange={handleExecutionRuntimeChange}
            />
            {executionRuntime ? (
              <span className="shrink-0 text-[11px] font-medium text-[var(--color-text-secondary)]">
                {t('permission.planExecutionModelPending')}
              </span>
            ) : null}
          </div>
        </div>
        {runtimeError && (
          <p id={errorId} role="alert" className="text-xs text-[var(--color-text-secondary)]">{runtimeError}</p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 px-4 pb-3.5 pt-3">
        <Button
          variant="primary"
          size="base"
          disabled={submittingRuntime}
          aria-describedby={runtimeError ? errorId : undefined}
          onClick={() => approve(permissionUpdates.length ? { permissionUpdates } : undefined)}
        >
          <span>{t('permission.planApprove')}</span>
          <Kbd size="xs" appearance="inverse" aria-hidden="true" className="ml-0.5 opacity-85">{submitShortcut}</Kbd>
        </Button>
        <Button
          variant="secondary"
          size="base"
          disabled={submittingRuntime}
          aria-describedby={runtimeError ? errorId : undefined}
          onClick={() => approveWithMode('acceptEdits')}
        >
          {t('permission.planApproveAcceptEdits')}
        </Button>
        {!isAntigravity ? (
          <Button
            variant="danger-ghost"
            size="base"
            disabled={submittingRuntime}
            aria-describedby={runtimeError ? errorId : undefined}
            onClick={() => approveWithMode('bypassPermissions')}
          >
            {t('permission.planApproveBypass')}
          </Button>
        ) : null}
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="base"
          disabled={submittingRuntime}
          aria-describedby={runtimeError ? errorId : undefined}
          onClick={keepPlanning}
        >
          {t('permission.planKeepPlanning')}
        </Button>
      </div>
    </div>
  )
}
