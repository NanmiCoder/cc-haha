/**
 * Wire-level helpers shared by the recorder and the replay server.
 *
 * Two upstream dialects reach a provider from this product: Anthropic Messages
 * (the CLI talks to it directly) and OpenAI Chat Completions (the server's proxy
 * translates to it). Both stream as SSE. A recording keeps every event as parsed
 * JSON so it can be normalised and replayed with the real event order and the
 * real fragment boundaries, which is what hand-written mocks never had.
 */

export type ApiFormat = 'anthropic' | 'openai_chat'

export type SseEvent = {
  /** `event:` line, absent for OpenAI chunks. */
  event?: string
  /** Parsed `data:` JSON, or the raw string for non-JSON data such as `[DONE]`. */
  data: unknown
}

/** Parses a complete SSE body. Comments and `id:`/`retry:` lines are dropped. */
export function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = []
  for (const block of text.replace(/\r\n/g, '\n').split('\n\n')) {
    let event: string | undefined
    const data: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
    }
    if (data.length === 0) continue
    const raw = data.join('\n')
    let parsed: unknown = raw
    try { parsed = JSON.parse(raw) } catch { /* keep raw, e.g. [DONE] */ }
    events.push({ ...(event ? { event } : {}), data: parsed })
  }
  return events
}

export function serializeSseEvent(event: SseEvent): string {
  const data = typeof event.data === 'string' ? event.data : JSON.stringify(event.data)
  return `${event.event ? `event: ${event.event}\n` : ''}data: ${data}\n\n`
}

/**
 * A streamed string field that a model emits in fragments: text, thinking, tool
 * input JSON, reasoning, or tool-call arguments. `get`/`set` address it inside one
 * event, `key` groups the fragments of one logical value, `jsonString` says the
 * value is JSON text, so a substituted path has to be JSON-escaped.
 */
export type FragmentRef = {
  key: string
  jsonString: boolean
  get(): string
  set(value: string): void
}

function anthropicFragments(event: SseEvent): FragmentRef[] {
  const data = event.data as { type?: string; index?: number; delta?: Record<string, unknown> }
  if (!data || typeof data !== 'object' || data.type !== 'content_block_delta' || !data.delta) return []
  const delta = data.delta
  for (const [field, jsonString] of [['text', false], ['thinking', false], ['partial_json', true]] as const) {
    if (typeof delta[field] === 'string') {
      return [{
        key: `block:${data.index}:${field}`,
        jsonString,
        get: () => delta[field] as string,
        set: (value) => { delta[field] = value },
      }]
    }
  }
  return []
}

function openaiFragments(event: SseEvent): FragmentRef[] {
  const data = event.data as { choices?: Array<{ index?: number; delta?: Record<string, unknown> }> }
  if (!data || typeof data !== 'object' || !Array.isArray(data.choices)) return []
  const refs: FragmentRef[] = []
  for (const choice of data.choices) {
    const delta = choice.delta
    if (!delta) continue
    for (const field of ['content', 'reasoning_content'] as const) {
      if (typeof delta[field] === 'string') {
        refs.push({
          key: `choice:${choice.index ?? 0}:${field}`,
          jsonString: false,
          get: () => delta[field] as string,
          set: (value) => { delta[field] = value },
        })
      }
    }
    const calls = delta.tool_calls as Array<{ index?: number; function?: Record<string, unknown> }> | undefined
    for (const call of calls ?? []) {
      const fn = call.function
      if (fn && typeof fn.arguments === 'string') {
        refs.push({
          key: `choice:${choice.index ?? 0}:tool:${call.index ?? 0}`,
          jsonString: true,
          get: () => fn.arguments as string,
          set: (value) => { fn.arguments = value },
        })
      }
    }
  }
  return refs
}

export function fragmentRefs(format: ApiFormat, event: SseEvent): FragmentRef[] {
  return format === 'anthropic' ? anthropicFragments(event) : openaiFragments(event)
}

/** What a request asked for, reduced to the parts a replay can rely on. */
export type RequestFingerprint = {
  model: string
  stream: boolean
  maxTokens: number | null
  /** Sorted tool names; the queue a request belongs to is derived from them. */
  toolNames: string[]
  lastRole: string
  /** User-typed text of the last user message, reminders removed, normalised. */
  lastUserText: string
  /**
   * Text of the first user message: the prompt that started this agent loop
   * (the user's question, a subagent's task, a teammate's instructions).
   * Concurrent loops are told apart by it.
   */
  firstUserText: string
  /** tool_result / role:tool ids answered by this request, in order. */
  toolResultIds: string[]
  messageCount: number
}

