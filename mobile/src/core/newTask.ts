import type { CreateSessionInput } from './types'

export type RecentProject = {
  realPath: string
  projectName: string
  branch?: string
}
export type RepositoryContext = {
  state: 'ok' | 'not_git_repo' | 'missing_workdir' | 'error'
  currentBranch: string | null
  defaultBranch?: string | null
  headCommit?: string | null
  dirty?: boolean
  branches: {
    name: string
    current?: boolean
    checkedOut?: boolean
    worktreePath?: string
    local?: boolean
    remote?: boolean
    remoteRef?: string
    commit?: string
  }[]
  error?: string
}

/** Omit an implicit branch so a draft never switches a checkout that changed elsewhere. */
export function newTaskRepository(
  context: RepositoryContext | null,
  explicitBranch: string | null,
  worktree: boolean
): CreateSessionInput['repository'] {
  if (!context || context.state === 'not_git_repo') return undefined
  if (context.state === 'missing_workdir')
    throw new Error('This directory does not exist; check the path on the computer.')
  if (context.state !== 'ok')
    throw new Error(context.error || 'Cannot read the project Git status right now; please retry.')
  if (
    explicitBranch &&
    !context.branches.some((branch) => branch.name === explicitBranch)
  )
    throw new Error('The selected branch is no longer on the computer; please choose again.')
  if (!worktree && !explicitBranch) return undefined
  return { ...(explicitBranch ? { branch: explicitBranch } : {}), worktree }
}

export const projectNameFromPath = (path: string) =>
  path.split(/[\\/]/).filter(Boolean).at(-1) || path

/** Recent projects, with a typed directory listed first when it is not one of them. */
export function projectChoices(
  projects: RecentProject[],
  path: string
): RecentProject[] {
  return !path || projects.some((project) => project.realPath === path)
    ? projects
    : [{ realPath: path, projectName: projectNameFromPath(path) }, ...projects]
}

/** Display-only home abbreviation; the real path is still what the computer receives. */
export function displayPath(path: string) {
  return path
    .replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~')
    .replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/, '~')
}

/** What the target card says about where the task will run. */
export function targetSummary({
  path,
  projects,
  repo,
  branch,
  worktree,
}: {
  path: string
  projects: RecentProject[]
  repo: RepositoryContext | null
  branch: string | null
  worktree: boolean
}): { name: string; branch?: string; status?: string; mode?: string } {
  const name = path
    ? (projects.find((project) => project.realPath === path)?.projectName ??
      projectNameFromPath(path))
    : 'Computer default directory'
  if (repo?.state === 'ok') {
    const shown = branch || repo.currentBranch
    return {
      name,
      ...(shown ? { branch: shown } : { status: 'Current worktree' }),
      mode: worktree ? 'New worktree' : 'Current directory',
    }
  }
  return { name, status: path && !repo ? 'Loading…' : 'No Git branch' }
}

/** Why branch and worktree choices are unavailable; null when the project is a readable Git repo. */
export function gitUnavailableReason(
  repo: RepositoryContext | null,
  path: string
): string | null {
  if (!path.trim()) return 'Choose a project directory first'
  if (!repo) return 'Reading Git status…'
  switch (repo.state) {
    case 'ok':
      return null
    case 'not_git_repo':
      return 'The current directory is not a Git project'
    case 'missing_workdir':
      return 'This directory does not exist; please choose again.'
    default:
      return repo.error || 'Cannot read the project Git status right now; please retry.'
  }
}

/** Branch rows: the computer's current branch, and branches another worktree has checked out. */
export function branchChoices(repo: RepositoryContext | null) {
  if (repo?.state !== 'ok') return []
  return repo.branches.map((item) => ({
    name: item.name,
    current: Boolean(item.current) || item.name === repo.currentBranch,
    occupied: Boolean(item.checkedOut) && item.name !== repo.currentBranch,
  }))
}
