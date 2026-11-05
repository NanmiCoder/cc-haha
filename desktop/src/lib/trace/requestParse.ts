import type { NormalizedBlock, NormalizedMessage, NormalizedUsage } from './types'
import { looksLikeSseText, normalizeContentBlock, normalizeUsageValue, reassembleSseText } from './sse'

export type ParsedRequest = {
  model?: string
  system?: string
  messages: NormalizedMessage[]
  tools: Array<{ name: string; description?: string; schema?: unknown }>
  params: Record<string, unknown>
}

export type ParsedResponse = {
  kind: 'json' | 'sse'
  message: NormalizedMessage | null
  usage: NormalizedUsage | null
  stopReason?: string
  model?: string
}

type JsonRecord = Record<string, unknown>

// `instructions` and `input` are the OpenAI Responses spellings of `system`
// and `messages`; both wire formats reach this parser through the same trace.
const REQUEST_CORE_KEYS = new Set(['model', 'system', 'messages', 'tools', 'instructions', 'input'])

/**
 * The turns of a request, under whichever key this provider spells them.
 *
 * Responses splits a tool round trip into sibling `function_call` and
 * `function_call_output` entries where the Messages format nests `tool_use`
 * and `tool_result` blocks inside a turn. Real traces carry more of those than
 * plain messages, so they are mapped onto the block vocabulary the rest of the
 * viewer already speaks rather than skipped. Reasoning items hold no
 * model-visible turn and are the one kind dropped.
 */
function requestTurns(body: JsonRecord): NormalizedMessage[] {
  if (Array.isArray(body.messages)) {
    return body.messages
      .map((entry) => normalizeMessage(entry))
      .filter((entry): entry is NormalizedMessage => entry !== null)
  }
  if (!Array.isArray(body.input)) return []

  const turns: NormalizedMessage[] = []
  for (const entry of body.input) {
    if (!isRecord(entry)) continue
    if (entry.type === undefined || entry.type === 'message') {
      const message = normalizeMessage(entry)
      if (message) turns.push(message)
      continue
    }
    if (entry.type === 'function_call') {
      const name = typeof entry.name === 'string' ? entry.name : ''
      if (!name) continue
      turns.push({
        role: 'assistant',
        content: [{
          type: 'tool_use',
          ...(typeof entry.call_id === 'string' ? { id: entry.call_id } : {}),
          name,
          input: parseToolArguments(entry.arguments),
        }],
      })
      continue
    }
    if (entry.type === 'function_call_output') {
      turns.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          ...(typeof entry.call_id === 'string' ? { toolUseId: entry.call_id } : {}),
          content: entry.output,
        }],
      })
    }
  }
  return turns
}

export function parseTraceRequestBody(preview: string, source: 'anthropic' | 'proxy'): ParsedRequest | null {
  const parsed = parseJsonRecord(preview)
  if (!parsed) return null
  const body = source === 'proxy' ? unwrapProxyEnvelope(parsed) : parsed
  if (!isRecord(body)) return null

  const model = typeof body.model === 'string' && body.model ? body.model : undefined
  // `||`, not `??`: an empty `system` array flattens to '', which would
  // otherwise shadow a real `instructions` string.
  const system = extractSystemText(body.system) || extractSystemText(body.instructions)
  const messages = requestTurns(body)
  const tools = Array.isArray(body.tools)
    ? body.tools
        .map((entry) => normalizeToolDefinition(entry))
        .filter((entry): entry is ParsedRequest['tools'][number] => entry !== null)
    : []
  const params: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body)) {
    if (!REQUEST_CORE_KEYS.has(key)) params[key] = value
  }

  return {
    ...(model ? { model } : {}),
    ...(system !== undefined ? { system } : {}),
    messages,
    tools,
    params,
  }
}

export function parseTraceResponseBody(preview: string, source: 'anthropic' | 'proxy'): ParsedResponse | null {
  if (typeof preview !== 'string' || !preview.trim()) return null
  if (looksLikeSseText(preview)) {
    const reassembled = reassembleSseText(preview)
    return reassembled ? { kind: 'sse', ...reassembled } : null
  }

  const parsed = parseJsonRecord(preview)
  if (!parsed) return null
  const body = source === 'proxy' ? unwrapProxyEnvelope(parsed) : parsed
  if (typeof body === 'string') {
    const reassembled = looksLikeSseText(body) ? reassembleSseText(body) : null
    return reassembled ? { kind: 'sse', ...reassembled } : null
  }
  if (!isRecord(body)) return null
  return normalizeJsonResponse(body)
}

