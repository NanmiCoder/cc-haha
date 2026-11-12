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
          message: 'The computer did not return complete workspace status; refresh and retry.',
        }
      return { kind: status.changedFiles.length ? 'changes' : 'clean' }
    case 'not_git_repo':
      return { kind: 'not_git_repo' }
    case 'missing_workdir':
      return { kind: 'missing' }
    case 'error':
      return {
        kind: 'error',
        message: status.error || 'Cannot read workspace status; refresh and retry.',
      }
    default:
      return {
        kind: 'error',
        message: 'The computer returned unrecognized workspace status; refresh and retry.',
      }
  }
}
