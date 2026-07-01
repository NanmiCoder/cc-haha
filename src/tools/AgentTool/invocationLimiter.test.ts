import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  _getLimiterStateSnapshot,
  _resetLimiterState,
  formatLimitExceededMessage,
  formatNearLimitWarning,
  getLimitFor,
  isLimiterDisabled,
  noteInvocation,
  noteOutcome,
  parseVerdict,
} from './invocationLimiter.js'
import { getSessionId } from '../../bootstrap/state.js'

describe('invocationLimiter', () => {
  beforeEach(() => {
    _resetLimiterState()
  })

  afterEach(() => {
    _resetLimiterState()
    delete process.env.CLAUDE_CODE_AGENT_LIMITER_OFF
    delete process.env.CLAUDE_CODE_AGENT_LIMIT_VERIFICATION
    delete process.env.CLAUDE_CODE_AGENT_LIMIT_CODE_REVIEWER
  })

  test('default cap for verification is 12', () => {
    expect(getLimitFor('verification')).toBe(12)
  })

  test('default cap for fork is 10', () => {
    expect(getLimitFor('fork')).toBe(10)
  })

  test('default cap for unknown specialist is 8', () => {
    expect(getLimitFor('code-reviewer')).toBe(8)
    expect(getLimitFor('debugger')).toBe(8)
    expect(getLimitFor('docs-writer')).toBe(8)
  })

  test('env override raises the cap for a specific type', () => {
    process.env.CLAUDE_CODE_AGENT_LIMIT_CODE_REVIEWER = '20'
    expect(getLimitFor('code-reviewer')).toBe(20)
  })

  test('env override translates dashes to underscores in the var name', () => {
    process.env.CLAUDE_CODE_AGENT_LIMIT_CODE_REVIEWER = '12'
    expect(getLimitFor('code-reviewer')).toBe(12)
  })

  test('non-numeric or zero env override falls back to default', () => {
    process.env.CLAUDE_CODE_AGENT_LIMIT_VERIFICATION = 'abc'
    expect(getLimitFor('verification')).toBe(12)
    process.env.CLAUDE_CODE_AGENT_LIMIT_VERIFICATION = '0'
    expect(getLimitFor('verification')).toBe(12)
    process.env.CLAUDE_CODE_AGENT_LIMIT_VERIFICATION = '-3'
    expect(getLimitFor('verification')).toBe(12)
  })

  test('isLimiterDisabled tracks env var', () => {
    expect(isLimiterDisabled()).toBe(false)
    process.env.CLAUDE_CODE_AGENT_LIMITER_OFF = '1'
    expect(isLimiterDisabled()).toBe(true)
  })

  test('noteInvocation increments and reports capped after threshold', () => {
    // verification cap = 12 (raised from 5)
    for (let i = 1; i <= 12; i++) {
      const r = noteInvocation('verification')
      expect(r.count).toBe(i)
      expect(r.limit).toBe(12)
      expect(r.capped).toBe(false)
      expect(r.cappedReason).toBe('none')
    }
    const r13 = noteInvocation('verification')
    expect(r13.count).toBe(13)
    expect(r13.capped).toBe(true)
    expect(r13.cappedReason).toBe('total')
  })

  test('counters are independent per agent type', () => {
    noteInvocation('verification')
    noteInvocation('verification')
    noteInvocation('code-reviewer')
    const snap = _getLimiterStateSnapshot(getSessionId())
    expect(snap?.total.get('verification')).toBe(2)
    expect(snap?.total.get('code-reviewer')).toBe(1)
    // No outcomes recorded yet, so streaks are unset (or 0).
    expect(snap?.failStreak.get('verification') ?? 0).toBe(0)
  })

  test('formatLimitExceededMessage (total cap) includes the counter, cap, and env hint', () => {
    const msg = formatLimitExceededMessage('code-reviewer', {
      count: 9,
      limit: 8,
      failStreak: 0,
      failStreakLimit: 3,
      capped: true,
      cappedReason: 'total',
      nearLimit: false,
    })
    expect(msg).toContain("'code-reviewer'")
    expect(msg).toContain('9 times')
    expect(msg).toContain('cap of 8')
    expect(msg).toContain('CLAUDE_CODE_AGENT_LIMIT_CODE_REVIEWER')
    expect(msg).toContain('CLAUDE_CODE_AGENT_LIMITER_OFF=1')
  })

  test('formatLimitExceededMessage (streak) explains the verifier-loop pattern', () => {
    const msg = formatLimitExceededMessage('verification', {
      count: 4,
      limit: 12,
      failStreak: 3,
      failStreakLimit: 3,
      capped: true,
      cappedReason: 'streak',
      nearLimit: false,
    })
    expect(msg).toContain("'verification'")
    expect(msg).toContain('FAIL 3 times in a row')
    expect(msg).toContain('streak cap is 3')
    expect(msg).toContain('PASS verdict from this agent type clears the streak')
    expect(msg).toContain('CLAUDE_CODE_AGENT_LIMIT_VERIFICATION')
  })

  test('nearLimit fires once on the last allowed invocation', () => {
    // verification cap = 12; nearLimit should be true only on the 12th call.
    process.env.CLAUDE_CODE_AGENT_LIMIT_VERIFICATION = '5'
    const flags: boolean[] = []
    for (let i = 1; i <= 5; i++) {
      const r = noteInvocation('verification')
      flags.push(r.nearLimit)
    }
    // Calls 1–4: not near; call 5: near (last allowed); call 6 would be capped.
    expect(flags).toEqual([false, false, false, false, true])
    const r6 = noteInvocation('verification')
    expect(r6.capped).toBe(true)
    expect(r6.nearLimit).toBe(false)
  })

  test('nearLimit is suppressed when limit is 1 (would coincide with first call)', () => {
    process.env.CLAUDE_CODE_AGENT_LIMIT_CODE_REVIEWER = '1'
    const r = noteInvocation('code-reviewer')
    expect(r.limit).toBe(1)
    expect(r.capped).toBe(false)
    expect(r.nearLimit).toBe(false)
  })

  test('formatNearLimitWarning is a system-reminder block with cap details', () => {
    const msg = formatNearLimitWarning('verification', {
      count: 12,
      limit: 12,
      failStreak: 0,
      failStreakLimit: 3,
      capped: false,
      cappedReason: 'none',
      nearLimit: true,
    })
    expect(msg).toContain('<system-reminder>')
    expect(msg).toContain('</system-reminder>')
    expect(msg).toContain("'verification'")
    expect(msg).toContain('12 of 12')
    expect(msg).toContain('CLAUDE_CODE_AGENT_LIMIT_VERIFICATION')
    expect(msg).toContain('CLAUDE_CODE_AGENT_LIMITER_OFF=1')
  })

  test('honors raised env cap before flagging capped', () => {
    process.env.CLAUDE_CODE_AGENT_LIMIT_VERIFICATION = '7'
    for (let i = 1; i <= 7; i++) {
      const r = noteInvocation('verification')
      expect(r.capped).toBe(false)
      expect(r.limit).toBe(7)
    }
    const r8 = noteInvocation('verification')
    expect(r8.capped).toBe(true)
    expect(r8.count).toBe(8)
  })

  // --- Streak gate (regression for "verifier loop" failure mode) ---

  test('three consecutive FAILs trip the streak gate before the total cap', () => {
    // cap is 12; streak threshold is 3. Burn 3 FAILs and the next call
    // should be capped via streak even though total count is well under 12.
    noteInvocation('verification')
    noteOutcome('verification', 'FAIL')
    noteInvocation('verification')
    noteOutcome('verification', 'FAIL')
    noteInvocation('verification')
    noteOutcome('verification', 'FAIL')

    const r4 = noteInvocation('verification')
    expect(r4.capped).toBe(true)
    expect(r4.cappedReason).toBe('streak')
    expect(r4.failStreak).toBe(3)
    expect(r4.failStreakLimit).toBe(3)
    expect(r4.count).toBe(4) // total cap not yet reached
    expect(r4.limit).toBe(12)
  })

  test('a PASS verdict clears the FAIL streak', () => {
    noteInvocation('verification')
    noteOutcome('verification', 'FAIL')
    noteInvocation('verification')
    noteOutcome('verification', 'FAIL')
    // PASS in the middle of a streak resets it.
    noteInvocation('verification')
    noteOutcome('verification', 'PASS')

    // Two more FAILs should NOT cap because the streak was reset.
    noteInvocation('verification')
    noteOutcome('verification', 'FAIL')
    noteInvocation('verification')
    noteOutcome('verification', 'FAIL')

    const r6 = noteInvocation('verification')
    expect(r6.capped).toBe(false)
    expect(r6.failStreak).toBe(2) // 2 FAILs since the last PASS
  })

  test('UNKNOWN verdict is treated as a soft-PASS (clears streak)', () => {
    // A subagent that does not emit a verdict line (e.g. one-shot
    // research / Explore) should not be punished — UNKNOWN should
    // clear the streak just like PASS does.
    noteInvocation('verification')
    noteOutcome('verification', 'FAIL')
    noteInvocation('verification')
    noteOutcome('verification', 'FAIL')
    noteInvocation('verification')
    noteOutcome('verification', 'UNKNOWN')

    const r4 = noteInvocation('verification')
    expect(r4.capped).toBe(false)
    expect(r4.failStreak).toBe(0)
  })

  test('streak gate is per-agent-type (PASS on one type does not clear another)', () => {
    noteInvocation('verification')
    noteOutcome('verification', 'FAIL')
    noteInvocation('code-reviewer')
    noteOutcome('code-reviewer', 'PASS')
    noteInvocation('verification')
    noteOutcome('verification', 'FAIL')
    noteInvocation('verification')
    noteOutcome('verification', 'FAIL')

    const r4 = noteInvocation('verification')
    expect(r4.capped).toBe(true)
    expect(r4.cappedReason).toBe('streak')
  })

  test('successful work pattern: 12 PASSes hits total cap, never streak', () => {
    // The motivating regression: 5 PRs, each with one PASSing
    // verification, then a 6th PR. With the old cap=5 + no streak
    // semantics this errored on the 6th PR. With cap=12 and PASS
    // clearing the streak, 12 successful invocations in a row are
    // allowed; the 13th hits the *total* cap (not the streak).
    for (let i = 1; i <= 12; i++) {
      const r = noteInvocation('verification')
      expect(r.capped).toBe(false)
      noteOutcome('verification', 'PASS')
    }
    const r13 = noteInvocation('verification')
    expect(r13.capped).toBe(true)
    expect(r13.cappedReason).toBe('total')
  })
})

