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
    throw new Error('这个目录不存在，请检查电脑上的路径。')
  if (context.state !== 'ok')
    throw new Error(context.error || '暂时无法读取项目的 Git 状态，请重试。')
  if (
    explicitBranch &&
    !context.branches.some((branch) => branch.name === explicitBranch)
  )
    throw new Error('选择的分支已不在电脑上，请重新选择。')
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
    : '电脑默认目录'
  if (repo?.state === 'ok') {
    const shown = branch || repo.currentBranch
    return {
      name,
      ...(shown ? { branch: shown } : { status: '当前工作树' }),
      mode: worktree ? '新开工作树' : '当前目录',
    }
  }
  return { name, status: path && !repo ? '读取中…' : '无 Git 分支' }
}

/** Why branch and worktree choices are unavailable; null when the project is a readable Git repo. */
export function gitUnavailableReason(
  repo: RepositoryContext | null,
  path: string
): string | null {
  if (!path.trim()) return '先选择一个项目目录'
  if (!repo) return '正在读取 Git 状态…'
  switch (repo.state) {
    case 'ok':
      return null
    case 'not_git_repo':
      return '当前目录不是 Git 项目'
    case 'missing_workdir':
      return '这个目录不存在，请重新选择。'
    default:
      return repo.error || '暂时无法读取项目的 Git 状态，请重试。'
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
