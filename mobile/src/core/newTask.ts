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
  dirty?: boolean
  branches: {
    name: string
    current?: boolean
    checkedOut?: boolean
    worktreePath?: string
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
