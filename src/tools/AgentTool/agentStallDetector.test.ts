import { describe, expect, test } from 'bun:test'
import {
  createStallDetector,
  formatStalledSummary,
} from './agentStallDetector.js'

const T0 = 1_000_000

describe('createStallDetector', () => {
  test('starts in idle state', () => {
    const d = createStallDetector({ startedAt: T0 })
    const s = d.check(T0)
    expect(s.kind).toBe('idle')
    expect(s.isStalled).toBe(false)
    expect(s.transitioned).toBe(false)
    expect(s.idleMs).toBe(0)
    expect(d.isStalled()).toBe(false)
  })

  test('reports idleMs from startedAt', () => {
    const d = createStallDetector({ startedAt: T0, thresholdMs: 90_000 })
    const s = d.check(T0 + 5_000)
    expect(s.kind).toBe('idle')
    expect(s.idleMs).toBe(5_000)
  })

  test('crosses to stalled at threshold; first check transitions', () => {
    const d = createStallDetector({ startedAt: T0, thresholdMs: 90_000 })
    const s1 = d.check(T0 + 90_000)
    expect(s1.kind).toBe('stalled')
    expect(s1.transitioned).toBe(true)
    expect(s1.idleMs).toBe(90_000)
    expect(d.isStalled()).toBe(true)
    // Subsequent checks while still stalled don't re-transition.
    const s2 = d.check(T0 + 100_000)
    expect(s2.kind).toBe('stalled')
    expect(s2.transitioned).toBe(false)
    expect(s2.idleMs).toBe(100_000)
  })

  test('does NOT transition before threshold', () => {
    const d = createStallDetector({ startedAt: T0, thresholdMs: 90_000 })
    const s = d.check(T0 + 89_999)
    expect(s.kind).toBe('idle')
    expect(s.transitioned).toBe(false)
  })

  test('notify() during idle just resets the window', () => {
    const d = createStallDetector({ startedAt: T0, thresholdMs: 90_000 })
    d.notify(T0 + 30_000)
    const s = d.check(T0 + 35_000)
    expect(s.kind).toBe('idle')
    expect(s.idleMs).toBe(5_000)
  })

  test('notify() during stall produces a one-shot resumed transition', () => {
    const d = createStallDetector({ startedAt: T0, thresholdMs: 90_000 })
    // Enter stall.
    expect(d.check(T0 + 90_000).kind).toBe('stalled')
    // Notify resumes activity.
    d.notify(T0 + 95_000)
    const s1 = d.check(T0 + 95_001)
    expect(s1.kind).toBe('resumed')
    expect(s1.transitioned).toBe(true)
    expect(s1.idleMs).toBe(1)
    // After consumption, falls back to idle.
    const s2 = d.check(T0 + 96_000)
    expect(s2.kind).toBe('idle')
    expect(s2.transitioned).toBe(false)
    expect(d.isStalled()).toBe(false)
  })

  test('can re-enter stall after a resume cycle', () => {
    const d = createStallDetector({ startedAt: T0, thresholdMs: 90_000 })
    expect(d.check(T0 + 90_000).kind).toBe('stalled')
    d.notify(T0 + 95_000)
    expect(d.check(T0 + 95_001).kind).toBe('resumed')
    // Drift past threshold again.
    const s = d.check(T0 + 95_000 + 90_000)
    expect(s.kind).toBe('stalled')
    expect(s.transitioned).toBe(true)
  })

  test('stalled transition fires exactly once between cycles', () => {
    const d = createStallDetector({ startedAt: T0, thresholdMs: 90_000 })
    const transitions: string[] = []
    for (let dt = 0; dt <= 200_000; dt += 10_000) {
      const s = d.check(T0 + dt)
      if (s.transitioned) transitions.push(`${s.kind}@${dt}`)
    }
    expect(transitions).toEqual(['stalled@90000'])
  })

  test('rejects non-positive thresholdMs', () => {
    expect(() => createStallDetector({ thresholdMs: 0 })).toThrow()
    expect(() => createStallDetector({ thresholdMs: -1 })).toThrow()
    expect(() => createStallDetector({ thresholdMs: NaN })).toThrow()
  })

  test('default threshold is 90s', () => {
    const d = createStallDetector({ startedAt: T0 })
    expect(d.check(T0 + 89_999).kind).toBe('idle')
    expect(d.check(T0 + 90_000).kind).toBe('stalled')
  })

  test('idleMs never goes negative on clock skew', () => {
    const d = createStallDetector({ startedAt: T0, thresholdMs: 90_000 })
    const s = d.check(T0 - 5_000)
    expect(s.idleMs).toBe(0)
  })
})

describe('formatStalledSummary', () => {
  test('uses summary when present', () => {
    expect(formatStalledSummary(90_000, 'Investigating auth bug', 'desc')).toBe(
      '(stalled 90s) Investigating auth bug',
    )
  })

  test('falls back to description when summary is missing', () => {
    expect(formatStalledSummary(90_000, undefined, 'fix auth bug')).toBe(
      '(stalled 90s) fix auth bug',
    )
  })

  test('falls back to description when summary is empty', () => {
    expect(formatStalledSummary(90_000, '', 'fix auth bug')).toBe(
      '(stalled 90s) fix auth bug',
    )
  })

  test('rounds the seconds counter down to 5s buckets', () => {
    expect(formatStalledSummary(90_000, undefined, 'task')).toContain('90s')
    expect(formatStalledSummary(92_500, undefined, 'task')).toContain('90s')
    expect(formatStalledSummary(94_999, undefined, 'task')).toContain('90s')
    expect(formatStalledSummary(95_000, undefined, 'task')).toContain('95s')
    expect(formatStalledSummary(120_000, undefined, 'task')).toContain('120s')
  })

  test('trims surrounding whitespace from underlying text', () => {
    expect(formatStalledSummary(90_000, '  hello  ', 'desc')).toBe(
      '(stalled 90s) hello',
    )
  })

  test('handles zero idle gracefully', () => {
    expect(formatStalledSummary(0, 'doing things', 'desc')).toBe(
      '(stalled 0s) doing things',
    )
  })
})
