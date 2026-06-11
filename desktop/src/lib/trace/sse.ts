/**
 * Portions of this file are adapted from claude-tap
 * (https://github.com/liaohch3/claude-tap), Copyright (c) 2025 liaohch3,
 * licensed under the MIT License. See THIRD_PARTY_LICENSES.md for the full text.
 */
import type { NormalizedBlock, NormalizedMessage, NormalizedUsage } from './types'

export type ReassembledSse = {
  message: NormalizedMessage | null
  usage: NormalizedUsage | null
  stopReason?: string
  model?: string
}

type JsonRecord = Record<string, unknown>

export function reassembleSseText(sseText: string): ReassembledSse | null {
  if (typeof sseText !== 'string' || !looksLikeSseText(sseText)) return null
  try {
    const snapshot = reassembleSnapshot(sseText)
    if (!snapshot) return null
    return snapshotToResult(snapshot)
  } catch {
    return null
  }
}

export function looksLikeSseText(text: string): boolean {
  if (typeof text !== 'string') return false
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    return line.startsWith('event:') || line.startsWith('data:')
  }
  return false
}

function reassembleSnapshot(sseText: string): JsonRecord | null {
  const state: { snapshot: JsonRecord | null } = { snapshot: null }
  let currentEvent: string | null = null
  let currentData: string[] = []

  const flush = () => {
    if (currentEvent === null && currentData.length === 0) return
    const rawData = currentData.join('\n')
    const isDoneSentinel = rawData === '[DONE]' && currentEvent === null
    if (!isDoneSentinel) {
      let data: unknown
      try {
        data = JSON.parse(rawData)
      } catch {
        data = rawData
      }
      accumulate(state, currentEvent ?? 'message', data)
    }
    currentEvent = null
    currentData = []
  }

  for (const rawLine of sseText.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.startsWith('event:')) {
      currentEvent = line.slice('event:'.length).trim()
      currentData = []
    } else if (line.startsWith('data:')) {
      currentData.push(line.slice('data:'.length).trim())
    } else if (line === '') {
      flush()
    }
  }
  flush()
  return state.snapshot
}

function accumulate(state: { snapshot: JsonRecord | null }, eventType: string, data: unknown): void {
  if (!isRecord(data)) return
  try {
    if (eventType === 'message_start') {
      state.snapshot = deepClone(isRecord(data.message) ? data.message : {})
    } else if (eventType === 'message' && 'choices' in data) {
      accumulateChatCompletionChunk(state, data)
    } else if (!state.snapshot) {
      return
    } else if (eventType === 'content_block_start') {
      const content = ensureContentArray(state.snapshot)
      const index = typeof data.index === 'number' && data.index >= 0 ? data.index : content.length
      while (content.length <= index) content.push({})
      content[index] = deepClone(isRecord(data.content_block) ? data.content_block : {})
    } else if (eventType === 'content_block_delta') {
      const delta = isRecord(data.delta) ? data.delta : {}
      const block = contentBlockForDelta(state.snapshot, data.index, delta)
      if (delta.type === 'text_delta') {
        block.text = stringOf(block.text) + stringOf(delta.text)
      } else if (delta.type === 'thinking_delta') {
        block.thinking = stringOf(block.thinking) + stringOf(delta.thinking)
        if (typeof delta.signature === 'string' && delta.signature) block.signature = delta.signature
      } else if (delta.type === 'input_json_delta') {
        block._partial_json = stringOf(block._partial_json) + stringOf(delta.partial_json)
      }
    } else if (eventType === 'content_block_stop') {
      const index = typeof data.index === 'number' ? data.index : 0
      const content = state.snapshot.content
      if (Array.isArray(content) && index >= 0 && index < content.length) {
        const block = content[index]
        if (isRecord(block) && typeof block._partial_json === 'string') {
          try {
            block.input = JSON.parse(block._partial_json)
          } catch {
            // partial JSON from a truncated stream — keep the previous input
          }
          delete block._partial_json
        }
      }
    } else if (eventType === 'message_delta') {
      const delta = isRecord(data.delta) ? data.delta : {}
      for (const [key, value] of Object.entries(delta)) state.snapshot[key] = value
      const usage = isRecord(data.usage) ? data.usage : null
      if (usage && Object.keys(usage).length > 0) {
        const existing = isRecord(state.snapshot.usage) ? state.snapshot.usage : {}
        state.snapshot.usage = { ...existing, ...normalizeUsageRecord(usage) }
      }
    }
  } catch {
    // malformed event payloads must never break reassembly
  }
}

