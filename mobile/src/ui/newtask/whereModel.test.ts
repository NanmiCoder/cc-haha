import { describe, expect, test } from 'bun:test'
import type { RepositoryContext } from '../../core/newTask'
import {
  cancelRestore,
  recentProjectRows,
  targetAccessibility,
  targetLine,
  toggleWorktree,
  wherePageModel,
} from './whereModel'

const repo: RepositoryContext = {
  state: 'ok',
  currentBranch: 'main',
  defaultBranch: 'main',
  headCommit: 'a3f9c21deadbeef',
  dirty: false,
  branches: [
    { name: 'main', local: true, commit: 'a3f9c21' },
    { name: 'feat/qr-pair', local: true },
    { name: 'fix/ws-replay', local: true, checkedOut: true },
    { name: 'release', remote: true, local: false, remoteRef: 'origin/release' },
  ],
}
const model = (patch: Partial<Parameters<typeof wherePageModel>[0]> = {}) =>
  wherePageModel({ repo, path: '/Users/me/porthole', branch: null, worktree: false, query: '', ...patch })

describe('recent projects', () => {
  test('shows the home-abbreviated path and ticks only the current project', () => {
    const rows = recentProjectRows(
      [
        { realPath: '/Users/me/porthole', projectName: 'porthole' },
        { realPath: '/Users/me/cc-haha', projectName: 'cc-haha' },
      ],
      '/Users/me/cc-haha'
    )
    expect(rows.map((row) => [row.name, row.detail, row.selected])).toEqual([
      ['porthole', '~/porthole', false],
      ['cc-haha', '~/cc-haha', true],
    ])
    expect(rows[1].realPath).toBe('/Users/me/cc-haha')
  })
})

describe('branch section', () => {
  test('marks the computer branch as current and stays quiet about ordinary local branches', () => {
    const { rows } = model()
    expect(rows.find((row) => row.name === 'main')).toMatchObject({ current: true, detail: undefined })
    expect(rows.find((row) => row.name === 'feat/qr-pair')).toMatchObject({ current: false, detail: undefined })
    expect(rows.find((row) => row.name === 'release')?.detail).toContain('origin/release')
  })

  test('implicit selection ticks the follow row, an explicit branch ticks only that branch', () => {
    const implicit = model()
    expect(implicit.follow.selected).toBe(true)
    expect(implicit.rows.some((row) => row.selected)).toBe(false)
    const explicit = model({ branch: 'feat/qr-pair' })
    expect(explicit.follow.selected).toBe(false)
    expect(explicit.rows.filter((row) => row.selected).map((row) => row.name)).toEqual(['feat/qr-pair'])
  })

  test('follow row names the commit it stays on, or the base of a new worktree', () => {
    expect(model().follow).toMatchObject({ title: '沿用电脑当前提交', detail: '不切分支，停在电脑现在的位置 · a3f9c21' })
    expect(model({ worktree: true }).follow).toMatchObject({ title: '使用默认起始分支', detail: '新工作树基于 main' })
    expect(wherePageModel({ repo: { ...repo, headCommit: null }, path: '/p', branch: null, worktree: false, query: '' }).follow.detail).toBe('不切分支，停在电脑现在的位置')
  })

  test('search filters by branch name and remote ref, and says when nothing matches', () => {
    expect(model({ query: 'FIX' }).rows.map((row) => row.name)).toEqual(['fix/ws-replay'])
    expect(model({ query: ' origin/ ' }).rows.map((row) => row.name)).toEqual(['release'])
    const none = model({ query: 'zzz' })
    expect(none.rows).toEqual([])
    expect(none.noMatch).toBe(true)
    expect(model({ query: '' }).noMatch).toBe(false)
  })

  test('a branch another worktree holds is only selectable when starting a new worktree', () => {
    expect(model().rows.find((row) => row.name === 'fix/ws-replay')).toMatchObject({ disabled: true })
    expect(model({ worktree: true }).rows.find((row) => row.name === 'fix/ws-replay')).toMatchObject({ disabled: false })
    expect(model({ branch: 'fix/ws-replay' }).warning).toContain('另一个工作树')
  })

  test('unreadable or non-Git folders explain themselves instead of listing branches', () => {
    const loading = wherePageModel({ repo: null, path: '/p', branch: null, worktree: false, query: '' })
    expect(loading).toMatchObject({ reason: '正在读取 Git 状态…', canRetry: true, gitHidden: false })
    const plain = wherePageModel({ repo: { ...repo, state: 'not_git_repo', branches: [] }, path: '/p', branch: null, worktree: false, query: '' })
    expect(plain).toMatchObject({ reason: '当前目录不是 Git 项目', canRetry: false, gitHidden: true, rows: [] })
    const none = wherePageModel({ repo: null, path: '', branch: null, worktree: false, query: '' })
    expect(none.reason).toBe('先选择一个项目目录')
    expect(model().reason).toBeNull()
  })

  test('a repository without commits cannot host a worktree', () => {
    const empty = wherePageModel({ repo: { ...repo, headCommit: null, branches: [] }, path: '/p', branch: null, worktree: true, query: '' })
    expect(empty.worktree).toMatchObject({ on: false, disabled: true, detail: '仓库还没有提交，暂时无法创建工作树' })
    expect(model({ worktree: true, branch: 'feat/qr-pair' }).worktree).toMatchObject({
      on: true,
      disabled: false,
      detail: '发送时基于 feat/qr-pair 创建独立目录',
    })
  })
})

