import { getOpenAIPolicyError } from '../../../services/openaiAuth/policyError.js'

export function responsesRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
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
    throw Object.assign(new Error(message), { type: overloaded ? 'overloaded_error' : 'api_error' })
  }
  if (status === 'completed') return 'completed'
  if (status === 'incomplete') {
    const reason = responsesRecord(value?.incomplete_details)?.reason
    if (reason === 'max_output_tokens' || reason === 'max_tokens') return 'max_tokens'
    throw Object.assign(new Error(`OpenAI response was incomplete: ${typeof reason === 'string' ? reason : 'unknown'}`), { type: 'api_error' })
  }
  throw Object.assign(new Error(`OpenAI response has no valid terminal status: ${status ?? 'missing'}`), { type: 'api_error' })
}

/** Tool input is executable data: malformed JSON must never become {} or raw. */
export function parseResponsesToolArguments(value: unknown): Record<string, unknown> {
  let parsed = value
  if (typeof value === 'string' && value.trim()) {
    try {
      parsed = JSON.parse(value)
    } catch {
      throw new Error('Invalid OpenAI Responses tool arguments: incomplete or malformed JSON')
    }
  }
  const record = responsesRecord(parsed)
  if (!record) throw new Error('Invalid OpenAI Responses tool arguments: expected a JSON object')
  return record
}
