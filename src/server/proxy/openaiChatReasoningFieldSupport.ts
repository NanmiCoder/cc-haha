import type { OpenAIChatRequest } from './transform/types.js'

// Which reasoning wire fields a model accepts is learned from the upstream, not
// predicted from host or model names. A gateway such as OpenCode Go serves many
// backends behind one OpenAI Chat endpoint: the DeepSeek models take the
// `thinking` toggle while others (Cat Jam Free) refuse the request with
// "Unrecognized request argument supplied: thinking". Every model starts with
// the fields sent; a field is dropped for that endpoint and model only after the
// upstream explicitly names it as unsupported and the same request succeeds
// without it. The knowledge expires, so a model that gains support recovers
// without a restart.
export type OpenAIChatReasoningField = 'thinking' | 'reasoning_effort'

const REASONING_FIELDS: readonly OpenAIChatReasoningField[] = ['thinking', 'reasoning_effort']
const UNSUPPORTED_TTL_MS = 30 * 60 * 1000
const MAX_MODELS = 256
const unsupportedFieldsUntil = new Map<string, Map<OpenAIChatReasoningField, number>>()

function modelKey(endpointUrl: string, model: string): string {
  return `${endpointUrl.replace(/\/+$/, '').toLowerCase()}\n${model.toLowerCase()}`
}

export function getOpenAIChatUnsupportedReasoningFields(
  endpointUrl: string,
  model: string,
  now = Date.now(),
): ReadonlySet<OpenAIChatReasoningField> {
  const key = modelKey(endpointUrl, model)
  const entries = unsupportedFieldsUntil.get(key)
  const active = new Set<OpenAIChatReasoningField>()
  if (!entries) return active
  for (const [field, until] of entries) {
    if (until > now) active.add(field)
    else entries.delete(field)
  }
  if (entries.size === 0) unsupportedFieldsUntil.delete(key)
  return active
}

export function rememberOpenAIChatUnsupportedReasoningField(
  endpointUrl: string,
  model: string,
  field: OpenAIChatReasoningField,
  now = Date.now(),
): void {
  const key = modelKey(endpointUrl, model)
  let entries = unsupportedFieldsUntil.get(key)
  if (!entries) {
    if (unsupportedFieldsUntil.size >= MAX_MODELS) {
      const oldest = unsupportedFieldsUntil.keys().next().value
      if (oldest !== undefined) unsupportedFieldsUntil.delete(oldest)
    }
    entries = new Map()
    unsupportedFieldsUntil.set(key, entries)
  }
  entries.set(field, now + UNSUPPORTED_TTL_MS)
}

/**
 * The reasoning field a failed upstream response points at, if any. The only
 * signal is the structured `error.param` naming a field the request carried;
 * a gateway that does not report it keeps the visible error. Nothing is dropped
 * for good on this alone: the field is remembered only once the resend without
 * it succeeds.
 */
export function findOpenAIChatReasoningFieldRejection(
  status: number,
  errorText: string,
  request: OpenAIChatRequest,
): OpenAIChatReasoningField | undefined {
  if (status !== 400 && status !== 422) return undefined
  let param: unknown
  try {
    param = (JSON.parse(errorText) as { error?: { param?: unknown } })?.error?.param
  } catch {
    return undefined
  }
  return REASONING_FIELDS.find(field => param === field && request[field] !== undefined)
}

export function resetOpenAIChatReasoningFieldSupportForTests(): void {
  unsupportedFieldsUntil.clear()
}