describe('worktree switch and cancel', () => {
  test('turning the worktree off drops a branch that only a worktree could use', () => {
    expect(toggleWorktree(repo, 'fix/ws-replay', false)).toEqual({ worktree: false, branch: null })
    expect(toggleWorktree(repo, 'fix/ws-replay', true)).toEqual({ worktree: true, branch: 'fix/ws-replay' })
    expect(toggleWorktree(repo, 'feat/qr-pair', false)).toEqual({ worktree: false, branch: 'feat/qr-pair' })
  })

  test('cancel restores only what changed, the directory first', () => {
    const before = { path: '/a', branch: null, worktree: false }
    expect(cancelRestore(before, before)).toEqual([])
    expect(cancelRestore(before, { ...before, branch: 'x' })).toEqual([{ type: 'branch', value: null }])
    expect(cancelRestore(before, { ...before, worktree: true })).toEqual([{ type: 'worktree', value: false }])
    // Changing the directory makes the page reset branch and worktree, so both are set again.
    expect(cancelRestore({ path: '/a', branch: 'x', worktree: true }, { path: '/b', branch: null, worktree: false })).toEqual([
      { type: 'path', value: '/a' },
      { type: 'branch', value: 'x' },
      { type: 'worktree', value: true },
    ])
  })
})

describe('compact target card', () => {
  test('one line: project, branch, and a note only for a new worktree', () => {
    expect(targetLine({ name: 'porthole', branch: 'main', status: undefined }, true)).toEqual({
      name: 'porthole',
      branch: 'main',
      status: undefined,
      note: '新工作树',
    })
    expect(targetLine({ name: 'porthole', branch: 'main' }, false).note).toBeUndefined()
  })

  test('without a branch the status stands in, and the label reads the same facts', () => {
    const line = targetLine({ name: 'notes', status: '无 Git 分支' }, false)
    expect(line).toMatchObject({ branch: undefined, status: '无 Git 分支' })
    expect(targetAccessibility(line)).toBe('位置：notes，无 Git 分支')
    expect(targetAccessibility(targetLine({ name: 'porthole', branch: 'main' }, true))).toBe('位置：porthole，main，新工作树')
    // A branch wins over a status that is no longer relevant.
    expect(targetLine({ name: 'a', branch: 'main', status: '读取中…' }, false).status).toBeUndefined()
  })
})
