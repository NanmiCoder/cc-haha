import { describe, expect, test } from 'bun:test'
import {
  analyzeFirstMessageForMode,
  formatModeAdviceBanner,
} from './modeAdvice.js'

describe('analyzeFirstMessageForMode', () => {
  test('returns undefined for empty / whitespace input', () => {
    expect(analyzeFirstMessageForMode('')).toBeUndefined()
    expect(analyzeFirstMessageForMode('   ')).toBeUndefined()
    // @ts-expect-error testing nullish defensive path
    expect(analyzeFirstMessageForMode(undefined)).toBeUndefined()
  })

  test('routes pure questions to normal', () => {
    const a = analyzeFirstMessageForMode('What does runAgent do?')
    expect(a?.suggestedMode).toBe('normal')
  })

  test('routes "show me" / "explain" intents to normal', () => {
    expect(
      analyzeFirstMessageForMode('Show me how the auth flow works.')
        ?.suggestedMode,
    ).toBe('normal')
    expect(
      analyzeFirstMessageForMode('Explain the difference between forks and subagents.')
        ?.suggestedMode,
    ).toBe('normal')
  })

  test('routes typo fixes to normal', () => {
    expect(
      analyzeFirstMessageForMode('Fix the typo in README.md')?.suggestedMode,
    ).toBe('normal')
    expect(
      analyzeFirstMessageForMode('correct the spelling in the docs')
        ?.suggestedMode,
    ).toBe('normal')
  })

  test('routes single-symbol rename to normal', () => {
    expect(
      analyzeFirstMessageForMode('Rename foo to bar')?.suggestedMode,
    ).toBe('normal')
  })

  test('routes migration work to coordinator', () => {
    const a = analyzeFirstMessageForMode(
      'Migrate the auth subsystem from express-session to JWT across the API server.',
    )
    expect(a?.suggestedMode).toBe('coordinator')
  })

  test('routes upgrades to coordinator', () => {
    expect(
      analyzeFirstMessageForMode('Upgrade from React 17 to React 18 in the desktop app.')
        ?.suggestedMode,
    ).toBe('coordinator')
  })

  test('routes audits / investigations to coordinator', () => {
    expect(
      analyzeFirstMessageForMode(
        'Investigate the performance regression in the chat queue and find the bottleneck.',
      )?.suggestedMode,
    ).toBe('coordinator')
  })

  test('routes feature implementation language to coordinator', () => {
    expect(
      analyzeFirstMessageForMode(
        'Implement a new caching feature for the message queue service.',
      )?.suggestedMode,
    ).toBe('coordinator')
  })

  test('routes "verify and ship" patterns to coordinator', () => {
    expect(
      analyzeFirstMessageForMode(
        'Verify the new endpoint works under load and then deploy it to staging.',
      )?.suggestedMode,
    ).toBe('coordinator')
  })

  test('returns undefined for vague borderline messages', () => {
    expect(analyzeFirstMessageForMode('look at this code')).toBeUndefined()
    expect(analyzeFirstMessageForMode('help')).toBeUndefined()
    expect(
      analyzeFirstMessageForMode('I have an issue, can you check?'),
    ).toBeUndefined()
  })

  test('a single-file mention is a normal signal', () => {
    // Short message that mentions exactly one file.
    const a = analyzeFirstMessageForMode(
      'There is a bug in src/auth/validate.ts — please fix it.',
    )
    expect(a?.suggestedMode).toBe('normal')
  })

  test('three-plus file mentions push toward coordinator', () => {
    const a = analyzeFirstMessageForMode(
      'Refactor src/auth/validate.ts, src/auth/session.ts, and src/auth/middleware.ts to share a single helper.',
    )
    expect(a?.suggestedMode).toBe('coordinator')
  })

  test('long detailed task descriptions push toward coordinator', () => {
    const long = 'Please ' + 'refactor and document the chat queue subsystem. '.repeat(20)
    const a = analyzeFirstMessageForMode(long)
    expect(a?.suggestedMode).toBe('coordinator')
  })

  test('confidence is high when multiple signals agree', () => {
    const a = analyzeFirstMessageForMode(
      'Migrate the auth and session modules across multiple files end-to-end.',
    )
    expect(a?.suggestedMode).toBe('coordinator')
    expect(a?.confidence).toBe('high')
  })

  test('reasons array references each fired rule', () => {
    const a = analyzeFirstMessageForMode('Fix the typo in README.md')
    expect(a?.reasons.length).toBeGreaterThan(0)
    expect(a?.reasons.some(r => r.includes('typo'))).toBe(true)
  })
})

describe('formatModeAdviceBanner', () => {
  test('returns null when advice matches current mode', () => {
    const a = analyzeFirstMessageForMode('What does runAgent do?')!
    expect(formatModeAdviceBanner('normal', a)).toBeNull()
  })

  test('returns null when no advice is given', () => {
    expect(formatModeAdviceBanner('coordinator', undefined)).toBeNull()
  })

  test('produces an actionable message when normal is suggested but coordinator is active', () => {
    const a = analyzeFirstMessageForMode('What does runAgent do?')!
    const msg = formatModeAdviceBanner('coordinator', a)
    expect(msg).not.toBeNull()
    expect(msg!.toLowerCase()).toContain('coordinator')
    expect(msg!.toLowerCase()).toContain('normal')
    // References the real mechanism (env var), not a nonexistent slash command.
    expect(msg!).toContain('CLAUDE_CODE_COORDINATOR_MODE')
  })

  test('produces an actionable message when coordinator is suggested but normal is active', () => {
    const a = analyzeFirstMessageForMode(
      'Migrate the auth subsystem across multiple modules end-to-end.',
    )!
    const msg = formatModeAdviceBanner('normal', a)
    expect(msg).not.toBeNull()
    expect(msg!.toLowerCase()).toContain('coordinator')
  })

  test('limits the reasons rendered in the banner', () => {
    const a = analyzeFirstMessageForMode(
      'Migrate the auth and session modules across multiple files end-to-end.',
    )!
    const msg = formatModeAdviceBanner('normal', a)!
    // Multiple internal reasons collapse to at most 2 in the banner copy.
    const split = msg.split(';')
    expect(split.length).toBeLessThanOrEqual(3)
  })
})