function contentBlockForDelta(snapshot: JsonRecord, rawIndex: unknown, delta: JsonRecord): JsonRecord {
  const index = typeof rawIndex === 'number' && Number.isInteger(rawIndex) && rawIndex >= 0 ? rawIndex : 0
  const content = ensureContentArray(snapshot)
  while (content.length <= index) content.push(emptyContentBlockForDelta(delta))
  const existing = content[index]
  const block: JsonRecord = isRecord(existing) ? existing : emptyContentBlockForDelta(delta)
  content[index] = block
  if (Object.keys(block).length === 0) Object.assign(block, emptyContentBlockForDelta(delta))
  return block
}

function emptyContentBlockForDelta(delta: JsonRecord): JsonRecord {
  if (delta.type === 'thinking_delta') return { type: 'thinking', thinking: '' }
  if (delta.type === 'input_json_delta') return { type: 'tool_use', id: '', name: '', input: {} }
  return { type: 'text', text: '' }
}

function accumulateChatCompletionChunk(state: { snapshot: JsonRecord | null }, data: JsonRecord): void {
  const choices = Array.isArray(data.choices) ? data.choices : []
  const usage = isRecord(data.usage) ? data.usage : null

  if (choices.length === 0) {
    if (usage && state.snapshot) mergeChatCompletionUsage(state.snapshot, usage)
    return
  }

  const choice = isRecord(choices[0]) ? choices[0] : {}
  const delta = isRecord(choice.delta) ? choice.delta : {}
  const finishReason = choice.finish_reason
  const choiceUsage = isRecord(choice.usage) ? choice.usage : null

  if (!state.snapshot) {
    state.snapshot = {
      id: stringOf(data.id),
      object: 'chat.completion',
      model: stringOf(data.model),
      choices: [
        {
          index: 0,
          message: { role: typeof delta.role === 'string' && delta.role ? delta.role : 'assistant', content: '' },
          finish_reason: null,
        },
      ],
      content: [{ type: 'text', text: '' }],
    }
  }
  const snapshot = state.snapshot
  const firstChoice = Array.isArray(snapshot.choices) && isRecord(snapshot.choices[0]) ? snapshot.choices[0] : null
  const message = firstChoice && isRecord(firstChoice.message) ? firstChoice.message : null
  if (!firstChoice || !message) return
  const textBlock = chatCompletionTextBlock(snapshot)

  if (typeof delta.role === 'string' && delta.role) message.role = delta.role
  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
    message.reasoning_content = stringOf(message.reasoning_content) + delta.reasoning_content
    mirrorReasoningToContent(snapshot, message.reasoning_content as string)
  }
  if (typeof delta.content === 'string' && delta.content) {
    message.content = stringOf(message.content) + delta.content
    textBlock.text = stringOf(textBlock.text) + delta.content
  }

  const toolCallDeltas = Array.isArray(delta.tool_calls) ? delta.tool_calls : []
  for (const toolCallDelta of toolCallDeltas) {
    if (!isRecord(toolCallDelta)) continue
    const index = typeof toolCallDelta.index === 'number' && toolCallDelta.index >= 0 ? toolCallDelta.index : 0
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : (message.tool_calls = [])
    while (toolCalls.length <= index) {
      toolCalls.push({ id: '', type: 'function', function: { name: '', arguments: '' } })
    }
    const existing = isRecord(toolCalls[index]) ? toolCalls[index] as JsonRecord : (toolCalls[index] = {})
    if (typeof toolCallDelta.id === 'string') existing.id = toolCallDelta.id
    if (typeof toolCallDelta.type === 'string') existing.type = toolCallDelta.type
    const fnDelta = isRecord(toolCallDelta.function) ? toolCallDelta.function : {}
    const fn = isRecord(existing.function) ? existing.function : (existing.function = { name: '', arguments: '' })
    if (typeof fnDelta.name === 'string') fn.name = stringOf(fn.name) + fnDelta.name
    if (typeof fnDelta.arguments === 'string') fn.arguments = stringOf(fn.arguments) + fnDelta.arguments
    mirrorToolCallToContent(snapshot, index, existing)
  }

  if (finishReason) firstChoice.finish_reason = finishReason
  if (usage) mergeChatCompletionUsage(snapshot, usage)
  if (choiceUsage) mergeChatCompletionUsage(snapshot, choiceUsage)
}

