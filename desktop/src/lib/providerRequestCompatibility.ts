import type { RequestCompatibility } from '../types/provider'

export const PROVIDER_OUTPUT_BUDGET_ENV_KEY = 'CLAUDE_CODE_PROVIDER_MAX_OUTPUT_TOKENS'
export const COMPATIBILITY_CAPABILITIES = ['sampling', 'reasoning', 'parallelTools', 'structuredOutput'] as const

export type RequestCompatibilityForm = {
  maxOutputTokens: string
  outputTokenLimit: string
  options: RequestCompatibility
}

export function compatibilityForm(value?: RequestCompatibility | null): RequestCompatibilityForm {
  const { maxOutputTokens, outputTokenLimit, ...options } = value ?? {}
  return {
    maxOutputTokens: maxOutputTokens === undefined ? '' : String(maxOutputTokens),
    outputTokenLimit: outputTokenLimit === undefined ? '' : String(outputTokenLimit),
    options,
  }
}

export function invalidCompatibilityNumber(value: string): boolean {
  return !!value.trim() && (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0)
}

export function parseCompatibilityForm(form: RequestCompatibilityForm): RequestCompatibility | undefined {
  if (invalidCompatibilityNumber(form.maxOutputTokens) || invalidCompatibilityNumber(form.outputTokenLimit)) {
    throw new Error('settings.providers.compatibilityNumberError')
  }
  const result = { ...form.options }
  if (form.maxOutputTokens.trim()) result.maxOutputTokens = Number(form.maxOutputTokens)
  if (form.outputTokenLimit.trim()) result.outputTokenLimit = Number(form.outputTokenLimit)
  return Object.keys(result).length > 0 ? result : undefined
}

export function readCompatibilityJson(value: unknown): RequestCompatibility | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('settings.providers.compatibilityJsonError')
  const result = value as RequestCompatibility
  for (const key of ['maxOutputTokens', 'outputTokenLimit'] as const) {
    const number = result[key]
    if (number !== undefined && (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0)) {
      throw new Error('settings.providers.compatibilityNumberError')
    }
  }
  if (result.outputTokenField !== undefined && !['auto', 'max_tokens', 'max_completion_tokens', 'omit'].includes(result.outputTokenField)) {
    throw new Error('settings.providers.compatibilityJsonError')
  }
  for (const key of COMPATIBILITY_CAPABILITIES) {
    if (result[key] !== undefined && !['auto', 'supported', 'unsupported'].includes(result[key])) throw new Error('settings.providers.compatibilityJsonError')
  }
  return Object.keys(result).length > 0 ? { ...result } : undefined
}

/** The top-level object belongs to the provider editor, not global settings. */
export function writeCompatibilityJson(
  settings: Record<string, unknown>,
  value: RequestCompatibility | undefined,
): Record<string, unknown> {
  const result = { ...settings }
  const env = settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env)
    ? { ...settings.env as Record<string, unknown> } : {}
  if (value) result.requestCompatibility = value
  else delete result.requestCompatibility
  if (value?.maxOutputTokens !== undefined) env[PROVIDER_OUTPUT_BUDGET_ENV_KEY] = String(value.maxOutputTokens)
  else delete env[PROVIDER_OUTPUT_BUDGET_ENV_KEY]
  result.env = env
  return result
}

export function readCompatibilityEditorJson(
  settings: Record<string, unknown>,
  previousRaw: string,
): RequestCompatibility | undefined {
  let previous: Record<string, unknown> = {}
  try { previous = JSON.parse(previousRaw) } catch { /* The previous edit can be incomplete JSON. */ }
  const value = readCompatibilityJson(settings.requestCompatibility)
  // An explicit edit/removal of the provider object takes precedence over its
  // mirrored budget environment variable, including resetting the whole panel.
  if (JSON.stringify(settings.requestCompatibility) !== JSON.stringify(previous.requestCompatibility)) return value
  const env = settings.env as Record<string, unknown> | undefined
  const previousEnv = previous.env as Record<string, unknown> | undefined
  const budget = env?.[PROVIDER_OUTPUT_BUDGET_ENV_KEY]
  if (budget === previousEnv?.[PROVIDER_OUTPUT_BUDGET_ENV_KEY]) return value
  const next = { ...value }
  if (budget === undefined || budget === '') delete next.maxOutputTokens
  else {
    if (typeof budget !== 'string' || invalidCompatibilityNumber(budget)) throw new Error('settings.providers.compatibilityNumberError')
    next.maxOutputTokens = Number(budget)
  }
  return Object.keys(next).length ? next : undefined
}
