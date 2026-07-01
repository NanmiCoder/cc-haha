import { afterEach, describe, expect, test } from 'bun:test'
import {
  assessTaskSpec,
  formatThinSpecError,
  isTaskSpecStrictEnabled,
} from './taskSpecQuality.js'

describe('assessTaskSpec', () => {
  test('a full brief is well-specified', () => {
    const a = assessTaskSpec(
      'Fix the null pointer in src/auth/validate.ts:42 — user.id is accessed before the null check. Add the guard, run the auth tests, and report the result.',
    )
    expect(a.hasConcreteAction).toBe(true)
    expect(a.hasFileReference).toBe(true)
    expect(a.hasSuccessCriteria).toBe(true)
    expect(a.hasAdequateDetail).toBe(true)
    expect(a.score).toBe(4)
    expect(a.quality).toBe('well-specified')
    expect(a.missing).toHaveLength(0)
  })

  test('action + file + criteria (short) is well-specified', () => {
    const a = assessTaskSpec(
      'Update `parseConfig` in config.ts so it returns null on empty input.',
    )
    expect(a.hasConcreteAction).toBe(true)
    expect(a.hasFileReference).toBe(true)
    expect(a.hasSuccessCriteria).toBe(true)
    expect(a.quality).toBe('well-specified')
  })

  test('bare fragment with no action is underspecified', () => {
    const a = assessTaskSpec('the auth thing')
    expect(a.hasConcreteAction).toBe(false)
    expect(a.quality).toBe('underspecified')
    expect(a.missing).toContain('a concrete action (what to do)')
  })

  test('"fix it" is underspecified (action only, no file/criteria/detail)', () => {
    const a = assessTaskSpec('fix it')
    expect(a.hasConcreteAction).toBe(true)
    expect(a.hasFileReference).toBe(false)
    expect(a.hasSuccessCriteria).toBe(false)
    expect(a.hasAdequateDetail).toBe(false)
    expect(a.quality).toBe('underspecified')
  })

  test('"run the test suite and report failures" is adequate', () => {
    const a = assessTaskSpec('Run the test suite and report which tests fail.')
    expect(a.hasConcreteAction).toBe(true)
    expect(a.hasSuccessCriteria).toBe(true) // "report"
    expect(a.quality === 'adequate' || a.quality === 'well-specified').toBe(true)
    expect(a.quality).not.toBe('underspecified')
  })

  test('action + file but no criteria, short → adequate (not underspecified)', () => {
    const a = assessTaskSpec('Rename foo in helpers.ts')
    expect(a.hasConcreteAction).toBe(true)
    expect(a.hasFileReference).toBe(true)
    expect(a.quality).toBe('adequate')
  })

  test('long detailed prose with action but no file is adequate', () => {
    const a = assessTaskSpec(
      'Investigate why new users intermittently see a blank dashboard after signing up. ' +
        'Walk the signup-to-dashboard flow and report where the data load can race. Do not modify files.',
    )
    expect(a.hasConcreteAction).toBe(true)
    expect(a.hasAdequateDetail).toBe(true)
    expect(a.quality).not.toBe('underspecified')
  })

  test('detects backticked code spans as file references', () => {
    const a = assessTaskSpec('Refactor `handleAuth` to early-return on expiry.')
    expect(a.hasFileReference).toBe(true)
  })

  test('detects bare filenames with known extensions', () => {
    expect(assessTaskSpec('update README.md with the new flag').hasFileReference).toBe(true)
    expect(assessTaskSpec('edit package.json scripts').hasFileReference).toBe(true)
  })

  test('does not treat ordinary prose as a file reference', () => {
    const a = assessTaskSpec('please look into the slow thing somewhere')
    expect(a.hasFileReference).toBe(false)
  })

  test('missing list enumerates exactly the absent dimensions', () => {
    const a = assessTaskSpec('investigate')
    // action present; file, criteria, detail all missing
    expect(a.hasConcreteAction).toBe(true)
    expect(a.missing).toEqual([
      'a file path or code symbol (where)',
      'a definition of done (what "complete" looks like)',
      'enough detail to act without the conversation',
    ])
  })

  test('empty / whitespace prompt is underspecified with no signals', () => {
    const a = assessTaskSpec('   ')
    expect(a.score).toBe(0)
    expect(a.quality).toBe('underspecified')
    expect(a.missing).toHaveLength(4)
  })

  test('handles nullish input defensively', () => {
    // @ts-expect-error testing defensive nullish path
    const a = assessTaskSpec(undefined)
    expect(a.quality).toBe('underspecified')
  })
})

describe('isTaskSpecStrictEnabled', () => {
  afterEach(() => {
    delete process.env.CLAUDE_CODE_COORDINATOR_TASK_SPEC_STRICT
  })

  test('off by default', () => {
    delete process.env.CLAUDE_CODE_COORDINATOR_TASK_SPEC_STRICT
    expect(isTaskSpecStrictEnabled()).toBe(false)
  })

  test('on only when exactly "1"', () => {
    process.env.CLAUDE_CODE_COORDINATOR_TASK_SPEC_STRICT = '1'
    expect(isTaskSpecStrictEnabled()).toBe(true)
    process.env.CLAUDE_CODE_COORDINATOR_TASK_SPEC_STRICT = 'true'
    expect(isTaskSpecStrictEnabled()).toBe(false)
    process.env.CLAUDE_CODE_COORDINATOR_TASK_SPEC_STRICT = '0'
    expect(isTaskSpecStrictEnabled()).toBe(false)
  })
})

describe('formatThinSpecError', () => {
  test('lists the missing dimensions and names the tool', () => {
    const a = assessTaskSpec('fix it')
    const msg = formatThinSpecError(a, 'Agent')
    expect(msg).toContain('Agent')
    for (const m of a.missing) {
      expect(msg).toContain(m)
    }
  })

  test('points at the opt-in env flag', () => {
    const a = assessTaskSpec('do the thing')
    const msg = formatThinSpecError(a, 'Task')
    expect(msg).toContain('CLAUDE_CODE_COORDINATOR_TASK_SPEC_STRICT')
  })

  test('does not embed key="value" attribute-style fragments', () => {
    const a = assessTaskSpec('fix it')
    const msg = formatThinSpecError(a, 'Agent')
    expect(msg).not.toMatch(/[a-z_][a-z0-9_]*\s*=\s*"/i)
  })
})
