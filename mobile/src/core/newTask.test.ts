import { expect, test } from 'bun:test'
import {
  branchChoices,
  displayPath,
  gitUnavailableReason,
  newTaskRepository,
  projectChoices,
  projectNameFromPath,
  targetSummary,
  type RepositoryContext,
} from './newTask'

const context: RepositoryContext = {
  state: 'ok',
  currentBranch: 'changed-on-desktop',
  branches: [{ name: 'main' }, { name: 'changed-on-desktop' }],
  dirty: true,
}
test('implicit checkout follows the actual desktop state without switching or breaking detached HEAD', () => {
  expect(newTaskRepository(context, null, false)).toBeUndefined()
  expect(
    newTaskRepository({ ...context, currentBranch: null }, null, false)
  ).toBeUndefined()
})
test('explicit branch and isolated worktree use the real launch contract', () => {
  expect(newTaskRepository(context, 'main', false)).toEqual({
    branch: 'main',
    worktree: false,
  })
  expect(newTaskRepository(context, 'main', true)).toEqual({
    branch: 'main',
    worktree: true,
  })
  expect(newTaskRepository(context, null, true)).toEqual({ worktree: true })
})
test('deleted branches and missing directories block creation, non-git projects remain supported', () => {
  expect(() => newTaskRepository(context, 'gone', true)).toThrow('branch')
  expect(() =>
    newTaskRepository({ ...context, state: 'missing_workdir' }, null, false)
  ).toThrow('does not exist')
  expect(
    newTaskRepository({ ...context, state: 'not_git_repo' }, null, false)
  ).toBeUndefined()
})

test('typed directories join the recent list once and keep a readable name', () => {
  const projects = [{ realPath: '/Users/me/code/app', projectName: 'app' }]
  expect(projectChoices(projects, '')).toBe(projects)
  expect(projectChoices(projects, '/Users/me/code/app')).toBe(projects)
  expect(projectChoices(projects, '/srv/tools/')).toEqual([
    { realPath: '/srv/tools/', projectName: 'tools' },
    ...projects,
  ])
  expect(projectNameFromPath('C:\\work\\site')).toBe('site')
})

test('home directories are abbreviated for display only', () => {
  expect(displayPath('/Users/me/code/cc-haha/mobile')).toBe(
    '~/code/cc-haha/mobile'
  )
  expect(displayPath('/home/dev')).toBe('~')
  expect(displayPath('C:\\Users\\me\\site')).toBe('~\\site')
  expect(displayPath('/Users')).toBe('/Users')
  expect(displayPath('/srv/Users/me')).toBe('/srv/Users/me')
})

test('target summary reflects the checkout that will actually be used', () => {
  const projects = [{ realPath: '/p', projectName: 'porthole' }]
  const base = { path: '/p', projects, branch: null, worktree: false }
  expect(targetSummary({ ...base, repo: context })).toEqual({
    name: 'porthole',
    branch: 'changed-on-desktop',
    mode: 'Current directory',
  })
  expect(
    targetSummary({ ...base, repo: context, branch: 'main', worktree: true })
  ).toEqual({ name: 'porthole', branch: 'main', mode: 'New worktree' })
  expect(
    targetSummary({ ...base, repo: { ...context, currentBranch: null } })
  ).toEqual({ name: 'porthole', status: 'Current worktree', mode: 'Current directory' })
  expect(targetSummary({ ...base, repo: null })).toEqual({
    name: 'porthole',
    status: 'Loading…',
  })
  expect(
    targetSummary({ ...base, repo: { ...context, state: 'not_git_repo' } })
  ).toEqual({ name: 'porthole', status: 'No Git branch' })
  expect(targetSummary({ ...base, path: '', repo: null })).toEqual({
    name: 'Computer default directory',
    status: 'No Git branch',
  })
})

test('branch and worktree choices explain why they are unavailable', () => {
  expect(gitUnavailableReason(context, '/p')).toBeNull()
  expect(gitUnavailableReason(context, ' ')).toContain('project')
  expect(gitUnavailableReason(null, '/p')).toContain('Read')
  expect(
    gitUnavailableReason({ ...context, state: 'not_git_repo' }, '/p')
  ).toBe('The current directory is not a Git project')
  expect(
    gitUnavailableReason({ ...context, state: 'missing_workdir' }, '/p')
  ).toContain('does not exist')
  expect(
    gitUnavailableReason({ ...context, state: 'error', error: 'boom' }, '/p')
  ).toBe('boom')
})

test('branch rows mark the current branch and branches held by another worktree', () => {
  expect(
    branchChoices({
      ...context,
      currentBranch: 'main',
      branches: [
        { name: 'main', current: true, checkedOut: true },
        { name: 'feat/a' },
        { name: 'fix/b', checkedOut: true, worktreePath: '/wt/b' },
      ],
    })
  ).toEqual([
    { name: 'main', current: true, occupied: false },
    { name: 'feat/a', current: false, occupied: false },
    { name: 'fix/b', current: false, occupied: true },
  ])
  expect(branchChoices({ ...context, state: 'not_git_repo' })).toEqual([])
  expect(branchChoices(null)).toEqual([])
})
