import { expect, test } from 'bun:test'
import type { RepositoryContext } from '../../core/newTask'
import { branchForWorktreeMode, gitBranchOptions, gitLaunchWarning, worktreeBase } from './gitOptions'

const repo: RepositoryContext = {
  state: 'ok', currentBranch: 'main', headCommit: 'aaa', defaultBranch: 'main', dirty: true,
  branches: [
    { name: 'main', checkedOut: true, local: true, commit: 'aaa' },
    { name: 'same', local: true, commit: 'aaa' },
    { name: 'other', checkedOut: true, local: true, commit: 'bbb' },
    { name: 'feature', remote: true, local: false, remoteRef: 'origin/feature', commit: 'bbb' },
  ],
}
test('occupied branches are selectable only as an isolated worktree base', () => {
  expect(gitBranchOptions(repo, '', false).map(item => item.disabled)).toEqual([false, false, true, false])
  expect(gitBranchOptions(repo, '', true).every(item => !item.disabled)).toBe(true)
  expect(branchForWorktreeMode(repo, 'other', false)).toBeNull()
  expect(branchForWorktreeMode(repo, 'other', true)).toBe('other')
  expect(branchForWorktreeMode(repo, 'main', false)).toBe('main')
})
test('Git warnings reflect actual checkout changes rather than all dirty repositories', () => {
  expect(gitLaunchWarning(repo, null, false)).toBeNull()
  expect(gitLaunchWarning(repo, 'main', false)).toBeNull()
  expect(gitLaunchWarning(repo, 'same', false)).toBeNull()
  expect(gitLaunchWarning(repo, 'feature', false)).toContain('未提交')
  expect(gitLaunchWarning(repo, 'other', false)).toContain('另一个工作树')
  expect(gitLaunchWarning(repo, 'feature', true)).toBeNull()
})
test('branch search includes remote refs, and non-Git folders show no irrelevant options', () => {
  expect(gitBranchOptions(repo, ' ORIGIN/ ', false).map(item => item.name)).toEqual(['feature'])
  expect(gitBranchOptions({ ...repo, state: 'not_git_repo' }, '', false)).toEqual([])
})
test('detached HEAD isolation names the backend fallback without mutating implicit selection', () => {
  const detached = { ...repo, currentBranch: null }
  expect(worktreeBase(detached, null)).toBe('main')
  expect(worktreeBase(detached, 'feature')).toBe('feature')
  expect(branchForWorktreeMode(detached, null, true)).toBeNull()
})

test('worktree base skips hidden or deleted branch identities exactly like the launch service', () => {
  const linkedWorktree = { ...repo, currentBranch: 'worktree-desktop-main-abc', defaultBranch: 'worktree-desktop-main-abc' }
  expect(worktreeBase(linkedWorktree, null)).toBe('main')
  expect(worktreeBase({ ...linkedWorktree, defaultBranch: 'feature' }, null)).toBe('feature')
  expect(worktreeBase({ ...linkedWorktree, branches: [] }, null)).toBeNull()
  // An explicit stale selection must not silently turn into a different base.
  expect(worktreeBase(linkedWorktree, 'deleted')).toBeNull()
})
