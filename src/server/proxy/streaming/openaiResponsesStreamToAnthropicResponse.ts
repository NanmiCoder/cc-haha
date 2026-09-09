import { getOpenAIPolicyError } from '../../../services/openaiAuth/policyError.js'
import { openaiResponsesToAnthropic } from '../transform/openaiResponsesToAnthropic.js'
import type {
  AnthropicResponse,
  OpenAIResponsesResponse,
} from '../transform/types.js'

export type OpenAIResponsesCollectOptions = {
  openAICodexOAuth?: boolean
}

type StreamFallbackState = {
  id: string
  createdAt: number
  model: string
  status: string
  textByKey: Map<string, string>
  usage: OpenAIResponsesResponse['usage']
}

/**
 * Collect a streamed OpenAI Responses API response into one Anthropic message.
 * ChatGPT Codex requires upstream stream=true, but some Anthropic SDK callers
 * still expect a non-streaming JSON response.
 */
export async function openaiResponsesStreamToAnthropicResponse(
  upstream: ReadableStream<Uint8Array>,
  model: string,
  options: OpenAIResponsesCollectOptions = {},
): Promise<AnthropicResponse> {
  const decoder = new TextDecoder()
  const reader = upstream.getReader()
  let buffer = ''
  let currentEvent = ''
  let completedResponse: OpenAIResponsesResponse | null = null
  let terminalError: Error | null = null

  const fallback: StreamFallbackState = {
    id: `resp_${Date.now()}`,
    createdAt: Math.floor(Date.now() / 1000),
    model,
    status: 'completed',
    textByKey: new Map(),
    usage: undefined,
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.startsWith('event: ')) {
        currentEvent = trimmed.slice(7).trim()
        continue
      }

      if (!trimmed.startsWith('data: ')) {
        if (trimmed === '') currentEvent = ''
        continue
      }

      const jsonStr = trimmed.slice(6)
      if (jsonStr === '[DONE]') {
        currentEvent = ''
        continue
      }

      let data: Record<string, unknown>
      try {
        data = JSON.parse(jsonStr) as Record<string, unknown>
      } catch {
        currentEvent = ''
        continue
      }

      if (currentEvent === 'response.completed') {
        const response = data.response
        if (isOpenAIResponsesResponse(response)) {
          completedResponse = response
        }
      } else if (
        options.openAICodexOAuth &&
        currentEvent === 'response.incomplete' &&
        readIncompleteReason(data) === 'max_output_tokens'
      ) {
        const response = data.response
        if (isOpenAIResponsesResponse(response)) {
          completedResponse = response
        }
      } else if (
        (options.openAICodexOAuth || getOpenAIPolicyError(data)) &&
        (
          currentEvent === 'response.failed' ||
          currentEvent === 'response.incomplete' ||
          currentEvent === 'response.cancelled' ||
          currentEvent === 'error'
        )
      ) {
        const policyError = getOpenAIPolicyError(data)
        terminalError = policyError
          ? Object.assign(new Error(policyError.message), { code: policyError.code, type: 'permission_error', status: 403 })
          : new Error(readTerminalError(currentEvent, data))
      } else {
        updateFallbackState(currentEvent, data, fallback)
      }
      currentEvent = ''
    }
  }

  if (terminalError) throw terminalError
  if (options.openAICodexOAuth && !completedResponse) {
    const error = new Error(
      'OpenAI Responses stream closed before response.completed',
    ) as Error & { code: string }
    error.code = 'ERR_STREAM_PREMATURE_CLOSE'
    throw error
  }

  return openaiResponsesToAnthropic(
    completedResponse ?? buildFallbackResponse(fallback),
    model,
    { preserveOpenAIReasoning: options.openAICodexOAuth },
  )
}

function readTerminalError(
  event: string,
  data: Record<string, unknown>,
): string {
  const response = isRecord(data.response) ? data.response : undefined
  const error = isRecord(response?.error)
    ? response.error
    : isRecord(data.error)
      ? data.error
      : data
  if (typeof error?.message === 'string' && error.message) return error.message
  if (event === 'response.incomplete') {
    const details = isRecord(response?.incomplete_details)
      ? response.incomplete_details
      : undefined
    const reason = typeof details?.reason === 'string' ? details.reason : 'unknown'
    return `OpenAI response was incomplete: ${reason}`
  }
  return `OpenAI stream ended with ${event}`
}

function readIncompleteReason(data: Record<string, unknown>): string {
  const response = isRecord(data.response) ? data.response : undefined
  const details = isRecord(response?.incomplete_details)
    ? response.incomplete_details
    : undefined
  return typeof details?.reason === 'string' ? details.reason : 'unknown'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function updateFallbackState(
  event: string,
  data: Record<string, unknown>,
  fallback: StreamFallbackState,
): void {
  if (event === 'response.created') {
    if (typeof data.id === 'string') fallback.id = data.id
    if (typeof data.created_at === 'number') fallback.createdAt = data.created_at
    if (typeof data.model === 'string') fallback.model = data.model
    if (typeof data.status === 'string') fallback.status = data.status
    return
  }

  if (event === 'response.output_text.delta') {
    const key = getTextKey(data)
    const delta = typeof data.delta === 'string' ? data.delta : ''
    fallback.textByKey.set(key, (fallback.textByKey.get(key) ?? '') + delta)
    return
  }

  if (event === 'response.output_text.done') {
    const text = typeof data.text === 'string' ? data.text : null
    if (text !== null) fallback.textByKey.set(getTextKey(data), text)
    return
  }

  if (event === 'response.refusal.delta') {
    const key = getTextKey(data)
    const delta = typeof data.delta === 'string' ? data.delta : ''
    fallback.textByKey.set(key, (fallback.textByKey.get(key) ?? '') + delta)
  }
}

function buildFallbackResponse(
  fallback: StreamFallbackState,
): OpenAIResponsesResponse {
  const text = [...fallback.textByKey.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, value]) => value)
    .join('')

  return {
    id: fallback.id,
    object: 'response',
    created_at: fallback.createdAt,
    model: fallback.model,
    status: fallback.status,
    output: [{
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    }],
    usage: fallback.usage,
  }
}

function getTextKey(data: Record<string, unknown>): string {
  const outputIndex = typeof data.output_index === 'number' ? data.output_index : 0
  const contentIndex = typeof data.content_index === 'number' ? data.content_index : 0
  return `${outputIndex}:${contentIndex}`
}

function isOpenAIResponsesResponse(
  value: unknown,
): value is OpenAIResponsesResponse {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Array.isArray((value as { output?: unknown }).output)
  )
}
