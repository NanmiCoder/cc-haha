import { describe, expect, test } from 'bun:test'
import { applySentinelCorrection } from './sentinelCheck.js'

describe('applySentinelCorrection', () => {
  test('returns input unchanged when no sentinel is present', () => {
    const text = 'just some review prose with no machine verdict line.'
    const result = applySentinelCorrection(text)
    expect(result.mismatch).toBeNull()
    expect(result.correctedText).toBe(text)
  })

  test('returns input unchanged when verdict is already negative', () => {
    const text =
      '[CRITICAL] something is broken\nLocation: foo.ts:1\n\nREVIEW: CHANGES_NEEDED'
    const result = applySentinelCorrection(text)
    expect(result.mismatch).toBeNull()
    expect(result.correctedText).toBe(text)
  })

  test('returns input unchanged for clean APPROVE with no findings', () => {
    const text =
      'No actionable issues found in this small refactor.\n\nREVIEW: APPROVE'
    const result = applySentinelCorrection(text)
    expect(result.mismatch).toBeNull()
    expect(result.correctedText).toBe(text)
  })

  test('rewrites REVIEW: APPROVE to CHANGES_NEEDED when CRITICAL is present', () => {
    const text =
      '[CRITICAL] SQL injection in /api/users\nLocation: src/api.ts:42\n\nREVIEW: APPROVE'
    const result = applySentinelCorrection(text)
    expect(result.mismatch).toBe('review')
    expect(result.originalVerdict).toBe('APPROVE')
    expect(result.correctedVerdict).toBe('CHANGES_NEEDED')
    expect(result.correctedText).toContain('REVIEW: CHANGES_NEEDED')
    expect(result.correctedText).not.toMatch(/REVIEW:\s+APPROVE/)
    expect(result.correctedText).toContain('Sentinel mismatch corrected')
  })

  test('rewrites REVIEW: APPROVE when HIGH severity is present', () => {
    const text =
      'Looked over the change.\n\n[HIGH] Missing auth check on POST /admin\nLocation: src/router.ts:88\n\nREVIEW: APPROVE'
    const result = applySentinelCorrection(text)
    expect(result.mismatch).toBe('review')
    expect(result.correctedText).toContain('REVIEW: CHANGES_NEEDED')
  })

  test('rewrites SECURITY: PASS to CHANGES_NEEDED when CRITICAL is present', () => {
    const text =
      '[CRITICAL] Auth bypass on /api/admin\nAttack path: ...\n\nSECURITY: PASS'
    const result = applySentinelCorrection(text)
    expect(result.mismatch).toBe('security')
    expect(result.originalVerdict).toBe('PASS')
    expect(result.correctedVerdict).toBe('CHANGES_NEEDED')
    expect(result.correctedText).toContain('SECURITY: CHANGES_NEEDED')
    expect(result.correctedText).not.toMatch(/SECURITY:\s+PASS/)
  })

  test('does not flag prose that mentions [CRITICAL] mid-sentence', () => {
    // The finding pattern is line-anchored — prose like "if it were
    // [CRITICAL] we'd ..." should not trigger correction.
    const text =
      'No issues found. (For reference, a finding tagged [CRITICAL] in our scheme would block merge.)\n\nREVIEW: APPROVE'
    const result = applySentinelCorrection(text)
    expect(result.mismatch).toBeNull()
    expect(result.correctedText).toBe(text)
  })

  test('only rewrites the verdict line, leaving the findings intact', () => {
    const text =
      '[CRITICAL] data loss bug\nLocation: src/db.ts:10\nProblem: deletes wrong rows.\n\nREVIEW: APPROVE'
    const result = applySentinelCorrection(text)
    expect(result.mismatch).toBe('review')
    expect(result.correctedText).toContain('[CRITICAL] data loss bug')
    expect(result.correctedText).toContain('Location: src/db.ts:10')
  })

  test('handles trailing whitespace on the sentinel line', () => {
    const text = '[CRITICAL] foo\n\nREVIEW: APPROVE   '
    const result = applySentinelCorrection(text)
    expect(result.mismatch).toBe('review')
    expect(result.correctedText).toContain('REVIEW: CHANGES_NEEDED')
  })

  test('does not corrupt CHANGES_NEEDED with subsequent text after the sentinel', () => {
    // Ensures the regex doesn't greedily consume things past the verdict line.
    const text = '[CRITICAL] x\n\nREVIEW: APPROVE\n\n(internal trailer)'
    const result = applySentinelCorrection(text)
    expect(result.mismatch).toBe('review')
    expect(result.correctedText).toContain('REVIEW: CHANGES_NEEDED')
    expect(result.correctedText).toContain('(internal trailer)')
  })

  test('catches the first sentinel kind when multiple appear (review takes priority)', () => {
    // Spec is iterated in order; review comes before security in SENTINEL_SPECS.
    // (Workflows shouldn't emit both, but be defensive.)
    const text =
      '[CRITICAL] x\n\nREVIEW: APPROVE\n[HIGH] y\n\nSECURITY: PASS'
    const result = applySentinelCorrection(text)
    expect(result.mismatch).toBe('review')
  })
})
