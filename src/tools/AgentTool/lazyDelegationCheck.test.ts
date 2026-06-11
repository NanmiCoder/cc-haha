import { describe, expect, test } from 'bun:test'
import {
  detectLazyDelegation,
  formatLazyDelegationError,
  isLazyDelegationCheckEnabled,
} from './lazyDelegationCheck.js'

describe('detectLazyDelegation', () => {
  test('passes specific, self-contained prompts', () => {
    expect(
      detectLazyDelegation(
        'Fix the null pointer in src/auth/validate.ts:42. Add a null check before user.id access.',
      ),
    ).toBeNull()
    expect(
      detectLazyDelegation('Run the tests in src/server and report which fail.'),
    ).toBeNull()
    expect(
      detectLazyDelegation('Investigate the auth module in src/auth/. Report findings.'),
    ).toBeNull()
  })

  test('catches "based on the findings"', () => {
    const m = detectLazyDelegation('Based on the findings, fix the auth bug.')
    expect(m).not.toBeNull()
    expect(m?.phrase.toLowerCase()).toContain('based on')
  })

  test('catches "based on your research"', () => {
    expect(
      detectLazyDelegation('Based on your research, implement the change.'),
    ).not.toBeNull()
  })

  test('catches "as the worker found"', () => {
    expect(
      detectLazyDelegation('As the worker found, the bug is in the session handler.'),
    ).not.toBeNull()
  })

  test('catches "per the previous worker"', () => {
    expect(
      detectLazyDelegation(
        'Per the previous worker, update the auth module. Apply the fix.',
      ),
    ).not.toBeNull()
  })

  test('catches "according to the findings"', () => {
    expect(
      detectLazyDelegation('According to the findings, refactor handleAuth.'),
    ).not.toBeNull()
  })

  test('catches "using the previous worker"', () => {
    expect(
      detectLazyDelegation('Using the previous worker context, continue the migration.'),
    ).not.toBeNull()
  })

  test('catches "follow up on the findings"', () => {
    expect(
      detectLazyDelegation('Follow up on the findings and make the fix.'),
    ).not.toBeNull()
  })

  test('catches "based on what you found"', () => {
    expect(
      detectLazyDelegation('Based on what you found in the previous run, apply the patch.'),
    ).not.toBeNull()
  })

  test('catches "implement the findings"', () => {
    expect(detectLazyDelegation('Implement the findings.')).not.toBeNull()
    expect(detectLazyDelegation('Implement the recommendations.')).not.toBeNull()
  })

  test('does not flag innocuous mentions of "findings"', () => {
    // "Report findings" describes the deliverable, not lazy delegation.
    expect(
      detectLazyDelegation('Investigate src/auth and report findings to the user.'),
    ).toBeNull()
    // Topic mention of "research" without "based on / per / using" framing.
    expect(
      detectLazyDelegation('Add a research-quality docstring to the public API.'),
    ).toBeNull()
  })

  test('case-insensitive', () => {
    expect(
      detectLazyDelegation('BASED ON THE FINDINGS, APPLY THE FIX.'),
    ).not.toBeNull()
    expect(
      detectLazyDelegation('Based On The Research, ship it.'),
    ).not.toBeNull()
  })
})

describe('formatLazyDelegationError', () => {
  test('mentions the matched phrase verbatim', () => {
    const match = detectLazyDelegation('Based on the findings, fix it.')!
    const msg = formatLazyDelegationError(match, 'Agent')
    expect(msg).toContain('Based on the findings')
  })

  test('mentions the agent tool name', () => {
    const match = detectLazyDelegation('Per the research, ship it.')!
    expect(formatLazyDelegationError(match, 'Task')).toContain('Task')
  })

  test('points at the env-var escape hatch', () => {
    const match = detectLazyDelegation('Based on the findings.')!
    const msg = formatLazyDelegationError(match, 'Agent')
    expect(msg).toContain('CLAUDE_CODE_LAZY_DELEGATION_CHECK')
  })

  test('asks the model to restate files/lines/change', () => {
    const match = detectLazyDelegation('Based on the research, fix it.')!
    const msg = formatLazyDelegationError(match, 'Agent')
    expect(msg.toLowerCase()).toContain('file')
    expect(msg.toLowerCase()).toContain('line')
  })
})

describe('isLazyDelegationCheckEnabled', () => {
  test('enabled by default', () => {
    const prev = process.env.CLAUDE_CODE_LAZY_DELEGATION_CHECK
    delete process.env.CLAUDE_CODE_LAZY_DELEGATION_CHECK
    try {
      expect(isLazyDelegationCheckEnabled()).toBe(true)
    } finally {
      if (prev !== undefined) {
        process.env.CLAUDE_CODE_LAZY_DELEGATION_CHECK = prev
      }
    }
  })

  test('disabled with =0', () => {
    const prev = process.env.CLAUDE_CODE_LAZY_DELEGATION_CHECK
    process.env.CLAUDE_CODE_LAZY_DELEGATION_CHECK = '0'
    try {
      expect(isLazyDelegationCheckEnabled()).toBe(false)
    } finally {
      if (prev === undefined) {
        delete process.env.CLAUDE_CODE_LAZY_DELEGATION_CHECK
      } else {
        process.env.CLAUDE_CODE_LAZY_DELEGATION_CHECK = prev
      }
    }
  })

  test('any other value keeps it enabled', () => {
    const prev = process.env.CLAUDE_CODE_LAZY_DELEGATION_CHECK
    process.env.CLAUDE_CODE_LAZY_DELEGATION_CHECK = '1'
    try {
      expect(isLazyDelegationCheckEnabled()).toBe(true)
    } finally {
      if (prev === undefined) {
        delete process.env.CLAUDE_CODE_LAZY_DELEGATION_CHECK
      } else {
        process.env.CLAUDE_CODE_LAZY_DELEGATION_CHECK = prev
      }
    }
  })
})
