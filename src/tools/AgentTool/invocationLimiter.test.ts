import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  _getLimiterStateSnapshot,
  _resetLimiterState,
  formatLimitExceededMessage,
  formatNearLimitWarning,
  getLimitFor,
  isLimiterDisabled,
  noteInvocation,
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

  test('default cap for verification is 5', () => {
    expect(getLimitFor('verification')).toBe(5)
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
    expect(getLimitFor('verification')).toBe(5)
    process.env.CLAUDE_CODE_AGENT_LIMIT_VERIFICATION = '0'
    expect(getLimitFor('verification')).toBe(5)
    process.env.CLAUDE_CODE_AGENT_LIMIT_VERIFICATION = '-3'
    expect(getLimitFor('verification')).toBe(5)
  })

  test('isLimiterDisabled tracks env var', () => {
    expect(isLimiterDisabled()).toBe(false)
    process.env.CLAUDE_CODE_AGENT_LIMITER_OFF = '1'
    expect(isLimiterDisabled()).toBe(true)
  })

  test('noteInvocation increments and reports capped after threshold', () => {
    // verification cap = 5
    for (let i = 1; i <= 5; i++) {
      const r = noteInvocation('verification')
      expect(r.count).toBe(i)
      expect(r.limit).toBe(5)
      expect(r.capped).toBe(false)
    }
    const r6 = noteInvocation('verification')
    expect(r6.count).toBe(6)
    expect(r6.capped).toBe(true)
  })

  test('counters are independent per agent type', () => {
    noteInvocation('verification')
    noteInvocation('verification')
    noteInvocation('code-reviewer')
    const snap = _getLimiterStateSnapshot(getSessionId())
    expect(snap?.get('verification')).toBe(2)
    expect(snap?.get('code-reviewer')).toBe(1)
  })

  test('formatLimitExceededMessage includes the counter, cap, and env hint', () => {
    const msg = formatLimitExceededMessage('code-reviewer', {
      count: 9,
      limit: 8,
      capped: true,
      nearLimit: false,
    })
    expect(msg).toContain("'code-reviewer'")
    expect(msg).toContain('9 times')
    expect(msg).toContain('cap of 8')
    expect(msg).toContain('CLAUDE_CODE_AGENT_LIMIT_CODE_REVIEWER')
    expect(msg).toContain('CLAUDE_CODE_AGENT_LIMITER_OFF=1')
  })

  test('nearLimit fires once on the last allowed invocation', () => {
    // verification cap = 5; nearLimit should be true on the 5th call only.
    const flags: boolean[] = []
    for (let i = 1; i <= 5; i++) {
      const r = noteInvocation('verification')
      flags.push(r.nearLimit)
    }
    // Calls 1–4: not near; call 5: near (last allowed); call 6 would be capped.
    expect(flags).toEqual([false, false, false, false, true])
    // Verify post-cap state isn't flagged as nearLimit.
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
      count: 5,
      limit: 5,
      capped: false,
      nearLimit: true,
    })
    expect(msg).toContain('<system-reminder>')
    expect(msg).toContain('</system-reminder>')
    expect(msg).toContain("'verification'")
    expect(msg).toContain('5 of 5')
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
})
