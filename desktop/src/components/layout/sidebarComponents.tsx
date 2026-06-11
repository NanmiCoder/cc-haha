import { Check, ChevronDown, Clock, Folder, FolderOpen, FolderPlus, GitBranch, LoaderCircle, MoreHorizontal, RefreshCw, RotateCcw, SquarePen } from 'lucide-react'
import type { TranslationKey } from '../../i18n'
import { formatRelativeTime, type SidebarProjectOrganization, type SidebarProjectSortBy } from './sidebarUtils'

// ─── Icon Components ──────────────────────────────

export function GitHubIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
    </svg>
  )
}

export function PlusIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}

export function ClockIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  )
}

export function SearchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  )
}

export function SidebarToggleIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      width={collapsed ? 16 : 14}
      height={collapsed ? 16 : 14}
      viewBox="0 0 14 14"
      fill="none"
      className={`sidebar-toggle-icon ${collapsed ? 'sidebar-toggle-icon--collapsed' : 'sidebar-toggle-icon--open'}`}
      aria-hidden="true"
    >
      <path
        d={collapsed ? 'M5 3 9 7l-4 4' : 'M9 3 5 7l4 4'}
        className="sidebar-toggle-chevron"
      />
    </svg>
  )
}

// ─── Helper Components ──────────────────────────────

export function ProjectHeaderActions({
  title,
  menuLabel,
  createLabel,
  onOpenMenu,
  onOpenCreate,
}: {
  title: string
  menuLabel: string
  createLabel: string
  onOpenMenu: (event: React.MouseEvent) => void
  onOpenCreate: (event: React.MouseEvent) => void
}) {
  return (
    <div
      data-testid="sidebar-projects-header"
      className="group/sidebar-projects flex items-center justify-between px-1.5 pb-2 pt-1"
    >
      <div className="text-[12px] font-semibold tracking-normal text-[var(--color-text-primary)]">
        {title}
      </div>
      <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover/sidebar-projects:opacity-100 focus-within:opacity-100">
        <button
          type="button"
          onClick={onOpenMenu}
          aria-label={menuLabel}
          className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
        >
          <MoreHorizontal size={16} />
        </button>
        <button
          type="button"
          onClick={onOpenCreate}
          aria-label={createLabel}
          className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
        >
          <FolderPlus size={16} />
        </button>
      </div>
    </div>
  )
}

export function ProjectHeaderMenu({
  type,
  x,
  y,
  organization,
  sortBy,
  onOpenSubmenu,
  onSetOrganization,
  onSetSortBy,
  onCreateBlank,
  onUseExistingFolder,
  onRestoreHiddenProjects,
  hiddenProjectCount,
  t,
}: {
  type: string
  x: number
  y: number
  organization: SidebarProjectOrganization
  sortBy: SidebarProjectSortBy
  onOpenSubmenu: (event: React.MouseEvent, type: 'organize' | 'sort') => void
  onSetOrganization: (organization: SidebarProjectOrganization) => void
  onSetSortBy: (sortBy: SidebarProjectSortBy) => void
  onCreateBlank: () => void
  onUseExistingFolder: () => void
  onRestoreHiddenProjects: () => void
  hiddenProjectCount: number
  t: (key: TranslationKey, params?: Record<string, string | number>) => string
}) {
  const width = type === 'sort' ? 230 : type === 'create' ? 250 : 270
  const style: React.CSSProperties = { left: x, top: y, width, boxShadow: 'var(--shadow-dropdown)' }
  const className = 'fixed z-50 overflow-hidden rounded-[18px] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] py-2 shadow-[var(--shadow-dropdown)]'

  if (type === 'create') {
    return (
      <div role="menu" className={className} style={style} onClick={(event) => event.stopPropagation()}>
        <HeaderMenuItem icon={<SquarePen size={18} aria-hidden="true" />} onClick={onCreateBlank}>
          {t('sidebar.newBlankProject')}
        </HeaderMenuItem>
        <HeaderMenuItem icon={<FolderOpen size={18} aria-hidden="true" />} onClick={onUseExistingFolder}>
          {t('sidebar.useExistingFolder')}
        </HeaderMenuItem>
      </div>
    )
  }

  if (type === 'organize') {
    return (
      <div role="menu" className={className} style={style} onClick={(event) => event.stopPropagation()}>
        <HeaderMenuItem icon={<Folder size={18} aria-hidden="true" />} checked={organization === 'project'} onClick={() => onSetOrganization('project')}>
          {t('sidebar.organizeByProject')}
        </HeaderMenuItem>
        <HeaderMenuItem icon={<FolderOpen size={18} aria-hidden="true" />} checked={organization === 'recentProject'} onClick={() => onSetOrganization('recentProject')}>
          {t('sidebar.organizeByRecentProject')}
        </HeaderMenuItem>
        <HeaderMenuItem icon={<Clock size={18} aria-hidden="true" />} checked={organization === 'time'} onClick={() => onSetOrganization('time')}>
          {t('sidebar.organizeByTime')}
        </HeaderMenuItem>
      </div>
    )
  }

  if (type === 'sort') {
    return (
      <div role="menu" className={className} style={style} onClick={(event) => event.stopPropagation()}>
        <HeaderMenuItem icon={<Clock size={18} aria-hidden="true" />} checked={sortBy === 'createdAt'} onClick={() => onSetSortBy('createdAt')}>
          {t('sidebar.sortByCreatedAt')}
        </HeaderMenuItem>
        <HeaderMenuItem icon={<RefreshCw size={18} aria-hidden="true" />} checked={sortBy === 'updatedAt'} onClick={() => onSetSortBy('updatedAt')}>
          {t('sidebar.sortByUpdatedAt')}
        </HeaderMenuItem>
      </div>
    )
  }

  return (
    <div role="menu" className={className} style={style} onClick={(event) => event.stopPropagation()}>
      <HeaderMenuItem
        icon={<Folder size={18} aria-hidden="true" />}
        trailing
        onMouseEnter={(event) => onOpenSubmenu(event, 'organize')}
        onClick={(event) => onOpenSubmenu(event, 'organize')}
      >
        {t('sidebar.organizeSidebar')}
      </HeaderMenuItem>
      <HeaderMenuItem
        icon={<Clock size={18} aria-hidden="true" />}
        trailing
        onMouseEnter={(event) => onOpenSubmenu(event, 'sort')}
        onClick={(event) => onOpenSubmenu(event, 'sort')}
      >
        {t('sidebar.sortCondition')}
      </HeaderMenuItem>
      {hiddenProjectCount > 0 && (
        <HeaderMenuItem
          icon={<RotateCcw size={18} aria-hidden="true" />}
          onClick={onRestoreHiddenProjects}
        >
          {t('sidebar.restoreHiddenProjects', { count: hiddenProjectCount })}
        </HeaderMenuItem>
      )}
    </div>
  )
}

