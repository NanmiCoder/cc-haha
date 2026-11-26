import { Check, Ellipsis, Folder, GitBranch } from 'lucide-react'
import { ModelBrandIcon } from '@/components/composite/ModelBrandIcon'
import { SessionScheduleMark } from '@/components/tasks/SessionScheduleMark'
import { IconButton } from '@/components/ui/IconButton'
import { Spinner } from '@/components/ui/Spinner'
import { ANTIGRAVITY_ACP_PROVIDER_ID } from '@/constants/antigravityAcp'
import { formatRelativeTime } from '@/lib/formatRelativeTime'
import { getSessionWorkspaceState } from '@/lib/sessionWorkspace'
import type { TranslationKey } from '@/i18n'
import type { SessionListItem } from '@/types/session'
import { SessionAttentionMark } from './SessionAttentionMark'
import { isWorktreeSession } from './sidebarTaskGroups'

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string

/** Soft editorial active highlight on the sidebar surface without heavy shadow clutter. */
const SIDEBAR_ROW_RAISED =
  'bg-[var(--color-sidebar-item-active)] text-[var(--color-text-primary)]'

const ICON_STROKE = 1.75

function extractWorktreeLabel(workDir: string | null | undefined): string | null {
  if (!workDir) return null
  const match = workDir.match(/[\\/]\.claude[\\/]worktrees[\\/]([^\\/]+)/)
  return match?.[1] ?? null
}

export type SidebarSessionCardProps = {
  session: SessionListItem
  variant: 'project' | 'task'
  /** Owning project/workspace label, displayed on Line 1 in task view. */
  workspaceLabel?: string
  isActive: boolean
  isSelected: boolean
  isRunning: boolean
  needsAttention: boolean
  isBatchMode: boolean
  onClick: (event: React.MouseEvent, session: SessionListItem) => void
  onContextMenu: (event: React.MouseEvent, sessionId: string) => void
  onOpenMenu?: (event: React.MouseEvent<HTMLButtonElement>, sessionId: string) => void
  t: Translate
}

/**
 * Adaptive thread card shared by project-grouped and time-bucketed sidebar views.
 *
 * - Task view: Line 1 shows project/workspace + live status/relative time
 *   (`tabular-nums`); Line 2 shows the thread title; Line 3 shows worktree /
 *   missing-dir metadata and collapses completely when empty.
 * - Project view: Line 1 shows the thread title + live status/relative time
 *   aligned under the project folder (`pl-8`); Line 2 shows worktree /
 *   missing-dir badges and collapses compactly when empty.
 * - Hovering or focusing (`focus-within`, Safari 15-safe) swaps the trailing
 *   relative time for a crisp quick-actions trigger with zero layout shift.
 */
