import { createUnparsedToolInput } from '../../../utils/unparsedToolInput.js'
import { getOpenAIPolicyError } from '../../../services/openaiAuth/policyError.js'

export function responsesRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

// Codes an upstream sends when the request itself cannot succeed (Codex does
// not retry them either). Any other failure stays api_error, which the client
// re-sends like a 500, so these must not be reported as one.
const REQUEST_FAILURE_CODES = new Set([
  'context_length_exceeded',
  'insufficient_quota',
  'usage_not_included',
  'invalid_prompt',
])

export function isUpstreamRequestFailure(code: unknown): boolean {
  return typeof code === 'string' && REQUEST_FAILURE_CODES.has(code)
}

/** Only explicit terminal evidence can establish completion or an output limit. */
export function responsesTerminalStop(
  response: unknown,
  event?: string,
): 'completed' | 'max_tokens' {
  const value = responsesRecord(response)
  const policy = getOpenAIPolicyError(value)
  if (policy) throw Object.assign(new Error(policy.message), { ...policy, type: 'permission_error', status: 403 })

  const status = typeof value?.status === 'string'
    ? value.status
    : event?.replace(/^response\./, '')
  const embedded = responsesRecord(value?.error)
  const failedEvent = event === 'response.failed' || event === 'response.cancelled' || event === 'error'
  if (embedded || value?.error || failedEvent || status === 'failed' || status === 'cancelled') {
    const message = typeof embedded?.message === 'string' ? embedded.message
      : typeof value?.message === 'string' ? value.message
        : typeof value?.error === 'string' ? value.error
          : `OpenAI stream ended with ${event ?? `response.${status}`}`
    const code = typeof embedded?.code === 'string' ? embedded.code : typeof value?.code === 'string' ? value.code : ''
    const upstreamType = typeof embedded?.type === 'string' ? embedded.type : ''
    const overloaded = [code, upstreamType].some(item => /rate_limit|capacity|overload/.test(item))
    const type = isUpstreamRequestFailure(code) ? 'invalid_request_error'
      : overloaded ? 'overloaded_error' : 'api_error'
    throw Object.assign(new Error(message), { type })
  }
  if (status === 'completed') return 'completed'
  if (status === 'incomplete') {
    const reason = responsesRecord(value?.incomplete_details)?.reason
    if (reason === 'max_output_tokens' || reason === 'max_tokens') return 'max_tokens'
    throw Object.assign(new Error(`OpenAI response was incomplete: ${typeof reason === 'string' ? reason : 'unknown'}`), { type: 'api_error' })
  }
  throw Object.assign(new Error(`OpenAI response has no valid terminal status: ${status ?? 'missing'}`), { type: 'api_error' })
}

/** Preserve complete malformed calls as non-executable input for model correction. */
export function parseResponsesToolArguments(value: unknown): Record<string, unknown> {
  let parsed = value
  if (typeof value === 'string' && value.trim()) {
    try {
      parsed = JSON.parse(value)
    } catch {
      return createUnparsedToolInput(value)
    }
  }
  const record = responsesRecord(parsed)
  if (!record) throw new Error('Invalid OpenAI Responses tool arguments: expected a JSON object')
  return record
}
