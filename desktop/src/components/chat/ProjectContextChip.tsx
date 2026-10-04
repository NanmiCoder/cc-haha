import { GitFork } from 'lucide-react'
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

  const gitIcon = (
    <svg
      width={isToolbar ? 15 : compact ? 15 : 18}
      height={isToolbar ? 15 : compact ? 15 : 18}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      className={`shrink-0 ${isToolbar ? 'text-[var(--color-text-tertiary)]' : 'text-[var(--color-text-secondary)]'}`}
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )

  if (isToolbar) {
    return (
      <div
        title={isWorktree ? undefined : title}
        data-testid="run-location-readonly"
        className="inline-flex h-9 min-w-0 max-w-full shrink items-center gap-1.5 text-[13px] font-medium leading-none"
      >
        {showBranch || isWorktree ? gitIcon : (
          <span aria-hidden="true" className="material-symbols-outlined shrink-0 text-[17px] text-[var(--color-text-tertiary)]">folder</span>
        )}
        <span className="min-w-[1.75rem] shrink truncate text-[var(--color-text-primary)]">{label}</span>
        {showBranch && (
          <>
            <span aria-hidden="true" className="shrink-0 text-[var(--color-outline-variant)]">/</span>
            {/* Ellipsis at the start so the branch keeps its tail — see the pill.
                `shrink-[4]`: the two used to shrink in step, so a narrow column
                took both down together and left `cc-…/…n` — two truncations,
                neither readable. The project name is the one that identifies
                the row, so the branch gives up its width first. */}
            <span dir="rtl" className="min-w-0 shrink-[4] truncate text-left text-[var(--color-text-secondary)]">
              <bdi>{branch}</bdi>
            </span>
          </>
        )}
        {isWorktree && (
          <Tooltip content={worktreeDetails} placement="top-start">
            <span
              data-testid="worktree-details-trigger"
              tabIndex={0}
              className="inline-flex shrink-0 cursor-help items-center gap-1 rounded-[5px] bg-[var(--color-brand-soft)] px-1.5 py-1 text-[10px] font-bold leading-none text-[var(--color-brand)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)]"
            >
              <GitFork size={11} aria-hidden="true" />
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
      className={`inline-flex max-w-full items-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] text-[var(--color-text-secondary)] ${
        compact ? 'gap-1.5 px-3 py-1.5 text-xs' : 'gap-2 px-4 py-2 text-sm'
      }`}
    >
      {showBranch ? gitIcon : (
        <span className={`material-symbols-outlined text-[var(--color-text-secondary)] ${compact ? 'text-[15px]' : 'text-[18px]'}`}>folder</span>
      )}
      <span className="truncate font-medium text-[var(--color-text-primary)]">{label}</span>
      {showBranch ? (
        <>
          <span className="text-[var(--color-text-tertiary)]">|</span>
          <span className="truncate">{branch}</span>
        </>
      ) : null}
      {isWorktree ? (
        <>
          <span className="text-[var(--color-text-tertiary)]">|</span>
          <Tooltip content={worktreeDetails} placement="top-start">
            <span
              data-testid="worktree-details-trigger"
              tabIndex={0}
              className="shrink-0 cursor-help rounded-full border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] font-medium uppercase leading-none text-[var(--color-text-tertiary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)]"
            >
              {t('sidebar.worktree')}
            </span>
          </Tooltip>
        </>
      ) : null}
    </div>
  )
}
