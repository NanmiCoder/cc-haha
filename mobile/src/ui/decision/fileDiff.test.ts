import { expect, test } from 'bun:test'
import {
  EDIT_PREVIEW_LINES,
  WRITE_PREVIEW_LINES,
  fileChange,
  lineDiff,
  splitLines,
} from './fileDiff'

const kinds = (lines: { kind: string; text: string }[]) =>
  lines.map((line) => `${line.kind[0]}:${line.text}`)

test('Edit keeps unchanged lines as context and shows removed before added', () => {
  const change = fileChange('Edit', {
    file_path: 'src/core/sessionTransport.ts',
    old_string: '  for (const m of batch) {\n    const key = m.localId\n    seen.add(key)',
    new_string:
      '  for (const m of batch) {\n    // 重放带同一个 serverId\n    const key = m.serverId\n    seen.add(key)',
  })!
  expect(change.path).toBe('src/core/sessionTransport.ts')
  expect(kinds(change.lines)).toEqual([
    'c:  for (const m of batch) {',
    'r:    const key = m.localId',
    'a:    // 重放带同一个 serverId',
    'a:    const key = m.serverId',
    'c:    seen.add(key)',
  ])
  expect(change.added).toBe(2)
  expect(change.removed).toBe(1)
  // No line numbers are available from the tool input.
  expect(change.lines.every((line) => line.before === undefined && line.after === undefined)).toBe(true)
})

test('LCS keeps interleaved unchanged lines and handles pure insertions', () => {
  expect(kinds(lineDiff('a\nb\nc\nd', 'a\nx\nc\ny'))).toEqual([
    'c:a',
    'r:b',
    'a:x',
    'c:c',
    'r:d',
    'a:y',
  ])
  expect(kinds(lineDiff('', 'new\nlines\n'))).toEqual(['a:new', 'a:lines'])
  expect(kinds(lineDiff('gone\n', ''))).toEqual(['r:gone'])
  expect(splitLines('a\r\nb\n')).toEqual(['a', 'b'])
})

test('very large edits fall back to remove-all + add-all without quadratic work', () => {
  const before = Array.from({ length: 600 }, (_, i) => `old ${i}`).join('\n')
  const after = Array.from({ length: 600 }, (_, i) => `new ${i}`).join('\n')
  const lines = lineDiff(before, after)
  expect(lines.slice(0, 600).every((line) => line.kind === 'remove')).toBe(true)
  expect(lines.slice(600).every((line) => line.kind === 'add')).toBe(true)
  const change = fileChange('Edit', { file_path: 'x', old_string: before, new_string: after })!
  expect(change.lines).toHaveLength(EDIT_PREVIEW_LINES + 1)
  expect(change.lines.at(-1)).toEqual({ text: '还有 800 行', kind: 'meta' })
  expect(change.added).toBe(600)
  expect(change.removed).toBe(600)
})

test('MultiEdit renders one hunk header per edit and totals every segment', () => {
  const change = fileChange('MultiEdit', {
    file_path: 'a.ts',
    edits: [
      { old_string: 'one', new_string: 'uno' },
      null,
      { old_string: 'two', new_string: 'dos', replace_all: true },
    ],
  })!
  expect(kinds(change.lines)).toEqual([
    'h:@@ 第 1 处 @@',
    'r:one',
    'a:uno',
    'h:@@ 第 2 处（替换所有相同内容） @@',
    'r:two',
    'a:dos',
  ])
  expect([change.added, change.removed]).toEqual([2, 2])
})

test('Write is all additions and truncates long files with the remaining count', () => {
  const content = Array.from({ length: WRITE_PREVIEW_LINES + 5 }, (_, i) => `line ${i}`).join('\n')
  const change = fileChange('Write', { file_path: 'new.ts', content })!
  expect(change.lines).toHaveLength(WRITE_PREVIEW_LINES + 1)
  expect(change.lines.slice(0, -1).every((line) => line.kind === 'add')).toBe(true)
  expect(change.lines.at(-1)).toEqual({ text: '还有 5 行', kind: 'meta' })
  expect([change.added, change.removed]).toEqual([WRITE_PREVIEW_LINES + 5, 0])
})

test('NotebookEdit shows new cell content only and incomplete input yields no diff', () => {
  const change = fileChange('NotebookEdit', {
    notebook_path: 'a.ipynb',
    new_source: 'print(1)',
    edit_mode: 'insert',
  })!
  expect(change.path).toBe('a.ipynb')
  expect(kinds(change.lines)).toEqual(['h:@@ 新增单元格 @@', 'a:print(1)'])
  expect(
    kinds(fileChange('NotebookEdit', { notebook_path: 'a.ipynb', edit_mode: 'delete' })!.lines)
  ).toEqual(['h:@@ 删除这个单元格 @@'])
  expect(fileChange('Edit', { file_path: 'a', old_string: 'x' })).toBeNull()
  expect(fileChange('MultiEdit', { file_path: 'a', edits: [] })).toBeNull()
  expect(fileChange('Write', { file_path: 'a' })).toBeNull()
  expect(fileChange('Bash', { command: 'ls' })).toBeNull()
})
