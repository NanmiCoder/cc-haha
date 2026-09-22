import { describe, expect, it } from 'vitest'
import { createDiagnosticRateLimiter } from './diagnosticRateLimit'

describe('diagnostic anomaly rate limiting', () => {
  it('reports one sample per key and carries the suppressed count into the next window', () => {
    const decide = createDiagnosticRateLimiter(10_000)

    expect(decide('GET:/api/sessions', 0)).toEqual({ report: true, suppressedSinceLast: 0 })
    expect(decide('GET:/api/sessions', 1_000)).toEqual({ report: false, suppressedSinceLast: 1 })
    expect(decide('GET:/api/sessions', 2_000)).toEqual({ report: false, suppressedSinceLast: 2 })
    expect(decide('GET:/api/sessions', 10_000)).toEqual({ report: true, suppressedSinceLast: 2 })
    expect(decide('GET:/api/tasks', 10_001)).toEqual({ report: true, suppressedSinceLast: 0 })
  })
})
