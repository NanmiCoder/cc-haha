type Props = {
  workDir?: string | null
  repoName?: string | null
  branch?: string | null
  sourceWorkDir?: string | null
  isWorktree?: boolean
  worktreeSlug?: string | null
  worktreePath?: string | null
  compact?: boolean
}

function basename(path: string | null | undefined): string {
  return path?.split('/').filter(Boolean).pop() || ''
}

export function ProjectContextChip({
  workDir,
  repoName,
  branch,
  sourceWorkDir,
  isWorktree = false,
  worktreeSlug,
  worktreePath,
  compact = false,
}: Props) {
  const labelRoot = isWorktree ? (sourceWorkDir || workDir) : workDir
  const label = branch ? (repoName || basename(labelRoot)) : (basename(labelRoot) || repoName || '')
  const worktreeName = worktreeSlug || basename(worktreePath) || 'isolated'
  const title = [
    label,
    branch ? `branch: ${branch}` : null,
    isWorktree ? `worktree: ${worktreeName}` : null,
    worktreePath ? `worktree cwd: ${worktreePath}` : null,
    workDir ? `cwd: ${workDir}` : null,
  ].filter(Boolean).join('\n')

  if (!label) return null

  return (
    <div
      title={title}
      className={`inline-flex max-w-full items-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] text-[var(--color-text-secondary)] ${
        compact ? 'gap-1.5 px-3 py-1.5 text-xs' : 'gap-2 px-4 py-2 text-sm'
      }`}
    >
      {branch ? (
        <svg width={compact ? 15 : 18} height={compact ? 15 : 18} viewBox="0 0 16 16" fill="currentColor" className="shrink-0 text-[var(--color-text-secondary)]">
          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
        </svg>
      ) : (
        <span className={`material-symbols-outlined text-[var(--color-text-secondary)] ${compact ? 'text-[15px]' : 'text-[18px]'}`}>folder</span>
      )}
      <span className="truncate font-medium text-[var(--color-text-primary)]">{label}</span>
      {branch ? (
        <>
          <span className="text-[var(--color-text-tertiary)]">|</span>
          <span className="truncate">{branch}</span>
        </>
      ) : null}
      {isWorktree ? (
        <>
          <span className="text-[var(--color-text-tertiary)]">|</span>
          <span className="shrink-0 rounded-full border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] font-medium uppercase leading-none text-[var(--color-text-tertiary)]">
            worktree
          </span>
          <span className="max-w-[12rem] truncate">{worktreeName}</span>
        </>
      ) : null}
    </div>
  )
}
