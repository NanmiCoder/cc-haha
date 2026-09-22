export type DiagnosticRateLimitDecision = {
  report: boolean
  suppressedSinceLast: number
}

type RateLimitState = {
  lastReportedAt: number
  suppressed: number
}

export function createDiagnosticRateLimiter(cooldownMs: number, maxKeys = 200) {
  const states = new Map<string, RateLimitState>()
  return (key: string, now = Date.now()): DiagnosticRateLimitDecision => {
    const previous = states.get(key)
    if (previous && now - previous.lastReportedAt < cooldownMs) {
      previous.suppressed += 1
      return { report: false, suppressedSinceLast: previous.suppressed }
    }

    const suppressedSinceLast = previous?.suppressed ?? 0
    states.delete(key)
    states.set(key, { lastReportedAt: now, suppressed: 0 })
    while (states.size > maxKeys) {
      const oldestKey = states.keys().next().value
      if (typeof oldestKey !== 'string') break
      states.delete(oldestKey)
    }
    return { report: true, suppressedSinceLast }
  }
}
