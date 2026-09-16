import { describe, expect, it } from 'vitest'
import { splitReviewHunks } from './reviewHunks'

describe('review hunk extraction', () => {
  it('preserves exact EOL and no-final-newline markers while isolating each hunk', () => {
    const header = 'diff --git a/a b/a\n--- a/a\n+++ b/a\n'
    const first = '@@ -1 +1 @@\n-old\r\n+new\r\n'
    const second = '@@ -10 +10 @@\n-last\n+final\n\\ No newline at end of file\n'
    expect(splitReviewHunks(header + first + second)).toEqual([{ patch: header + first }, { patch: header + second }])
  })
  it('leaves rename, mode-only and empty-file changes to whole-file actions', () => {
    expect(splitReviewHunks('diff --git a/a b/b\nrename from a\nrename to b\n@@ -1 +1 @@\n-a\n+b\n')).toEqual([])
    expect(splitReviewHunks('diff --git a/a b/a\nnew file mode 100644\n')).toEqual([])
  })
})
