import { describe, expect, it } from 'vitest'
import { getCompatibleDiffRange, parseWorkspaceDiff } from './workspaceDiffModel'

const diff = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -10,2 +10,3 @@',
  ' const a = 1',
  '-const b = 2',
  '+const b = 3',
  '+const c = 4',
  '@@ -20 +21 @@',
  '-old tail',
  '+new tail',
].join('\n')

describe('parseWorkspaceDiff', () => {
  it('assigns source coordinates and sides to selectable hunk rows', () => {
    const file = parseWorkspaceDiff(diff)[0]!

    expect(file.rows.filter((row) => row.selectable).map((row) => ({
      kind: row.kind,
      oldLine: row.oldLine,
      newLine: row.newLine,
      side: row.side,
    }))).toEqual([
      { kind: 'context', oldLine: 10, newLine: 10, side: 'new' },
      { kind: 'deletion', oldLine: 11, newLine: null, side: 'old' },
      { kind: 'addition', oldLine: null, newLine: 11, side: 'new' },
      { kind: 'addition', oldLine: null, newLine: 12, side: 'new' },
      { kind: 'deletion', oldLine: 20, newLine: null, side: 'old' },
      { kind: 'addition', oldLine: null, newLine: 21, side: 'new' },
    ])
  })

  it('keeps malformed headers, binary markers, and no-newline markers as metadata', () => {
    const file = parseWorkspaceDiff([
      'diff --git a/image.png b/image.png',
      '--- a/image.png',
      '+++ b/image.png',
      '@@ malformed @@',
      'Binary files a/image.png and b/image.png differ',
      '\\ No newline at end of file',
    ].join('\n'))[0]!

    expect(file.rows).toHaveLength(5)
    expect(file.rows.every((row) => row.kind === 'metadata' && !row.selectable)).toBe(true)
  })

  it('keeps parsing a hunk after a no-newline marker', () => {
    const file = parseWorkspaceDiff([
      'diff --git a/a.txt b/a.txt',
      '@@ -1 +1 @@',
      '-before',
      '\\ No newline at end of file',
      '+after',
    ].join('\n'))[0]!

    expect(file.rows.map((row) => row.kind)).toEqual(['hunk', 'deletion', 'metadata', 'addition'])
    expect(file.rows[2]).toMatchObject({ selectable: false })
    expect(file.rows[3]).toMatchObject({ newLine: 1, side: 'new', selectable: true })
  })

  it('treats hunk content beginning with file-header markers as code', () => {
    const file = parseWorkspaceDiff([
      'diff --git a/docs/a.md b/docs/a.md',
      '--- a/docs/a.md',
      '+++ b/docs/a.md',
      '@@ -5,2 +5,2 @@',
      '--- old heading',
      '+++ new heading',
      ' tail',
    ].join('\n'))[0]!

    expect({ oldPath: file.oldPath, newPath: file.newPath }).toEqual({
      oldPath: 'docs/a.md',
      newPath: 'docs/a.md',
    })
    expect(file.rows.filter((row) => row.selectable).map((row) => ({
      kind: row.kind,
      text: row.text,
      oldLine: row.oldLine,
      newLine: row.newLine,
      side: row.side,
    }))).toEqual([
      { kind: 'deletion', text: '-- old heading', oldLine: 5, newLine: null, side: 'old' },
      { kind: 'addition', text: '++ new heading', oldLine: null, newLine: 5, side: 'new' },
      { kind: 'context', text: 'tail', oldLine: 6, newLine: 6, side: 'new' },
    ])
  })
})

describe('getCompatibleDiffRange', () => {
  it('normalizes forward and reverse ranges on the same hunk and side', () => {
    const file = parseWorkspaceDiff(diff)[0]!
    const newRows = file.rows.filter((row) => row.selectable && row.hunkId === 'file-0-hunk-0' && row.side === 'new')
    const expected = {
      hunkId: 'file-0-hunk-0',
      side: 'new',
      startId: newRows[0]!.id,
      endId: newRows[2]!.id,
      rowIds: newRows.map((row) => row.id),
      lineStart: 10,
      lineEnd: 12,
      quote: 'const a = 1\nconst b = 3\nconst c = 4',
    }

    expect(getCompatibleDiffRange(file.rows, newRows[0]!.id, newRows[2]!.id)).toEqual(expected)
    expect(getCompatibleDiffRange(file.rows, newRows[2]!.id, newRows[0]!.id)).toEqual(expected)
  })

  it('normalizes forward and reverse ranges on the old side', () => {
    const file = parseWorkspaceDiff([
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -30,3 +30 @@',
      '-old first',
      '-old second',
      '-old third',
      '+new value',
    ].join('\n'))[0]!
    const oldRows = file.rows.filter((row) => row.selectable && row.side === 'old')
    const expected = {
      hunkId: 'file-0-hunk-0',
      side: 'old',
      startId: oldRows[0]!.id,
      endId: oldRows[2]!.id,
      rowIds: oldRows.map((row) => row.id),
      lineStart: 30,
      lineEnd: 32,
      quote: 'old first\nold second\nold third',
    }

    expect(getCompatibleDiffRange(file.rows, oldRows[0]!.id, oldRows[2]!.id)).toEqual(expected)
    expect(getCompatibleDiffRange(file.rows, oldRows[2]!.id, oldRows[0]!.id)).toEqual(expected)
  })

  it('rejects ranges across sides or hunks', () => {
    const file = parseWorkspaceDiff(diff)[0]!
    const selectable = file.rows.filter((row) => row.selectable)
    const context = selectable.find((row) => row.kind === 'context')!
    const deletion = selectable.find((row) => row.kind === 'deletion')!
    const secondHunkAddition = selectable.find((row) => row.hunkId === 'file-0-hunk-1' && row.kind === 'addition')!

    expect(getCompatibleDiffRange(file.rows, context.id, deletion.id)).toBeNull()
    expect(getCompatibleDiffRange(file.rows, context.id, secondHunkAddition.id)).toBeNull()
  })
})
