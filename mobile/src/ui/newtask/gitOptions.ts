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
        detail: occupied ? '另一个工作树在用，可新开工作树从这里开始'
          : current ? '电脑当前分支'
            : branch.remote && !branch.local ? `远端分支 · ${branch.remoteRef ?? branch.name}` : '本地分支',
      }
    })
}

export function gitLaunchWarning(repo: RepositoryContext | null, branch: string | null, worktree: boolean): string | null {
  if (repo?.state !== 'ok' || worktree || !branch || branch === repo.currentBranch) return null
  const selected = repo.branches.find(item => item.name === branch)
  if (selected?.checkedOut) return '这个分支已被另一个工作树使用，请新开工作树或选择其他分支。'
  if (repo.dirty && !(repo.headCommit && selected?.commit === repo.headCommit))
    return '当前目录有未提交改动。发送任务时切换分支可能被 Git 拦下；可新开工作树。'
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
