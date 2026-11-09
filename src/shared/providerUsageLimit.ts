// Provider and relay errors can contain several JSON envelopes, including a
// serialized upstream body inside the local proxy's message. Inspect the
// structured fields without treating every 429 as an exhausted plan.
const USAGE_LIMIT_PATTERNS: readonly RegExp[] = [
  /\b(?:reached|exceeded|exhausted|depleted)\b[^.!?\n]{0,80}\b(?:usage limit|quota)\b/i,
  /\b(?:usage limit|quota)\b[^.!?\n]{0,80}\b(?:reached|exceeded|exhausted|depleted|used[ -]up)\b/i,
  /\binsufficient[ _](?:balance|quota|credits?)\b/i,
]

export function isProviderUsageLimitText(text: string): boolean {
  return USAGE_LIMIT_PATTERNS.some(pattern => pattern.test(text))
}

function isShortRateLimit(text: string): boolean {
  return /\b(?:per[ -](?:minute|second|hour)|rate[ _-]?limit|rpm|tpm|rps|tps)\b|\/\s*(?:minute|second|hour|min|sec|hr)\b/i.test(text)
}

export function inspectProviderUsageError(payload: unknown): { usageLimit: boolean; invalidCredential: boolean } {
  let usageLimit = false
  let invalidCredential = false
  const pending: Array<{ value: unknown; depth: number }> = [{ value: payload, depth: 0 }]
  while (pending.length) {
    const { value, depth } = pending.pop()!
    if (depth > 6) continue
    if (typeof value === 'string') {
      const raw = value.replace(/^\s*Upstream returned HTTP \d+:\s*/i, '').trim()
      if (/^[{\[]/.test(raw)) {
        try {
          pending.push({ value: JSON.parse(raw), depth: depth + 1 })
          continue
        } catch {
          // A proxy may have truncated a JSON body, removing the field that
          // distinguishes a short rate limit from an exhausted plan.
          continue
        }
      }
      if (/\b(?:invalid|expired|revoked)\s+(?:(?:x-)?api[ -]?key|bearer token|oauth token)|\b(?:(?:x-)?api[ -]?key|bearer token|oauth token)\s+(?:(?:you provided|you supplied|provided)\s+)?(?:(?:is|has|was)(?:\s+been)?\s+)?(?:invalid|expired|revoked)\b/i.test(value)) {
        invalidCredential = true
      }
      if (!isShortRateLimit(value) && (
        /\binsufficient[ _-](?:balance|credits?)\b|\binsufficient_quota\b/i.test(value) ||
        (isProviderUsageLimitText(value) && /\b(?:monthly|billing cycle|billing period|billing details|plan|recharge|top[ -]?up)\b/i.test(value))
      )) usageLimit = true
      continue
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const record = value as Record<string, unknown>
    const nested = record.error && typeof record.error === 'object' && !Array.isArray(record.error)
      ? record.error as Record<string, unknown>
      : undefined
    const metadata = record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
      ? record.metadata as Record<string, unknown>
      : undefined
    if (nested?.type === 'GoUsageLimitError' && metadata?.limitName === 'monthly') usageLimit = true
    const codes = [record.code, record.type]
    if (codes.some(code => code === 'invalid_api_key' || code === 'invalid_token' || code === 'expired_api_key')) invalidCredential = true
    if (codes.some(code => code === 'insufficient_quota') &&
      !(typeof record.message === 'string' && isShortRateLimit(record.message))) usageLimit = true
    if (record.error !== undefined) pending.push({ value: record.error, depth: depth + 1 })
    if (typeof record.message === 'string') pending.push({ value: record.message, depth: depth + 1 })
  }
  return { usageLimit, invalidCredential }
}
