import { describe, expect, it } from 'vitest'
import { parseWorkspaceDiff } from './workspaceDiffModel'
import {
  buildWorkspaceDiffWordRanges,
  highlightWorkspaceDiff,
} from './workspaceDiffHighlighter'

function findRowId(diff: string, text: string) {
  const files = parseWorkspaceDiff(diff)
  const row = files.flatMap((file) => file.rows).find((candidate) => candidate.text === text)
  expect(row).toBeDefined()
  return { files, rowId: row!.id }
}

describe('workspaceDiffHighlighter', () => {
  it('keeps TextMate grammar state across the rows in one diff hunk', async () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -0,0 +1,5 @@',
      '+const before = 1',
      '+/* start comment',
      '+continued comment',
      '+end comment */',
      '+const after = 2',
    ].join('\n')
    const { files, rowId } = findRowId(diff, 'continued comment')

    const result = await highlightWorkspaceDiff({ files, path: 'src/a.ts' })

    expect(result.engine).toBe('shiki')
    expect(result.tokensByRowId[rowId]).toEqual([
      expect.objectContaining({
        content: 'continued comment',
        color: 'var(--color-diff-syntax-comment)',
      }),
    ])
  })

  it('uses Codex-style TextMate scopes for TypeScript symbols', async () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -0,0 +1,2 @@',
      '+type ReviewState = { ready: boolean }',
      '+const reviewState: ReviewState = { ready: true }',
    ].join('\n')
    const { files, rowId } = findRowId(diff, 'type ReviewState = { ready: boolean }')

    const result = await highlightWorkspaceDiff({ files, path: 'src/a.ts' })
    const tokens = result.tokensByRowId[rowId] ?? []

    expect(tokens.some((token) => token.content.includes('type') && token.color === 'var(--color-diff-syntax-keyword)')).toBe(true)
    expect(tokens.some((token) => token.content.includes('ReviewState') && token.color === 'var(--color-diff-syntax-type)')).toBe(true)
  })

  it('marks only the changed words in paired deletion and addition lines', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-const label = formatUser(oldName)',
      '+const label = formatUser(newName)',
    ].join('\n')
    const files = parseWorkspaceDiff(diff)
    const rows = files[0]!.rows
    const oldRow = rows.find((row) => row.text.includes('oldName'))!
    const newRow = rows.find((row) => row.text.includes('newName'))!

    const ranges = buildWorkspaceDiffWordRanges(files)

    expect(ranges[oldRow.id]).toEqual([{ start: 25, end: 32 }])
    expect(ranges[newRow.id]).toEqual([{ start: 25, end: 32 }])
  })

  it('skips expensive word matching for very long lines', () => {
    const oldLine = `const value = '${'a'.repeat(1_001)}'`
    const newLine = `const value = '${'b'.repeat(1_001)}'`
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      `-${oldLine}`,
      `+${newLine}`,
    ].join('\n')

    expect(buildWorkspaceDiffWordRanges(parseWorkspaceDiff(diff))).toEqual({})
  })

  it('does not guess word pairs inside unequal replacement blocks', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1 @@',
      '-const before = firstValue',
      '-const target = oldName',
      '+const target = newName',
    ].join('\n')

    expect(buildWorkspaceDiffWordRanges(parseWorkspaceDiff(diff))).toEqual({})
  })

  it('skips word ranges when equal-sized replacement lines are not similar', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,2 @@',
      '-const first = one',
      '-const second = two',
      '+const second = two',
      '+const first = one',
    ].join('\n')

    expect(buildWorkspaceDiffWordRanges(parseWorkspaceDiff(diff))).toEqual({})
  })
})
