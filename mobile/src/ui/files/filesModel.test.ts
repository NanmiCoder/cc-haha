import { expect, test } from 'bun:test'
import {
  changedRowLabel,
  changedRows,
  dirState,
  filterChanged,
  matchesFile,
  parseFilesTab,
  searchRows,
  sortEntries,
  treeItems,
  type DirEntry,
  type DirState,
} from './filesModel'

const dir = (path: string): DirEntry => ({ name: path.split('/').pop()!, path, isDirectory: true })
const file = (path: string): DirEntry => ({ name: path.split('/').pop()!, path, isDirectory: false })

test('the tab parameter only opens all files for the exact value', () => {
  expect(parseFilesTab('all')).toBe('all')
  expect(parseFilesTab('changed')).toBe('changed')
  expect(parseFilesTab(undefined)).toBe('changed')
  expect(parseFilesTab('ALL')).toBe('changed')
})

test('changed rows split name and directory and leave unread diffs without a status', () => {
  const rows = changedRows(['src/core/connectHost.ts', 'README.md', 'src/app/scan.tsx'], (path) =>
    path === 'src/app/scan.tsx' ? { badge: 'A', added: 7, removed: 0 } : undefined
  )
  expect(rows).toEqual([
    { path: 'src/core/connectHost.ts', name: 'connectHost.ts', dir: 'src/core/', badge: undefined, added: undefined, removed: undefined },
    { path: 'README.md', name: 'README.md', dir: '', badge: undefined, added: undefined, removed: undefined },
    { path: 'src/app/scan.tsx', name: 'scan.tsx', dir: 'src/app/', badge: 'A', added: 7, removed: 0 },
  ])
  expect(changedRowLabel(rows[2]!)).toBe('src/app/scan.tsx，新增，增加 7 行')
  expect(changedRowLabel({ ...rows[0]!, badge: 'M', added: 9, removed: 4 })).toBe(
    'src/core/connectHost.ts，已修改，增加 9 行，删除 4 行'
  )
  expect(changedRowLabel(rows[1]!)).toBe('README.md')
})

test('file search needs every term, ignores case, and an empty query keeps everything', () => {
  expect(matchesFile('src/core/ConnectHost.ts', 'connecthost')).toBe(true)
  expect(matchesFile('src/core/ConnectHost.ts', 'core host')).toBe(true)
  expect(matchesFile('src/core/ConnectHost.ts', 'core scan')).toBe(false)
  expect(matchesFile('src/core/ConnectHost.ts', '   ')).toBe(true)
  const rows = changedRows(['src/a.ts', 'src/b.test.ts', 'docs/a.md'], () => undefined)
  expect(filterChanged(rows, 'a').map((r) => r.path)).toEqual(['src/a.ts', 'docs/a.md'])
  expect(filterChanged(rows, 'test').map((r) => r.path)).toEqual(['src/b.test.ts'])
  expect(filterChanged(rows, 'zzz')).toEqual([])
  expect(filterChanged(rows, '')).toHaveLength(3)
})

test('directory responses that are not ok become errors, never empty folders', () => {
  expect(dirState({ state: 'ok', entries: [] })).toEqual({ entries: [] })
  expect(dirState({ state: 'ok', entries: [file('a')] })).toEqual({ entries: [file('a')] })
  expect(dirState({ state: 'error', error: 'outside workspace' })).toEqual({ error: 'outside workspace' })
  expect(dirState({ state: 'missing' })).toEqual({ error: '目录无法读取' })
  expect(dirState({ state: 'ok' })).toEqual({ error: '目录无法读取' })
})

test('folders sort before files, then by natural name without case', () => {
  expect(
    sortEntries([file('b.md'), dir('Zeta'), file('A10.md'), file('A2.md'), dir('alpha')]).map((e) => e.name)
  ).toEqual(['alpha', 'Zeta', 'A2.md', 'A10.md', 'b.md'])
})

test('the tree puts an opened folder\'s children right after it, indented by depth', () => {
  const dirs: Record<string, DirState> = {
    '': { entries: [file('README.md'), dir('src'), dir('docs')] },
    src: { entries: [file('src/index.ts'), dir('src/core')] },
    'src/core': { entries: [file('src/core/a.ts')] },
  }
  const items = treeItems(dirs, new Set(['src', 'src/core']))
  expect(
    items.map((item) => (item.kind === 'entry' ? [item.depth, item.entry.path, item.open] : item.kind))
  ).toEqual([
    [0, 'docs', false],
    [0, 'src', true],
    [1, 'src/core', true],
    [2, 'src/core/a.ts', false],
    [1, 'src/index.ts', false],
    [0, 'README.md', false],
  ])
  // 没展开的文件夹，即使读过也不摊开；文件不会被当成展开。
  expect(treeItems(dirs, new Set()).map((i) => (i.kind === 'entry' ? i.entry.path : i.kind))).toEqual([
    'docs',
    'src',
    'README.md',
  ])
  expect(treeItems(dirs, new Set(['README.md'])).some((i) => i.kind === 'entry' && i.open)).toBe(false)
})

test('opened folders show loading, error with retry, or empty rows in place', () => {
  const dirs: Record<string, DirState> = {
    '': { entries: [dir('a'), dir('b'), dir('c'), dir('d')] },
    a: 'loading',
    b: { error: '读取失败' },
    c: { entries: [] },
  }
  const items = treeItems(dirs, new Set(['a', 'b', 'c', 'd']))
  expect(items.map((i) => (i.kind === 'entry' ? i.entry.path : `${i.kind}:${i.text}`))).toEqual([
    'a',
    'note:读取中…',
    'b',
    'note:读取失败，点按重试',
    'c',
    'note:空文件夹',
    'd',
    'note:读取中…',
  ])
  const failed = items.find((i) => i.kind === 'note' && i.tone === 'err')
  expect(failed).toMatchObject({ retry: 'b', depth: 1 })
  expect(treeItems({}, new Set())).toEqual([
    { kind: 'note', key: '\u0000loading', depth: 0, text: '读取中…', tone: 'ink3' },
  ])
})

test('search results keep files only and show name with directory', () => {
  expect(
    searchRows([file('src/core/a.ts'), dir('src/core'), file('README.md')])
  ).toEqual([
    { path: 'src/core/a.ts', name: 'a.ts', dir: 'src/core/' },
    { path: 'README.md', name: 'README.md', dir: '' },
  ])
})