export function HeaderMenuItem({
  icon,
  children,
  onClick,
  onMouseEnter,
  checked = false,
  trailing = false,
}: {
  icon: React.ReactNode
  children: React.ReactNode
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void
  onMouseEnter?: (event: React.MouseEvent<HTMLButtonElement>) => void
  checked?: boolean
  trailing?: boolean
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm font-semibold text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:bg-[var(--color-surface-hover)]"
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center text-[var(--color-text-secondary)]">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {checked && <Check className="h-[17px] w-[17px] text-[var(--color-text-secondary)]" strokeWidth={2} aria-hidden="true" />}
      {trailing && !checked && (
        <ChevronDown className="-rotate-90 h-[17px] w-[17px] text-[var(--color-text-tertiary)]" strokeWidth={2} aria-hidden="true" />
      )}
    </button>
  )
}

export function ProjectMenuItem({
  icon,
  children,
  onClick,
  disabled = false,
  danger = false,
}: {
  icon: React.ReactNode
  children: React.ReactNode
  onClick?: () => void
  disabled?: boolean
  danger?: boolean
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={disabled ? undefined : onClick}
      className={`flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:bg-[var(--color-surface-hover)] disabled:cursor-default disabled:opacity-45 ${
        danger
          ? 'text-[var(--color-error)] enabled:hover:bg-[var(--color-error)]/10'
          : 'text-[var(--color-text-primary)] enabled:hover:bg-[var(--color-surface-hover)]'
      }`}
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center text-current">
        {icon}
      </span>
      <span className="min-w-0 truncate">{children}</span>
    </button>
  )
}

export function SessionRowMeta({
  isRunning,
  isWorktree,
  modifiedAt,
  t,
}: {
  isRunning: boolean
  isWorktree: boolean
  modifiedAt: string
  t: (key: TranslationKey, params?: Record<string, string | number>) => string
}) {
  const relativeTime = formatRelativeTime(modifiedAt, t)
  const updatedLabel = t('session.lastUpdated', { time: relativeTime })

  return (
    <span
      className="ml-auto flex h-5 min-w-[78px] flex-shrink-0 items-center justify-end gap-1.5 text-[10px] font-medium tabular-nums text-[var(--color-text-tertiary)]"
      title={updatedLabel}
    >
      {isRunning && (
        <span
          className="inline-flex h-4 w-4 flex-shrink-0 items-center justify-center text-[var(--color-success)]"
          aria-label={t('sidebar.sessionRunning')}
          title={t('sidebar.sessionRunning')}
        >
          <LoaderCircle className="h-3.5 w-3.5 animate-spin" strokeWidth={2.2} aria-hidden="true" />
        </span>
      )}
      {isWorktree && (
        <span
          className="inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-[5px] text-[var(--color-text-tertiary)]"
          title={t('sidebar.worktree')}
        >
          <GitBranch className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
          <span className="sr-only">{t('sidebar.worktree')}</span>
        </span>
      )}
      <span className="inline-flex min-w-[42px] flex-shrink-0 items-center justify-end">
        <span>{relativeTime}</span>
      </span>
    </span>
  )
}

export function NavItem({
  active,
  collapsed,
  label,
  touchFriendly,
  onClick,
  icon,
  children,
}: {
  active: boolean
  collapsed: boolean
  label: string
  touchFriendly?: boolean
  onClick: () => void
  icon: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={collapsed ? label : undefined}
      className={`
        flex items-center transition-colors duration-200
        ${collapsed ? 'h-10 w-10 justify-center rounded-[var(--radius-md)] px-0 py-0' : `w-full gap-2.5 rounded-[12px] px-3 ${touchFriendly ? 'py-3' : 'py-2.5'} text-sm`}
        ${active
          ? 'bg-[var(--color-sidebar-item-active)] font-medium text-[var(--color-text-primary)]'
          : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-sidebar-item-hover)] hover:text-[var(--color-text-primary)]'
        }
      `}
    >
      <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
        {icon}
      </span>
      <span className={`sidebar-copy ${collapsed ? 'sidebar-copy--hidden' : 'sidebar-copy--visible'}`}>
        {children}
      </span>
    </button>
  )
}