export function SidebarSessionCard({
  session,
  variant,
  workspaceLabel,
  isActive,
  isSelected,
  isRunning,
  needsAttention,
  isBatchMode,
  onClick,
  onContextMenu,
  onOpenMenu,
  t,
}: SidebarSessionCardProps) {
  const isAntigravity = session.runtimeProviderId === ANTIGRAVITY_ACP_PROVIDER_ID
  const isWorktree = isWorktreeSession(session)
  const isMissingDir = getSessionWorkspaceState(session) === 'missing'
  const worktreeName = isWorktree ? extractWorktreeLabel(session.workDir) : null
  const hasMetadataRow = isWorktree || isMissingDir
  const title = session.title || t('tabs.untitled')
  const showHoverSwap = Boolean(!isBatchMode && !needsAttention && onOpenMenu)

  const antigravityMark = isAntigravity ? (
    <span
      data-testid="sidebar-antigravity-badge"
      title={t('settings.providers.antigravity.name')}
      className="inline-flex shrink-0 items-center text-[var(--color-text-tertiary)]"
    >
      <ModelBrandIcon providerId={ANTIGRAVITY_ACP_PROVIDER_ID} size={12} />
    </span>
  ) : null

  const relativeTime = formatRelativeTime(session.modifiedAt, t)
  const updatedLabel = t('session.lastUpdated', { time: relativeTime })

  const stateClass = isSelected
    ? `sidebar-session-row--selected ${SIDEBAR_ROW_RAISED} font-medium`
    : isActive
      ? `sidebar-session-row--active ${SIDEBAR_ROW_RAISED} font-medium`
      : 'sidebar-session-row--idle text-[var(--color-text-secondary)] hover:bg-[var(--color-sidebar-item-hover)] hover:text-[var(--color-text-primary)]'

  const metaSwapClass = showHoverSwap
    ? 'transition-opacity duration-150 group-hover/session-row:opacity-0 group-focus-within/session-row:opacity-0'
    : ''

  const statusMeta = (
    <span
      className={`ml-auto flex h-4 flex-shrink-0 items-center justify-end gap-1 whitespace-nowrap text-[11px] font-normal tabular-nums text-[var(--color-text-tertiary)] ${metaSwapClass}`}
      title={updatedLabel}
    >
      {needsAttention ? (
        <span className="flex min-w-0 items-center gap-1 font-medium text-[var(--color-on-warning-container)]">
          <SessionAttentionMark label={t('sidebar.sessionNeedsAttention')} />
          <span aria-hidden="true" className="max-w-[88px] truncate">
            {t('sidebar.sessionStatus.attention')}
          </span>
        </span>
      ) : (
        <>
          {isRunning && (
            <span
              className="inline-flex h-4 w-4 flex-shrink-0 items-center justify-center text-[var(--color-info)]"
              aria-label={t('sidebar.sessionRunning')}
              title={t('sidebar.sessionRunning')}
            >
              <Spinner size={12} />
            </span>
          )}
          <span className="flex-shrink-0">{relativeTime}</span>
        </>
      )}
    </span>
  )

  const metadataRow = hasMetadataRow ? (
    <span
      className={`mt-1 flex min-w-0 flex-wrap items-center gap-1.5 ${variant === 'task' ? 'order-3' : ''}`}
    >
      {isWorktree && (
        <span
          className="inline-flex max-w-full items-center gap-1 rounded-[var(--radius-xs)] border border-[var(--color-border)] bg-[var(--color-surface-container)] px-1.5 py-0.5 font-mono text-[11px] font-normal leading-none text-[var(--color-text-secondary)]"
          title={t('sidebar.worktree')}
        >
          <GitBranch size={11} strokeWidth={ICON_STROKE} className="flex-shrink-0" aria-hidden="true" />
          {worktreeName ? <span className="truncate">{worktreeName}</span> : null}
          <span className="sr-only">{t('sidebar.worktree')}</span>
        </span>
      )}
      {isMissingDir && (
        <span
          className="inline-flex items-center rounded-[var(--radius-xs)] bg-[var(--color-warning-container)] px-1.5 py-0.5 text-[11px] font-normal leading-none text-[var(--color-on-warning-container)]"
          title={session.workDir ?? ''}
        >
          {t('sidebar.missingDir')}
        </span>
      )}
    </span>
  ) : null

  const batchCheckbox = isBatchMode ? (
    <span
      className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-[var(--radius-xs)] border transition-colors ${
        isSelected
          ? 'border-[var(--color-brand)] bg-[var(--color-brand)] text-[var(--color-on-primary)]'
          : 'border-[var(--color-border-strong)] bg-[var(--color-surface)]'
      }`}
      aria-hidden="true"
    >
      {isSelected && <Check size={12} strokeWidth={2} aria-hidden="true" />}
    </span>
  ) : null

  return (
    <>
      <button
        type="button"
        onClick={(event) => onClick(event, session)}
        onContextMenu={(event) => onContextMenu(event, session.id)}
        className={`
          group/session flex w-full flex-col rounded-[var(--radius-sm)] py-1.5 min-h-[30px] text-left transition-[background,color,box-shadow] duration-150
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--color-surface-sidebar)]
          ${variant === 'project' ? 'pl-8 pr-2' : 'px-2.5'}
          ${stateClass}
        `}
        aria-pressed={isBatchMode ? isSelected : undefined}
        title={title}
      >
        {variant === 'task' ? (
          <>
            {/* Kept first in DOM so accessible names lead with the thread title;
                CSS order renders the project/time header as visual Line 1. */}
            <span className="order-2 flex min-w-0 items-center gap-1.5">
              {batchCheckbox}
              <span className={`min-w-0 flex-1 truncate text-[13px] leading-[18px] ${isActive || isSelected ? 'font-medium' : ''}`}>
                {title}
              </span>
              {antigravityMark}
              <SessionScheduleMark sessionId={session.id} />
            </span>
            <span className="order-1 mb-0.5 flex min-w-0 items-center gap-1.5 text-[11px] font-normal text-[var(--color-text-secondary)]">
              <Folder size={11} strokeWidth={ICON_STROKE} className="flex-shrink-0 text-[var(--color-text-tertiary)]" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{workspaceLabel}</span>
              {statusMeta}
            </span>
            {metadataRow}
          </>
        ) : (
          <>
            <span className="flex min-w-0 items-center gap-1.5">
              {batchCheckbox}
              <span className="min-w-0 flex-1 truncate text-[13px] leading-[18px]">
                {title}
              </span>
              {antigravityMark}
              <SessionScheduleMark sessionId={session.id} />
              {statusMeta}
            </span>
            {metadataRow}
          </>
        )}
      </button>

      {showHoverSwap && onOpenMenu ? (
        <span
          className={`pointer-events-none absolute right-1.5 ${variant === 'task' ? 'top-1' : 'top-[5px]'} opacity-0 transition-opacity duration-150 group-hover/session-row:pointer-events-auto group-hover/session-row:opacity-100 group-focus-within/session-row:pointer-events-auto group-focus-within/session-row:opacity-100`}
        >
          <IconButton
            icon={<Ellipsis size={13} strokeWidth={ICON_STROKE} aria-hidden="true" />}
            label={t('tasks.moreActions')}
            size="2xs"
            tone="muted"
            surface="sidebar"
            showTooltip={false}
            onClick={(event) => {
              event.stopPropagation()
              onOpenMenu(event, session.id)
            }}
          />
        </span>
      ) : null}
    </>
  )
}
