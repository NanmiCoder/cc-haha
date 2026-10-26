import { describe, expect, test } from 'bun:test'
import { summarizeWorkspaceStatus } from './workspaceStatus'

describe('workspace status response handling', () => {
  test('a missing work directory is not a clean workspace despite its empty changedFiles', () => {
    expect(
      summarizeWorkspaceStatus({ state: 'missing_workdir', changedFiles: [] })
    ).toEqual({ kind: 'missing' })
  })

  test('a failed status read preserves the server error despite its empty changedFiles', () => {
    expect(
      summarizeWorkspaceStatus({
        state: 'error',
        changedFiles: [],
        error: 'Permission denied',
      })
    ).toEqual({ kind: 'error', message: 'Permission denied' })
    expect(
      summarizeWorkspaceStatus({ state: 'error', changedFiles: [] }).kind
    ).toBe('error')
  })

  test('a non-Git directory remains a file workspace', () => {
    expect(
      summarizeWorkspaceStatus({ state: 'not_git_repo', changedFiles: [] })
    ).toEqual({ kind: 'not_git_repo' })
  })

  test('only a successful status with no changes is clean', () => {
    expect(summarizeWorkspaceStatus({ state: 'ok', changedFiles: [] })).toEqual(
      { kind: 'clean' }
    )
    expect(
      summarizeWorkspaceStatus({
        state: 'ok',
        changedFiles: [
          { path: 'README.md', status: 'modified', additions: 1, deletions: 0 },
        ],
      })
    ).toEqual({ kind: 'changes' })
  })

  test('an unavailable or incomplete response never implies a clean workspace', () => {
    expect(summarizeWorkspaceStatus(null)).toEqual({ kind: 'unavailable' })
    expect(summarizeWorkspaceStatus({ state: 'ok' }).kind).toBe('error')
    expect(
      summarizeWorkspaceStatus({ state: 'future-state', changedFiles: [] }).kind
    ).toBe('error')
  })
})
