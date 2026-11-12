import { SessionScheduleMark } from '@/components/tasks/SessionScheduleMark'
import { Check, Folder, GitBranch } from 'lucide-react'
import { Spinner } from '@/components/ui/Spinner'
import type { TranslationKey } from '../../i18n'
import type { SessionListItem } from '../../types/session'
import { SessionAttentionMark } from './SessionAttentionMark'
import { isWorktreeSession, type SidebarTaskGroup, type SidebarTaskGroupId } from './sidebarTaskGroups'

/**
 * An explicit key table rather than template strings: as `desktop/AGENTS.md` notes, an i18n
 * check that only scans literals cannot see `t(\`a.${id}\`)`, so a missing string would go unnoticed.
 */
const GROUP_TITLE_KEYS: Record<SidebarTaskGroupId, TranslationKey> = {
  running: 'sidebar.taskGroup.running',
  today: 'sidebar.taskGroup.today',
  yesterday: 'sidebar.taskGroup.yesterday',
  last7Days: 'sidebar.taskGroup.last7Days',
  last30Days: 'sidebar.taskGroup.last30Days',
  earlier: 'sidebar.taskGroup.earlier',
}

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string

export type SidebarTaskListProps = {
  groups: SidebarTaskGroup[]
  activeTabId: string | null
  runningSessionIds: ReadonlySet<string>
  /** Sessions stopped on a permission request: not finished, but waiting for you rather than working. */
  attentionSessionIds: ReadonlySet<string>
  selectedSessionIds: ReadonlySet<string>
  isBatchMode: boolean
  renamingId: string | null
  renameValue: string
  workspaceLabelFor: (session: SessionListItem) => string
  onRenameChange: (value: string) => void
  onFinishRename: () => void
  onCancelRename: () => void
  onSessionClick: (event: React.MouseEvent, session: SessionListItem) => void
  onSessionContextMenu: (event: React.MouseEvent, sessionId: string) => void
  t: Translate
}

export function SidebarTaskList({
  groups,
  activeTabId,
  runningSessionIds,
  attentionSessionIds,
  selectedSessionIds,
  isBatchMode,
  renamingId,
  renameValue,
  workspaceLabelFor,
  onRenameChange,
  onFinishRename,
  onCancelRename,
  onSessionClick,
  onSessionContextMenu,
  t,
}: SidebarTaskListProps) {
  return (
    <div data-testid="sidebar-task-list">
      {groups.map((group) => (
        <section
          key={group.id}
          data-testid={`sidebar-task-group-${group.id}`}
          className="mb-3"
        >
          {/* `--color-text-tertiary` drops to 4.31:1 on the four paper themes, below this project's
              4.5 bar. Elsewhere it marks decoration such as relative times; here it is the section itself. */}
          <div className="flex h-7 items-center px-2 text-[12px] font-semibold text-[var(--color-text-secondary)]">
            {t(GROUP_TITLE_KEYS[group.id])}
          </div>
          <div>
            {group.sessions.map((session) => (
              <div
                key={session.id}
                data-sidebar-session-id={session.id}
                className="relative mb-px last:mb-0"
              >
                {renamingId === session.id ? (
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={(event) => onRenameChange(event.target.value)}
                    onBlur={onFinishRename}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') onFinishRename()
                      if (event.key === 'Escape') onCancelRename()
                    }}
                    className="h-[30px] w-full rounded-[var(--radius-sm)] border border-[var(--color-border-focus)] bg-[var(--color-surface)] px-2 text-[13px] text-[var(--color-text-primary)] outline-none"
                  />
                ) : (
                  <SidebarTaskRow
                    session={session}
                    isActive={session.id === activeTabId}
                    isSelected={selectedSessionIds.has(session.id)}
                    isRunning={runningSessionIds.has(session.id)}
                    needsAttention={attentionSessionIds.has(session.id)}
                    isBatchMode={isBatchMode}
                    workspaceLabel={workspaceLabelFor(session)}
                    onClick={onSessionClick}
                    onContextMenu={onSessionContextMenu}
                    t={t}
                  />
                )}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

function SidebarTaskRow({
  session,
  isActive,
  isSelected,
  isRunning,
  needsAttention,
  isBatchMode,
  workspaceLabel,
  onClick,
  onContextMenu,
  t,
}: {
  session: SessionListItem
  isActive: boolean
  isSelected: boolean
  isRunning: boolean
  needsAttention: boolean
  isBatchMode: boolean
  workspaceLabel: string
  onClick: (event: React.MouseEvent, session: SessionListItem) => void
  onContextMenu: (event: React.MouseEvent, sessionId: string) => void
  t: Translate
}) {
  const isWorktree = isWorktreeSession(session)
  const title = session.title || 'Untitled'

  return (
    <button
      type="button"
      onClick={(event) => onClick(event, session)}
      onContextMenu={(event) => onContextMenu(event, session.id)}
      className={`
        group/session w-full rounded-[var(--radius-sm)] px-2 py-1.5 text-left transition-[background,color,box-shadow] duration-150
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--color-surface-sidebar)]
        ${isSelected
          ? 'sidebar-session-row--selected bg-[var(--color-sidebar-item-active)] text-[var(--color-text-primary)] shadow-[0_0_0_1px_var(--color-border),var(--shadow-raised)]'
          : isActive
          ? 'sidebar-session-row--active bg-[var(--color-sidebar-item-active)] text-[var(--color-text-primary)] shadow-[0_0_0_1px_var(--color-border),var(--shadow-raised)]'
          : 'sidebar-session-row--idle text-[var(--color-text-secondary)] hover:bg-[var(--color-sidebar-item-hover)] hover:text-[var(--color-text-primary)]'
        }
      `}
      aria-pressed={isBatchMode ? isSelected : undefined}
      title={title}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        {isBatchMode ? (
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
        ) : null}
        <span className={`min-w-0 flex-1 truncate text-[13px] ${isActive || isSelected ? 'font-medium' : ''}`}>{title}</span>
        <SessionScheduleMark sessionId={session.id} />
        <span className="ml-auto flex h-4 flex-shrink-0 items-center justify-end">
          {needsAttention ? (
            <span className="inline-flex h-4 w-4 items-center justify-center">
              {/* Same mark as the tab bar and project view; its name and title live on the mark itself. */}
              <SessionAttentionMark label={t('sidebar.sessionNeedsAttention')} />
            </span>
          ) : isRunning ? (
            <span
              className="inline-flex h-4 w-4 items-center justify-center text-[var(--color-info)]"
              aria-label={t('sidebar.sessionRunning')}
              title={t('sidebar.sessionRunning')}
            >
              {/* The wrapper already carries the name, so the spinner stays silent. */}
              <Spinner size={12} />
            </span>
          ) : null}
        </span>
      </span>
      {/* The folder is why this view exists (the grouped view is exactly where it gets folded away), not
          decoration, so it uses secondary, which passes 4.5, and leaves hierarchy to size and weight. */}
      <span className="mt-0.5 flex min-w-0 items-center gap-1 pl-0.5 text-[11px] text-[var(--color-text-secondary)]">
        {isWorktree ? (
          <GitBranch size={12} strokeWidth={2} className="flex-shrink-0" aria-hidden="true" />
        ) : (
          <Folder size={12} strokeWidth={2} className="flex-shrink-0" aria-hidden="true" />
        )}
        <span className="min-w-0 truncate">{workspaceLabel}</span>
        {isWorktree && <span className="sr-only">{t('sidebar.worktree')}</span>}
      </span>
    </button>
  )
}
