import {
  displayPath,
  gitUnavailableReason,
  type RecentProject,
  type RepositoryContext,
} from '../../core/newTask'
import { branchForWorktreeMode, gitBranchOptions, gitLaunchWarning, worktreeBase } from './gitOptions'

export type WhereDraft = { path: string; branch: string | null; worktree: boolean }

/** "Recent projects" on the location page: name + abbreviated path, with the current one checked. */
export function recentProjectRows(projects: RecentProject[], path: string) {
  return projects.map((project) => ({
    key: project.realPath,
    realPath: project.realPath,
    name: project.projectName,
    detail: displayPath(project.realPath),
    selected: project.realPath === path,
  }))
}

/**
 * All derived state of the "Branch" section on the location page: unavailable reason, keep/default rows, filtered branch rows, hints, worktree toggle.
 * Search matches both branch names and remote refs.
 */
export function wherePageModel({
  repo,
  path,
  branch,
  worktree,
  query,
}: {
  repo: RepositoryContext | null
  path: string
  branch: string | null
  worktree: boolean
  query: string
}) {
  const reason = gitUnavailableReason(repo, path)
  const ok = repo?.state === 'ok'
  const noCommits = ok && repo.headCommit === null
  const short = ok && repo.headCommit ? repo.headCommit.slice(0, 7) : null
  const base = worktreeBase(repo, null)
  const rows = gitBranchOptions(repo, query, worktree).map((option) => ({
    name: option.name,
    current: option.current,
    selected: branch === option.name,
    disabled: option.disabled,
    // The current branch is marked "Current"; others only get a subline when there is something to say (in use, remote).
    detail: option.current || option.detail === 'Local branch' ? undefined : option.detail,
  }))
  return {
    reason,
    /** Non-Git projects have no branches to choose, so no "Retry" is needed. */
    canRetry: Boolean(reason) && repo?.state !== 'not_git_repo',
    /** Non-Git directories hide branch and worktree entirely; other unavailable reasons (loading, error) show a description. */
    gitHidden: repo?.state === 'not_git_repo',
    follow: {
      title: worktree ? 'Use the default base branch' : 'Keep the computer’s current commit',
      detail: worktree
        ? `New worktree based on ${base ?? 'Available branches'}`
        : ['Do not switch branch, stay where the computer is now', short].filter(Boolean).join(' · '),
      selected: !branch,
    },
    rows,
    noMatch: Boolean(query.trim()) && ok && rows.length === 0,
    warning: gitLaunchWarning(repo, branch, worktree),
    worktree: {
      on: worktree && !noCommits,
      disabled: noCommits,
      detail: noCommits
        ? 'The repo has no commits yet, so a worktree cannot be created yet'
        : worktree
          ? `Creates a separate directory from ${worktreeBase(repo, branch) ?? 'the selected branch'} when sending`
          : 'Work in a separate directory, keeping the computer’s current changes',
    },
  }
}

/** Toggle the worktree switch: when returning to current directory mode, drop branches only usable in a worktree (in use). */
export function toggleWorktree(repo: RepositoryContext | null, branch: string | null, enabled: boolean) {
  return { worktree: enabled, branch: branchForWorktreeMode(repo, branch, enabled) }
}

/**
 * What "Cancel" restores: in the order path → branch → worktree, restoring only what changed.
 * Path goes first because changing directory makes the new task page reset the branch.
 */
export function cancelRestore(snapshot: WhereDraft, current: WhereDraft) {
  const steps: ({ type: 'path'; value: string } | { type: 'branch'; value: string | null } | { type: 'worktree'; value: boolean })[] = []
  if (snapshot.path !== current.path) steps.push({ type: 'path', value: snapshot.path })
  // After switching back to the original directory the page resets the branch, so when the path changed the branch must be set again regardless.
  if (snapshot.path !== current.path || snapshot.branch !== current.branch) steps.push({ type: 'branch', value: snapshot.branch })
  if (snapshot.worktree !== current.worktree || snapshot.path !== current.path) steps.push({ type: 'worktree', value: snapshot.worktree })
  return steps
}

/** Content of the compact target card at the top of new task: project name · branch · "new worktree". */
export function targetLine(target: { name: string; branch?: string; status?: string }, worktree: boolean) {
  return {
    name: target.name,
    branch: target.branch,
    status: target.branch ? undefined : target.status,
    note: worktree ? 'New worktree' : undefined,
  }
}

/** Accessibility announcement of the target card. */
export function targetAccessibility(line: ReturnType<typeof targetLine>) {
  return `Location: ${[line.name, line.branch ?? line.status, line.note].filter(Boolean).join(', ')}`
}
