import type { TranslationKey } from '../../i18n'
import type { SessionListItem } from '../../types/session'
import { SidebarSessionCard } from './SidebarSessionCard'
import type { SidebarTaskGroup, SidebarTaskGroupId } from './sidebarTaskGroups'

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
  renamingId: string | null
  renameValue: string
  workspaceLabelFor: (session: SessionListItem) => string
  onRenameChange: (value: string) => void
  onFinishRename: () => void
  onCancelRename: () => void
  onSessionClick: (event: React.MouseEvent, session: SessionListItem) => void
  onSessionContextMenu: (event: React.MouseEvent, sessionId: string) => void
  onSessionOpenMenu?: (event: React.MouseEvent<HTMLButtonElement>, sessionId: string) => void
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
  onSessionOpenMenu,
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
                className="group/session-row relative mb-px last:mb-0"
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
                  <SidebarSessionCard
                    session={session}
                    variant="task"
                    workspaceLabel={workspaceLabelFor(session)}
                    isActive={session.id === activeTabId}
                    isSelected={selectedSessionIds.has(session.id)}
                    isRunning={runningSessionIds.has(session.id)}
                    needsAttention={attentionSessionIds.has(session.id)}
                    isBatchMode={isBatchMode}
                    onClick={onSessionClick}
                    onContextMenu={onSessionContextMenu}
                    onOpenMenu={onSessionOpenMenu}
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