function mirrorToolCallToContent(snapshot: JsonRecord, index: number, toolCall: JsonRecord): void {
  const content = ensureContentArray(snapshot)
  const offset = 1 + (chatCompletionThinkingBlock(snapshot, { create: false }) ? 1 : 0)
  const target = index + offset
  while (content.length <= target) {
    content.push({ type: 'tool_use', id: '', name: '', input: {} })
  }
  const block = isRecord(content[target]) ? content[target] as JsonRecord : (content[target] = { type: 'tool_use', id: '', name: '', input: {} })
  if (toolCall.id) block.id = toolCall.id
  const fn = isRecord(toolCall.function) ? toolCall.function : {}
  if (fn.name) block.name = fn.name
  const argsText = stringOf(fn.arguments)
  if (argsText) {
    try {
      block.input = JSON.parse(argsText)
    } catch {
      // arguments are still streaming; keep the previously parsed input
    }
  }
}

function chatCompletionTextBlock(snapshot: JsonRecord): JsonRecord {
  const content = ensureContentArray(snapshot)
  for (const block of content) {
    if (isRecord(block) && block.type === 'text') return block
  }
  const block: JsonRecord = { type: 'text', text: '' }
  content.push(block)
  return block
}

function chatCompletionThinkingBlock(snapshot: JsonRecord, options: { create: boolean }): JsonRecord | null {
  const content = ensureContentArray(snapshot)
  for (const block of content) {
    if (isRecord(block) && block.type === 'thinking') return block
  }
  if (!options.create) return null
  const block: JsonRecord = { type: 'thinking', thinking: '' }
  content.unshift(block)
  return block
}

function mirrorReasoningToContent(snapshot: JsonRecord, reasoning: string): void {
  const block = chatCompletionThinkingBlock(snapshot, { create: true })
  if (block) block.thinking = reasoning
}

function mergeChatCompletionUsage(snapshot: JsonRecord, usage: JsonRecord): void {
  snapshot.usage = normalizeUsageRecord(usage)
}

function normalizeUsageRecord(usage: JsonRecord): JsonRecord {
  const normalized: JsonRecord = { ...usage }
  const fillToken = (target: string, sources: string[]) => {
    for (const source of sources) {
      if (!missingOrZero(normalized[target])) return
      if (!missingOrZero(usage[source])) normalized[target] = usage[source]
    }
  }
  fillToken('input_tokens', ['prompt_tokens', 'promptTokenCount', 'inputTokens'])
  fillToken('output_tokens', ['completion_tokens', 'candidatesTokenCount', 'outputTokens'])
  fillToken('total_tokens', ['totalTokens'])

  if (!('cache_read_input_tokens' in normalized)) {
    let cached = usage.cached_tokens ?? usage.cachedContentTokenCount ?? usage.cacheReadInputTokens
    if (cached === undefined || cached === null) {
      for (const detailsKey of ['input_tokens_details', 'prompt_tokens_details']) {
        const details = usage[detailsKey]
        if (isRecord(details) && details.cached_tokens !== undefined && details.cached_tokens !== null) {
          cached = details.cached_tokens
          break
        }
      }
    }
    if (cached !== undefined && cached !== null) normalized.cache_read_input_tokens = cached
  }

  if (!('cache_creation_input_tokens' in normalized)) {
    const cacheWrite = usage.cacheWriteInputTokens
    if (cacheWrite !== undefined && cacheWrite !== null) normalized.cache_creation_input_tokens = cacheWrite
  }

  return normalized
}

