function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseOpenAIToolArguments(value: unknown): Record<string, unknown> {
  if (value == null || value === '') return {}

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      return isRecord(parsed) ? parsed : { raw: parsed }
    } catch {
      return { raw: value }
    }
  }

  if (isRecord(value)) return value

  return { raw: value }
}

export function stringifyOpenAIToolArguments(value: unknown): string {
  if (value == null || value === '') return ''
  return typeof value === 'string' ? value : JSON.stringify(value)
}
