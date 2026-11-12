import type { RepositoryContext } from '../../core/newTask'

export function gitBranchOptions(repo: RepositoryContext | null, query: string, worktree: boolean) {
  if (repo?.state !== 'ok') return []
  const search = query.trim().toLocaleLowerCase()
  return repo.branches.filter(branch => `${branch.name} ${branch.remoteRef ?? ''}`.toLocaleLowerCase().includes(search))
    .map(branch => {
      const current = branch.name === repo.currentBranch
      const occupied = Boolean(branch.checkedOut) && !current
      return {
        ...branch,
        current,
        disabled: occupied && !worktree,
        detail: occupied ? 'In use by another worktree; open a new worktree to start from here'
          : current ? 'Computer’s current branch'
            : branch.remote && !branch.local ? `Remote branch · ${branch.remoteRef ?? branch.name}` : 'Local branch',
      }
    })
}

export function gitLaunchWarning(repo: RepositoryContext | null, branch: string | null, worktree: boolean): string | null {
  if (repo?.state !== 'ok' || worktree || !branch || branch === repo.currentBranch) return null
  const selected = repo.branches.find(item => item.name === branch)
  if (selected?.checkedOut) return 'This branch is used by another worktree; open a new worktree or choose another branch.'
  if (repo.dirty && !(repo.headCommit && selected?.commit === repo.headCommit))
    return 'The current directory has uncommitted changes. Switching branches when sending the task may be blocked by Git; you can open a new worktree.'
  return null
}

export function worktreeBase(repo: RepositoryContext | null, branch: string | null): string | null {
  if (repo?.state !== 'ok') return null
  // The launch service excludes internal worktree branches from candidates.
  // Do not promise their HEAD when the server will fall back to a visible ref.
  const candidates = branch ? [branch] : [repo.currentBranch, repo.defaultBranch, repo.branches[0]?.name]
  return candidates.find(name => name && repo.branches.some(item => item.name === name)) ?? null
}

/** Returning to in-place mode must not retain an occupied branch selection. */
export function branchForWorktreeMode(repo: RepositoryContext | null, branch: string | null, enabled: boolean) {
  return !enabled && gitBranchOptions(repo, '', false).some(item => item.name === branch && item.disabled) ? null : branch
}
