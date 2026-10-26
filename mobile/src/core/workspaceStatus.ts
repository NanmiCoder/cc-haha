export type WorkspaceStatusSummary =
  | { kind: 'clean' | 'changes' | 'not_git_repo' | 'missing' | 'unavailable' }
  | { kind: 'error'; message: string }

/** An empty list is only a clean workspace when the server completed its status read. */
export function summarizeWorkspaceStatus(
  status: {
    state: string
    changedFiles?: readonly unknown[]
    error?: string
  } | null
): WorkspaceStatusSummary {
  if (!status) return { kind: 'unavailable' }
  switch (status.state) {
    case 'ok':
      if (!Array.isArray(status.changedFiles))
        return {
          kind: 'error',
          message: '电脑未返回完整的工作区状态，请刷新重试。',
        }
      return { kind: status.changedFiles.length ? 'changes' : 'clean' }
    case 'not_git_repo':
      return { kind: 'not_git_repo' }
    case 'missing_workdir':
      return { kind: 'missing' }
    case 'error':
      return {
        kind: 'error',
        message: status.error || '无法读取工作区状态，请刷新重试。',
      }
    default:
      return {
        kind: 'error',
        message: '电脑返回了无法识别的工作区状态，请刷新重试。',
      }
  }
}
