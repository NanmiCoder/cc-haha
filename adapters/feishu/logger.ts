import { isSensitiveDiagnosticKey, redactDiagnosticText } from '../../src/server/services/diagnosticRedaction.js'

type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace'
type LogRecord = Record<string, unknown>

function isRecord(value: unknown): value is LogRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The SDK also turns AxiosError into a plain {message, config, response,
 * request} record, so checking only instanceof Error loses that boundary. */
function isHttpError(value: unknown): value is LogRecord {
  return isRecord(value) && (value.isAxiosError === true || value.name === 'AxiosError'
    || (isRecord(value.config) && ('response' in value || 'request' in value)))
}

export function createFeishuLogger(sensitiveValues: readonly string[] = []) {
  const secrets = [...new Set(sensitiveValues.filter(Boolean))].sort((a, b) => b.length - a.length)
  const redact = (value: string): string => {
    for (const secret of secrets) value = value.split(secret).join('[REDACTED]')
    return redactDiagnosticText(value)
  }

  function summarizeHttpError(error: LogRecord): LogRecord {
    const config = isRecord(error.config) ? error.config : {}
    const response = isRecord(error.response) ? error.response : {}
    const summary: LogRecord = { name: typeof error.name === 'string' ? redact(error.name) : 'AxiosError' }
    for (const key of ['message', 'code'] as const) {
      if (typeof error[key] === 'string') summary[key] = redact(error[key])
      else if (typeof error[key] === 'number' && Number.isFinite(error[key])) summary[key] = error[key]
    }
    if (typeof config.method === 'string') summary.method = redact(config.method.toUpperCase())
    if (typeof config.url === 'string') {
      try { summary.path = redact(new URL(config.url, 'https://diagnostic.invalid').pathname) }
      catch { summary.path = '[INVALID URL]' }
    }
    const status = response.status ?? error.status
    if (typeof status === 'number' && Number.isFinite(status)) summary.status = status
    return summary
  }

  function sanitize(value: unknown, seen: WeakSet<object>, depth = 0): unknown {
    if (typeof value === 'string') return redact(value)
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
    if (typeof value === 'function') return '[FUNCTION]'
    if (typeof value !== 'object') return redact(String(value))
    if (depth > 8) return '[TRUNCATED]'
    if (seen.has(value)) return '[CIRCULAR]'
    seen.add(value)
    try {
      if (isHttpError(value)) return summarizeHttpError(value)
      if (value instanceof Error) {
        const stack = redact(value.stack || `${value.name}: ${value.message}`)
        return value.cause === undefined ? stack : `${stack}\nCaused by: ${format(sanitize(value.cause, seen, depth + 1))}`
      }
      if (Array.isArray(value)) {
        // Generated SDK methods append response.data beside the HTTP error.
        // Retain context strings, but never serialize that response body.
        const entries = value.some(isHttpError)
          ? value.filter(entry => !isRecord(entry) || isHttpError(entry))
          : value
        return entries.map(entry => sanitize(entry, seen, depth + 1))
      }
      const result: LogRecord = Object.create(null)
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
        if (!descriptor.enumerable) continue
        // Do not invoke getters or custom toJSON/inspect implementations while
        // logging a platform-controlled object.
        result[redact(key)] = isSensitiveDiagnosticKey(key) ? '[REDACTED]'
          : 'value' in descriptor ? sanitize(descriptor.value, seen, depth + 1) : '[GETTER]'
      }
      return result
    } finally {
      seen.delete(value)
    }
  }

  function format(value: unknown): string {
    if (typeof value === 'string') return value
    return JSON.stringify(value) ?? String(value)
  }

  const write = (level: LogLevel, values: unknown[]) => {
    const messages = values.map(value => {
      try { return format(sanitize(value, new WeakSet())) }
      catch { return '[UNSERIALIZABLE LOG VALUE]' }
    })
    // Only strings reach console: Bun otherwise renders source snippets and
    // enumerable Axios fields even when Error.message itself looks harmless.
    console[level](...messages)
  }
  return {
    error: (...values: unknown[]) => write('error', values),
    warn: (...values: unknown[]) => write('warn', values),
    info: (...values: unknown[]) => write('info', values),
    debug: (...values: unknown[]) => write('debug', values),
    trace: (...values: unknown[]) => write('trace', values),
  }
}
