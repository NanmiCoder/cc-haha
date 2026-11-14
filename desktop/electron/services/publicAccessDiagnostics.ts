import { appendHostDiagnostic, sanitizeHostDiagnostic } from './sidecarManager'

export type PublicAccessDiagnostic = {
  attemptId?: string
  stage: string
  outcome: 'started' | 'succeeded' | 'failed' | 'cancelled' | 'retrying'
  durationMs?: number
  reason?: string
  error?: unknown
  details?: Record<string, unknown>
}

export type PublicAccessDiagnosticWriter = (event: PublicAccessDiagnostic) => void

/** Scrub complete strings before bounding them, including credentials printed without a label. */
export function sanitizePublicAccessDiagnosticText(text: string, secrets: string[] = []): string {
  const sensitive = new Set(secrets.filter(Boolean))
  for (const value of secrets) {
    try {
      const url = new URL(value)
      for (const part of [url.username, url.password]) {
        if (part) { sensitive.add(part); sensitive.add(decodeURIComponent(part)) }
      }
      if (url.username || url.password) sensitive.add(Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64'))
    } catch { /* Tokens and non-URL secrets are still replaced literally. */ }
  }
  let sanitized = text
  for (const value of [...sensitive].sort((a, b) => b.length - a.length)) sanitized = sanitized.replaceAll(value, '[REDACTED]')
  sanitized = sanitized
    .replace(/\beyJ[A-Za-z0-9_+/=-]{20,}(?:\.[A-Za-z0-9_-]+)*/g, '[REDACTED]')
    .replace(/https?:\/\/[^\s<>"')\]}]+/gi, candidate => {
      try {
        const url = new URL(candidate)
        return `${url.protocol}//${url.host}${url.pathname}${url.search ? '?[REDACTED]' : ''}${url.hash ? '#[REDACTED]' : ''}`
      } catch { return '[REDACTED_URL]' }
    })
  return sanitizeHostDiagnostic(sanitized).slice(0, 2048)
}

function safeValue(value: unknown, secrets: string[], depth = 0, seen = new Set<object>(), key = ''): unknown {
  if (typeof value === 'string') {
    // These are generated ids and controlled protocol metadata, not free text.
    // A one-character proxy password must not corrupt a UUID or an error code.
    if (key === 'attemptId' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value)) return value
    if (['stage', 'outcome', 'reason', 'mode', 'step', 'signal'].includes(key) && /^[a-z0-9_:-]{1,64}$/i.test(value)) return value
    if (key === 'code' && /^(?:[A-Z][A-Z0-9_]{1,63}|network|configuration|proxy|runtime|token|route)$/.test(value)) return value
    if (key === 'syscall' && /^(?:connect|getaddrinfo|read|write|listen|bind|open|access|spawn)$/.test(value)) return value
    if (['targetHost', 'proxyHost', 'address', 'proxyProtocol'].includes(key) && /^[a-z0-9.:[\]-]{1,253}$/i.test(value)) return value
    if (key === 'name' && /^(?:Error|TypeError|SyntaxError|AggregateError|AbortError|TimeoutError|CloudflareTunnelError)$/.test(value)) return value
    return sanitizePublicAccessDiagnosticText(value, secrets)
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (depth >= 5 || typeof value !== 'object' || seen.has(value)) return undefined
  seen.add(value)
  if (value instanceof Error) {
    const error = value as Error & { code?: unknown, errno?: unknown, syscall?: unknown, address?: unknown, port?: unknown, cause?: unknown }
    return safeValue({ name: error.name, code: error.code, message: error.message, errno: error.errno,
      syscall: error.syscall, address: error.address, port: error.port, cause: error.cause,
      errors: value instanceof AggregateError ? value.errors : undefined }, secrets, depth, seen)
  }
  if (Array.isArray(value)) return value.slice(-6).map(item => safeValue(item, secrets, depth + 1, seen))
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value).slice(0, 24)) {
    if (/token|secret|password|authorization|cookie|headers|body|proxyUrl/i.test(key)) continue
    const safe = safeValue(item, secrets, depth + 1, seen, key)
    if (safe !== undefined) result[key] = safe
  }
  return result
}

/** A diagnostic sink must never fail a connection or expose private configuration. */
export function recordPublicAccessDiagnostic(writer: PublicAccessDiagnosticWriter | undefined, event: PublicAccessDiagnostic, secrets: string[] = []): void {
  if (!writer) return
  try {
    const sanitized = safeValue(event, secrets) as PublicAccessDiagnostic
    const result = (writer as (event: PublicAccessDiagnostic) => unknown)(sanitized)
    if (result instanceof Promise) void result.catch(() => {})
  } catch { /* Logging is best effort, including injected diagnostic sinks. */ }
}

/** The existing host log is retained and included in Settings → Diagnostics → Export. */
export function createPublicAccessDiagnosticWriter(filePath: string, append = appendHostDiagnostic): PublicAccessDiagnosticWriter {
  return event => recordPublicAccessDiagnostic(safe => {
    // Host lines have a 4096-byte cap. Keep ids and machine-readable reasons
    // first, and bound the complete JSON before the host writer can truncate it.
    const metadata = { timestamp: new Date().toISOString(), attemptId: safe.attemptId, stage: safe.stage,
      outcome: safe.outcome, reason: safe.reason, durationMs: safe.durationMs }
    const trim = (value: unknown, limit: number, depth = 0, key = ''): unknown => {
      if (typeof value === 'string') return key === 'logTail' ? value.slice(-limit) : value.slice(0, limit)
      if (!value || typeof value !== 'object') return value
      if (depth >= 4) return '[TRUNCATED]'
      if (Array.isArray(value)) return value.slice(0, 2).map(item => trim(item, limit, depth + 1))
      return Object.fromEntries(Object.entries(value).slice(0, 16).map(([key, item]) => [key, trim(item, key === 'logTail' ? limit * 2 : limit, depth + 1, key)]))
    }
    let line = ''
    for (const limit of [512, 256, 128, 64]) {
      line = JSON.stringify({ ...metadata, error: trim(safe.error, limit), details: trim(safe.details, limit) })
      if (Buffer.byteLength(line) <= 3600) break
    }
    if (Buffer.byteLength(line) > 3600) {
      const error = safe.error as { name?: string, code?: string } | undefined
      line = JSON.stringify({ ...metadata, error: error ? { name: error.name, code: error.code } : undefined, details: { truncated: true } })
    }
    append(filePath, `[public-access] ${line}`)
  }, event)
}
