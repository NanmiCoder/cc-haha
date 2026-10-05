import { Folder, GitBranch, GitFork } from 'lucide-react'
import { Tooltip } from '@/components/ui/Tooltip'
import { useTranslation } from '../../i18n'
import { getFileNameFromPath } from '../../lib/composerAttachments'
import { useProjectDisplayName } from '../../stores/projectDisplayNameStore'
import { getWorktreeDisplayName, WorktreeDetails } from './WorktreeDetails'

type Props = {
  workDir?: string | null
  projectRoot?: string | null
  repoName?: string | null
  branch?: string | null
  sourceWorkDir?: string | null
  isWorktree?: boolean
  worktreeSlug?: string | null
  worktreePath?: string | null
  compact?: boolean
  /**
   * `toolbar` is the read-only twin of the run-location pill: same row, same
   * metrics, minus the border and the chevron. Sending the first message swaps
   * one for the other in place, so nothing moves. It is what the wide desktop
   * composer renders; `chip` is left for the narrow layouts (H5, and the
   * desktop composer beside an open workspace panel), which keep the location
   * on its own line below the panel.
   */
  variant?: 'chip' | 'toolbar'
}

function basename(path: string | null | undefined): string {
  return path ? getFileNameFromPath(path) : ''
}

export function ProjectContextChip({
  workDir,
  projectRoot,
  repoName,
  branch,
  sourceWorkDir,
  isWorktree = false,
  worktreeSlug,
  worktreePath,
  compact = false,
  variant = 'chip',
}: Props) {
  const t = useTranslation()
  const labelRoot = isWorktree ? (sourceWorkDir || workDir) : workDir
  const displayNameKey = projectRoot ?? sourceWorkDir ?? workDir ?? ''
  const displayName = useProjectDisplayName(displayNameKey)
  const label = displayName || (branch ? (repoName || basename(labelRoot)) : (basename(labelRoot) || repoName || ''))
  const worktreeName = getWorktreeDisplayName(worktreeSlug, worktreePath) || 'isolated'
  const isToolbar = variant === 'toolbar'
  // The chip variant hides the branch for worktrees — the worktree name already
  // encodes it. The toolbar variant keeps it, because it has to stay
  // frame-for-frame identical to the pill it replaces, and the pill shows both.
  const showBranch = !!branch && (isToolbar || !isWorktree)
  const title = [
    label,
    displayName ? `project root: ${displayNameKey}` : null,
    branch ? `branch: ${branch}` : null,
    workDir ? `cwd: ${workDir}` : null,
  ].filter(Boolean).join('\n')
  const worktreeDetails = (
    <WorktreeDetails
      name={worktreeName}
      path={worktreePath}
      projectRoot={displayName ? displayNameKey : null}
    />
  )

  if (!label) return null

  const worktreeBadgeClassName = 'inline-flex h-[18px] shrink-0 cursor-help items-center gap-1 rounded-[var(--radius-xs)] bg-[var(--color-surface-container)] px-1.5 text-[11px] font-medium leading-none text-[var(--color-text-secondary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)]'
  const iconClassName = 'shrink-0 text-[var(--color-text-tertiary)]'

  if (isToolbar) {
    return (
      <div
        title={isWorktree ? undefined : title}
        data-testid="run-location-readonly"
        // Same frame as the run-location pill it replaces (h-7, px-1.5), minus
        // the hover fill and chevron: this one is read-only.
        className="inline-flex h-7 min-w-0 max-w-full shrink items-center gap-1.5 px-1.5 text-xs leading-none text-[var(--color-text-tertiary)]"
      >
        <Folder size={14} strokeWidth={1.75} aria-hidden="true" className={iconClassName} />
        <span className="min-w-[1.75rem] shrink truncate">{label}</span>
        {showBranch && (
          <>
            <span aria-hidden="true" className="shrink-0 text-[var(--color-outline)]">/</span>
            <GitBranch size={14} strokeWidth={1.75} aria-hidden="true" className={iconClassName} />
            {/* Ellipsis at the start so the branch keeps its tail — see the pill.
                `shrink-[4]`: the two used to shrink in step, so a narrow column
                took both down together and left `cc-…/…n` — two truncations,
                neither readable. The project name is the one that identifies
                the row, so the branch gives up its width first. */}
            <span dir="rtl" className="min-w-0 shrink-[4] truncate text-left">
              <bdi>{branch}</bdi>
            </span>
          </>
        )}
        {isWorktree && (
          <Tooltip content={worktreeDetails} placement="top-start">
            <span
              data-testid="worktree-details-trigger"
              tabIndex={0}
              className={worktreeBadgeClassName}
            >
              <GitFork size={12} strokeWidth={2} aria-hidden="true" />
              {t('repoLaunch.worktreeBadge')}
            </span>
          </Tooltip>
        )}
      </div>
    )
  }

  return (
    <div
      title={isWorktree ? undefined : title}
      data-testid="run-location-outside"
      className={`inline-flex max-w-full items-center gap-1.5 px-1.5 text-xs leading-none text-[var(--color-text-tertiary)] ${
        compact ? 'h-7' : 'h-8'
      }`}
    >
      <Folder size={14} strokeWidth={1.75} aria-hidden="true" className={iconClassName} />
      <span className="truncate">{label}</span>
      {showBranch ? (
        <>
          <span aria-hidden="true" className="shrink-0 text-[var(--color-outline)]">/</span>
          <GitBranch size={14} strokeWidth={1.75} aria-hidden="true" className={iconClassName} />
          <span className="truncate">{branch}</span>
        </>
      ) : null}
      {isWorktree ? (
        <Tooltip content={worktreeDetails} placement="top-start">
          <span
            data-testid="worktree-details-trigger"
            tabIndex={0}
            className={worktreeBadgeClassName}
          >
            {t('sidebar.worktree')}
          </span>
        </Tooltip>
      ) : null}
    </div>
  )
}