function normalizeJsonResponse(body: JsonRecord): ParsedResponse {
  const model = typeof body.model === 'string' && body.model ? body.model : undefined

  if (Array.isArray(body.content)) {
    const blocks = body.content
      .map((block) => normalizeContentBlock(block))
      .filter((block): block is NormalizedBlock => block !== null)
    const stopReason = typeof body.stop_reason === 'string' && body.stop_reason ? body.stop_reason : undefined
    return {
      kind: 'json',
      message: { role: normalizeRole(body.role, 'assistant'), content: blocks },
      usage: normalizeUsageValue(body.usage),
      ...(stopReason ? { stopReason } : {}),
      ...(model ? { model } : {}),
    }
  }

  const firstChoice = Array.isArray(body.choices) && isRecord(body.choices[0]) ? body.choices[0] : null
  if (firstChoice) {
    const message = isRecord(firstChoice.message) ? firstChoice.message : {}
    const blocks: NormalizedBlock[] = []
    if (typeof message.reasoning_content === 'string' && message.reasoning_content.trim()) {
      blocks.push({ type: 'thinking', thinking: message.reasoning_content })
    }
    if (typeof message.content === 'string' && message.content) {
      blocks.push({ type: 'text', text: message.content })
    }
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
    for (const toolCall of toolCalls) {
      if (!isRecord(toolCall)) continue
      const fn = isRecord(toolCall.function) ? toolCall.function : {}
      blocks.push({
        type: 'tool_use',
        ...(typeof toolCall.id === 'string' && toolCall.id ? { id: toolCall.id } : {}),
        name: typeof fn.name === 'string' ? fn.name : '',
        input: parseToolArguments(fn.arguments),
      })
    }
    const stopReason = typeof firstChoice.finish_reason === 'string' && firstChoice.finish_reason
      ? firstChoice.finish_reason
      : undefined
    return {
      kind: 'json',
      message: { role: normalizeRole(message.role, 'assistant'), content: blocks },
      usage: normalizeUsageValue(body.usage),
      ...(stopReason ? { stopReason } : {}),
      ...(model ? { model } : {}),
    }
  }

  return {
    kind: 'json',
    message: null,
    usage: normalizeUsageValue(body.usage),
    ...(model ? { model } : {}),
  }
}

function normalizeMessage(entry: unknown): NormalizedMessage | null {
  if (!isRecord(entry)) return null
  const role = normalizeRole(entry.role, 'user')
  const content = entry.content
  if (typeof content === 'string') {
    return { role, content: [{ type: 'text', text: content }] }
  }
  if (Array.isArray(content)) {
    const blocks = content
      .map((block) => normalizeContentBlock(block))
      .filter((block): block is NormalizedBlock => block !== null)
    return { role, content: blocks }
  }
  return { role, content: [] }
}

function normalizeRole(role: unknown, fallback: NormalizedMessage['role']): NormalizedMessage['role'] {
  return role === 'user' || role === 'assistant' || role === 'system' || role === 'tool' ? role : fallback
}

function normalizeToolDefinition(entry: unknown): ParsedRequest['tools'][number] | null {
  if (!isRecord(entry)) return null
  const fn = isRecord(entry.function) ? entry.function : null
  const name = typeof entry.name === 'string' && entry.name
    ? entry.name
    : fn && typeof fn.name === 'string' && fn.name
      ? fn.name
      : null
  if (!name) return null
  const description = typeof entry.description === 'string' && entry.description
    ? entry.description
    : fn && typeof fn.description === 'string' && fn.description
      ? fn.description
      : undefined
  // Three spellings: Anthropic `input_schema`, Chat Completions
  // `function.parameters`, and the flat Responses `parameters`.
  const schema = entry.input_schema ?? fn?.parameters ?? entry.parameters
  return {
    name,
    ...(description ? { description } : {}),
    ...(schema !== undefined ? { schema } : {}),
  }
}

function extractSystemText(system: unknown): string | undefined {
  if (typeof system === 'string') return system
  if (!Array.isArray(system)) return undefined
  const parts = system.flatMap((block) => {
    if (typeof block === 'string') return [block]
    if (isRecord(block) && typeof block.text === 'string') return [block.text]
    return []
  })
  return parts.join('\n\n')
}

function unwrapProxyEnvelope(parsed: JsonRecord): unknown {
  if ('anthropic' in parsed) return parsed.anthropic
  return parsed
}

function parseToolArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function parseJsonRecord(text: string): JsonRecord | null {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const parsed = JSON.parse(trimmed) as unknown
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
