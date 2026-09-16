import { describe, expect, it } from 'vitest'
import { layoutWorkspaceDiff } from './workspaceDiffLayout'
import { getCompatibleDiffRange, parseWorkspaceDiff } from './workspaceDiffModel'

const patch = '--- a/a\n+++ b/a\n@@ -3,3 +3,4 @@\n context\n-one\n-two\n+first\n+second\n+third\n'

describe('split diff layout', () => {
  it('pairs changed lines and preserves each original side and source line', () => {
    const rows = layoutWorkspaceDiff(parseWorkspaceDiff(patch), 'split')[0]!.rows
    const old = rows.find(row => row.text === 'one')!
    const next = rows.find(row => row.text === 'first')!
    expect(old.displayRow).toBe(next.displayRow)
    expect(old).toMatchObject({ displayColumn: 1, side: 'old', oldLine: 4 })
    expect(next).toMatchObject({ displayColumn: 2, side: 'new', newLine: 4 })
    const context = rows.filter(row => row.text === 'context')
    expect(context).toHaveLength(2)
    expect(context.map(row => row.side)).toEqual(['old', 'new'])
    const end = rows.find(row => row.text === 'second')!
    expect(getCompatibleDiffRange(rows, next.id, end.id)).toMatchObject({ side: 'new', lineStart: 4, lineEnd: 5, quote: 'first\nsecond' })
  })
})