function textOf(content: unknown): string[] {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  return content
    .filter((part): part is { type: string; text: string } => Boolean(part) && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' && ['text', 'input_text'].includes((part as { type?: string }).type ?? 'text'))
    .map((part) => part.text)
}

/** Harness-injected context, which carries dates, todo state, and other run-specific text. */
function isReminder(text: string) {
  return /^\s*<(system-reminder|local-command|command-name|ide_|user-prompt-submit-hook)/.test(text)
}

export function fingerprintRequest(format: ApiFormat, body: Record<string, unknown>): RequestFingerprint {
  const messages = (Array.isArray(body.messages) ? body.messages : []) as Array<{ role?: string; content?: unknown; tool_call_id?: string }>
  const last = messages.at(-1)
  const tools = Array.isArray(body.tools) ? body.tools as Array<{ name?: string; function?: { name?: string } }> : []
  const toolNames = tools.map((tool) => tool.name ?? tool.function?.name ?? '?').sort()
  let toolResultIds: string[] = []
  let lastUserText = ''
  if (format === 'anthropic') {
    if (last?.role === 'user' && Array.isArray(last.content)) {
      toolResultIds = (last.content as Array<{ type?: string; tool_use_id?: string }>)
        .filter((part) => part.type === 'tool_result' && part.tool_use_id)
        .map((part) => part.tool_use_id!)
    }
    if (last?.role === 'user') lastUserText = textOf(last.content).filter((text) => !isReminder(text)).join('\n').trim()
  } else {
    // Tool results are the role:tool messages after the last assistant message.
    let index = messages.length - 1
    while (index >= 0 && messages[index]?.role === 'tool') index -= 1
    toolResultIds = messages.slice(index + 1).map((message) => message.tool_call_id ?? '?')
    if (last?.role === 'user') lastUserText = textOf(last.content).filter((text) => !isReminder(text)).join('\n').trim()
  }
  const first = messages.find((message) => message.role === 'user' && textOf(message.content).some((text) => !isReminder(text) && text.trim()))
  const firstUserText = first ? textOf(first.content).filter((text) => !isReminder(text)).join('\n').trim() : ''
  const maxTokens = body.max_tokens ?? body.max_completion_tokens
  return {
    model: String(body.model ?? ''),
    stream: body.stream === true,
    maxTokens: typeof maxTokens === 'number' ? maxTokens : null,
    toolNames,
    lastRole: last?.role ?? '',
    lastUserText,
    firstUserText,
    toolResultIds,
    messageCount: messages.length,
  }
}

/** Ids of the tool calls a response asked for, in order. */
export function responseToolUseIds(format: ApiFormat, events: SseEvent[], json?: unknown): string[] {
  const ids: string[] = []
  if (json && typeof json === 'object') {
    const body = json as { content?: Array<{ type?: string; id?: string }>; choices?: Array<{ message?: { tool_calls?: Array<{ id?: string }> } }> }
    for (const block of body.content ?? []) if (block.type === 'tool_use' && block.id) ids.push(block.id)
    for (const choice of body.choices ?? []) for (const call of choice.message?.tool_calls ?? []) if (call.id) ids.push(call.id)
    return ids
  }
  for (const event of events) {
    const data = event.data as Record<string, any>
    if (!data || typeof data !== 'object') continue
    if (format === 'anthropic') {
      if (data.type === 'content_block_start' && data.content_block?.type === 'tool_use' && data.content_block.id) ids.push(data.content_block.id)
    } else {
      for (const choice of data.choices ?? []) for (const call of choice.delta?.tool_calls ?? []) if (call.id) ids.push(call.id)
    }
  }
  return ids
}

/** Names of the tools a response called. */
export function responseToolNames(format: ApiFormat, events: SseEvent[], json?: unknown): string[] {
  const names: string[] = []
  if (json && typeof json === 'object') {
    const body = json as { content?: Array<{ type?: string; name?: string }>; choices?: Array<{ message?: { tool_calls?: Array<{ function?: { name?: string } }> } }> }
    for (const block of body.content ?? []) if (block.type === 'tool_use' && block.name) names.push(block.name)
    for (const choice of body.choices ?? []) for (const call of choice.message?.tool_calls ?? []) if (call.function?.name) names.push(call.function.name)
    return names
  }
  for (const event of events) {
    const data = event.data as Record<string, any>
    if (!data || typeof data !== 'object') continue
    if (format === 'anthropic') {
      if (data.type === 'content_block_start' && data.content_block?.type === 'tool_use') names.push(data.content_block.name)
    } else {
      for (const choice of data.choices ?? []) for (const call of choice.delta?.tool_calls ?? []) if (call.function?.name) names.push(call.function.name)
    }
  }
  return names
}

/** Observable traits of a recorded stream, checked against a scenario's `requires`. */
export function responseFeatures(format: ApiFormat, events: SseEvent[]) {
  let thinking = false
  const toolFragments = new Map<string, number>()
  for (const event of events) {
    for (const ref of fragmentRefs(format, event)) {
      if (ref.key.endsWith(':thinking') || ref.key.endsWith(':reasoning_content')) thinking ||= ref.get().length > 0
      if (ref.jsonString) toolFragments.set(ref.key, (toolFragments.get(ref.key) ?? 0) + 1)
    }
    const data = event.data as Record<string, any>
    if (format === 'anthropic' && data?.type === 'content_block_start' && data.content_block?.type === 'thinking') thinking = true
  }
  return {
    thinking,
    fragmentedToolInput: [...toolFragments.values()].some((count) => count > 1),
    toolNames: responseToolNames(format, events),
  }
}