// --- parseVerdict ---

describe('parseVerdict', () => {
  test('returns UNKNOWN for empty / null / undefined input', () => {
    expect(parseVerdict('')).toBe('UNKNOWN')
    expect(parseVerdict(null)).toBe('UNKNOWN')
    expect(parseVerdict(undefined)).toBe('UNKNOWN')
  })

  test('recognises the canonical "VERDICT: PASS" line', () => {
    expect(parseVerdict('Some report text\n\nVERDICT: PASS')).toBe('PASS')
    expect(parseVerdict('VERDICT: PASS\n')).toBe('PASS')
    // Case-insensitive.
    expect(parseVerdict('verdict: pass')).toBe('PASS')
  })

  test('recognises common FAIL-shaped tokens', () => {
    expect(parseVerdict('VERDICT: FAIL')).toBe('FAIL')
    expect(parseVerdict('VERDICT: PARTIAL')).toBe('FAIL')
    expect(parseVerdict('VERDICT: CHANGES_NEEDED')).toBe('FAIL')
    expect(parseVerdict('VERDICT: UNCONFIRMED')).toBe('FAIL')
  })

  test('recognises code-reviewer "APPROVE" as PASS', () => {
    expect(parseVerdict('Findings:\n...\nVERDICT: APPROVE')).toBe('PASS')
  })

  test('recognises specialist verdict synonyms', () => {
    expect(parseVerdict('SECURITY: PASS')).toBe('PASS')
    expect(parseVerdict('SECURITY: CHANGES_NEEDED')).toBe('FAIL')
    expect(parseVerdict('PLAN_REVIEW: APPROVE')).toBe('PASS')
    expect(parseVerdict('PLAN_REVIEW: CHANGES_NEEDED')).toBe('FAIL')
    expect(parseVerdict('ROOT CAUSE: FOUND at file:line')).toBe('PASS')
    expect(parseVerdict('ROOT CAUSE: UNCONFIRMED')).toBe('FAIL')
  })

  test('returns UNKNOWN when no verdict line is present', () => {
    expect(parseVerdict('Just a long report with no structured verdict.')).toBe('UNKNOWN')
    expect(parseVerdict('Tests pass and everything looks fine.')).toBe('UNKNOWN')
  })

  test('tolerates markdown bullets and leading whitespace before VERDICT', () => {
    expect(parseVerdict('  - VERDICT: PASS')).toBe('PASS')
    expect(parseVerdict('### VERDICT: FAIL')).toBe('FAIL')
    expect(parseVerdict('> VERDICT: APPROVE')).toBe('PASS')
  })

  test('looks at the tail when input is very long', () => {
    const huge = 'noise '.repeat(2000) + '\nVERDICT: PASS\n'
    expect(parseVerdict(huge)).toBe('PASS')
  })
})
