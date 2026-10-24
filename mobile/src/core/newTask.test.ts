import { expect, test } from 'bun:test'
import { newTaskRepository, type RepositoryContext } from './newTask'

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
  expect(() => newTaskRepository(context, 'gone', true)).toThrow('分支')
  expect(() =>
    newTaskRepository({ ...context, state: 'missing_workdir' }, null, false)
  ).toThrow('不存在')
  expect(
    newTaskRepository({ ...context, state: 'not_git_repo' }, null, false)
  ).toBeUndefined()
})