function snapshotToResult(snapshot: JsonRecord): ReassembledSse {
  const rawContent = Array.isArray(snapshot.content) ? snapshot.content : []
  const blocks = rawContent
    .map((block) => normalizeContentBlock(block))
    .filter((block): block is NormalizedBlock => block !== null)
  const stopReason = pickStopReason(snapshot)
  const model = typeof snapshot.model === 'string' && snapshot.model ? snapshot.model : undefined
  return {
    message: { role: 'assistant', content: blocks },
    usage: normalizeUsageValue(snapshot.usage),
    ...(stopReason ? { stopReason } : {}),
    ...(model ? { model } : {}),
  }
}

function pickStopReason(snapshot: JsonRecord): string | undefined {
  if (typeof snapshot.stop_reason === 'string' && snapshot.stop_reason) return snapshot.stop_reason
  const firstChoice = Array.isArray(snapshot.choices) && isRecord(snapshot.choices[0]) ? snapshot.choices[0] : null
  if (firstChoice && typeof firstChoice.finish_reason === 'string' && firstChoice.finish_reason) {
    return firstChoice.finish_reason
  }
  return undefined
}

export function normalizeUsageValue(value: unknown): NormalizedUsage | null {
  if (!isRecord(value)) return null
  const normalized = normalizeUsageRecord(value)
  const inputTokens = numberOf(normalized.input_tokens)
  const outputTokens = numberOf(normalized.output_tokens)
  const cacheRead = numberOf(normalized.cache_read_input_tokens)
  const cacheCreation = numberOf(normalized.cache_creation_input_tokens)
  if (inputTokens === undefined && outputTokens === undefined && cacheRead === undefined && cacheCreation === undefined) {
    return null
  }
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    ...(cacheRead !== undefined ? { cacheReadInputTokens: cacheRead } : {}),
    ...(cacheCreation !== undefined ? { cacheCreationInputTokens: cacheCreation } : {}),
  }
}

export function normalizeContentBlock(block: unknown): NormalizedBlock | null {
  if (typeof block === 'string') return { type: 'text', text: block }
  if (!isRecord(block)) return null
  switch (block.type) {
    case 'text':
      return { type: 'text', text: stringOf(block.text) }
    case 'thinking':
      return { type: 'thinking', thinking: stringOf(block.thinking) }
    case 'redacted_thinking':
      return { type: 'thinking', thinking: '[redacted thinking]' }
    case 'tool_use':
      return {
        type: 'tool_use',
        ...(typeof block.id === 'string' && block.id ? { id: block.id } : {}),
        name: stringOf(block.name),
        input: block.input,
      }
    case 'tool_result':
      return {
        type: 'tool_result',
        ...(typeof block.tool_use_id === 'string' && block.tool_use_id ? { toolUseId: block.tool_use_id } : {}),
        content: block.content,
        ...(block.is_error === true ? { isError: true } : {}),
      }
    case 'image': {
      const source = isRecord(block.source) ? block.source : {}
      const mediaType = typeof source.media_type === 'string' ? source.media_type : undefined
      const dataUrl = source.type === 'base64' && typeof source.data === 'string'
        ? `data:${mediaType ?? 'image/png'};base64,${source.data}`
        : source.type === 'url' && typeof source.url === 'string'
          ? source.url
          : undefined
      return {
        type: 'image',
        ...(mediaType ? { mediaType } : {}),
        ...(dataUrl ? { dataUrl } : {}),
      }
    }
    default:
      return { type: 'text', text: safeJsonStringify(block) }
  }
}

function ensureContentArray(snapshot: JsonRecord): unknown[] {
  if (!Array.isArray(snapshot.content)) snapshot.content = []
  return snapshot.content as unknown[]
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function missingOrZero(value: unknown): boolean {
  return value === undefined || value === null || value === 0
}

function deepClone(value: JsonRecord): JsonRecord {
  try {
    return JSON.parse(JSON.stringify(value)) as JsonRecord
  } catch {
    return { ...value }
  }
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
