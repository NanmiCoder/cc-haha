import { Check, Folder, GitBranch } from 'lucide-react'
import { Spinner } from '@/components/ui/Spinner'
import type { TranslationKey } from '../../i18n'
import type { SessionListItem } from '../../types/session'
import { SessionAttentionMark } from './SessionAttentionMark'
import { isWorktreeSession, type SidebarTaskGroup, type SidebarTaskGroupId } from './sidebarTaskGroups'

/**
 * 显式的 key 表，不用模板字符串拼 —— `desktop/AGENTS.md` 点名过：只扫字面量的
 * i18n 检查看不见 `t(\`a.${id}\`)`，五份文案里漏一个不会有人发现。
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
  /** 停在权限请求上的会话：还没结束，但在等你，不是在干活。 */
  attentionSessionIds: ReadonlySet<string>
  selectedSessionIds: ReadonlySet<string>
  isBatchMode: boolean
  isMobile: boolean
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
  isMobile,
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
          {/* `--color-text-tertiary` 在四个纸系主题下压到 4.31:1，够不上本项目
              4.5 的线。它在别处标的是相对时间那类装饰，这里却是分段本身。 */}
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
                    isMobile={isMobile}
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
  isMobile,
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
  isMobile: boolean
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
        group/session w-full rounded-[var(--radius-sm)] px-2 ${isMobile ? 'py-2.5' : 'py-1.5'} text-left transition-[background,color,box-shadow] duration-150
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
        <span className="ml-auto flex h-4 flex-shrink-0 items-center justify-end">
          {needsAttention ? (
            <span className="inline-flex h-4 w-4 items-center justify-center">
              {/* 与 tab 栏、项目视图共用同一个标志；名字与 title 都在它自己身上。 */}
              <SessionAttentionMark label={t('sidebar.sessionNeedsAttention')} />
            </span>
          ) : isRunning ? (
            <span
              className="inline-flex h-4 w-4 items-center justify-center text-[var(--color-info)]"
              aria-label={t('sidebar.sessionRunning')}
              title={t('sidebar.sessionRunning')}
            >
              {/* 外层已经带名字了，spinner 本身保持静默。 */}
              <Spinner size={12} />
            </span>
          ) : null}
        </span>
      </span>
      {/* 所属目录是这个视图存在的理由（分组视图里恰恰是它被折叠掉了），不是
          装饰文字，所以用能过 4.5 的 secondary，层级交给字号和字重。 */}
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
