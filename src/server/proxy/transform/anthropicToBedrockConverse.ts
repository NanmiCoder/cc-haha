/**
 * Request transformation: Anthropic Messages → AWS Bedrock Runtime Converse API.
 *
 * Modeled on `@ai-sdk/amazon-bedrock` (`convert-to-amazon-bedrock-chat-messages.ts`,
 * `amazon-bedrock-prepare-tools.ts`, `amazon-bedrock-chat-language-model.ts`)
 * and AWS Bedrock Runtime REST API documentation.
 */

import type { OutputConfig } from '@aws-sdk/client-bedrock-runtime'
import type { AnthropicContentBlock, AnthropicImageSource, AnthropicRequest } from './types.js'
import { stripLeadingBillingHeader } from './billingHeader.js'
import { documentProvenanceText, searchResultToText } from './anthropicToOpenaiChat.js'
import { decodeGeminiThoughtSignature } from './anthropicToGemini.js'
import { normalizeOpenAIReasoningEffort } from './effort.js'
import { RequestCompatibilityError, resolveRequestCompatibility, type RequestCompatibilityOptions } from './requestCompatibility.js'

const BEDROCK_IMAGE_MIME_TYPES: Record<string, 'jpeg' | 'png' | 'gif' | 'webp'> = {
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

const BEDROCK_DOCUMENT_MIME_TYPES: Record<string, 'pdf' | 'csv' | 'doc' | 'docx' | 'xls' | 'xlsx' | 'html' | 'txt' | 'md'> = {
  'application/pdf': 'pdf',
  'text/csv': 'csv',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/html': 'html',
  'text/plain': 'txt',
  'text/markdown': 'md',
}

export type BedrockImageBlock = {
  image: {
    format: 'jpeg' | 'png' | 'gif' | 'webp'
    source: { bytes: string }
  }
}

export type BedrockDocumentBlock = {
  document: {
    format: 'pdf' | 'csv' | 'doc' | 'docx' | 'xls' | 'xlsx' | 'html' | 'txt' | 'md'
    name: string
    source: { bytes: string }
  }
}

export type BedrockToolResultContentBlock =
  | { text: string }
  | BedrockImageBlock
  | BedrockDocumentBlock

export type BedrockContentBlock =
  | { text: string }
  | BedrockImageBlock
  | BedrockDocumentBlock
  | { toolUse: { toolUseId: string; name: string; input: Record<string, unknown> } }
  | { toolResult: { toolUseId: string; content: BedrockToolResultContentBlock[]; status?: 'success' | 'error' } }
  | { reasoningContent: { reasoningText: { text: string; signature?: string } } }
  | { reasoningContent: { redactedContent: string } }

export type BedrockMessage = {
  role: 'user' | 'assistant'
  content: BedrockContentBlock[]
}

export type BedrockToolSpec = {
  toolSpec: {
    name: string
    description?: string
    inputSchema: { json: Record<string, unknown> }
  }
}

export type BedrockToolConfig = {
  tools: BedrockToolSpec[]
  toolChoice?:
    | { auto: Record<string, never> }
    | { any: Record<string, never> }
    | { tool: { name: string } }
}

export type BedrockConverseRequest = {
  system?: Array<{ text: string }>
  messages: BedrockMessage[]
  inferenceConfig?: {
    maxTokens?: number
    temperature?: number
    topP?: number
    stopSequences?: string[]
  }
  toolConfig?: BedrockToolConfig
  outputConfig?: OutputConfig
  additionalModelRequestFields?: Record<string, unknown>
  additionalModelResponseFieldPaths?: string[]
  serviceTier?: { type: 'default' | 'flex' | 'priority' }
}

export type BedrockConverseTransformOptions = RequestCompatibilityOptions & {
  /**
   * When `false`, images and documents inside `tool_result` blocks are hoisted
   * into the same Bedrock user turn right after the `toolResult` block instead
   * of nested inside `toolResult.content`. Defaults to `true` (supported natively
   * by Claude and Amazon Nova on Bedrock).
   */
  supportsNestedToolResultMedia?: boolean
}

export function isBedrockAnthropicModel(modelId: string): boolean {
  return /(?:^|[.:/])(?:anthropic\.)?claude-/i.test(modelId.trim())
}

export function isBedrockNovaModel(modelId: string): boolean {
  return /(?:^|[.:/])(?:amazon\.)?nova-/i.test(modelId.trim())
}

function isBedrockNova2Model(modelId: string): boolean {
  return /(?:^|[.:/])(?:amazon\.)?nova-2/i.test(modelId.trim())
}

function isBedrockOpenaiModel(modelId: string): boolean {
  return /(?:^|[.:/])openai\./i.test(modelId.trim())
}

function isBedrockOpenaiGptOssModel(modelId: string): boolean {
  return /(?:^|[.:/])openai\.gpt-oss/i.test(modelId.trim())
}

export function isBedrockMistralModel(modelId: string): boolean {
  return /(?:^|[.:/])mistral\./i.test(modelId.trim())
}

function isLegacyBedrockClaude(modelId: string): boolean {
  return /claude-(?:instant|v?2|3-(?:5-)?(?:haiku|sonnet|opus))(?=[-.:]|$)/i.test(modelId.trim())
}

// Mistral on Bedrock requires tool call IDs to match `^[a-zA-Z0-9]{9}$`
// (same deterministic FNV-1a base62 hash as `@ai-sdk/amazon-bedrock`).
const BASE62_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const BASE62_LENGTH = BigInt(BASE62_CHARS.length)
const MISTRAL_ID_LENGTH = 9
const MISTRAL_ID_SPACE = BASE62_LENGTH ** BigInt(MISTRAL_ID_LENGTH)
const FNV_OFFSET_BASIS_64 = BigInt('14695981039346656037')
const FNV_PRIME_64 = BigInt('1099511628211')
const FNV_64_MASK = BigInt('18446744073709551615')

export function normalizeBedrockToolCallId(toolCallId: string, isMistral: boolean): string {
  if (!isMistral || /^[a-zA-Z0-9]{9}$/.test(toolCallId)) return toolCallId
  let hash = FNV_OFFSET_BASIS_64
  for (let i = 0; i < toolCallId.length; i++) {
    hash ^= BigInt(toolCallId.charCodeAt(i))
    hash = (hash * FNV_PRIME_64) & FNV_64_MASK
  }
  let value = hash % MISTRAL_ID_SPACE
  let result = ''
  for (let i = 0; i < MISTRAL_ID_LENGTH; i++) {
    result = BASE62_CHARS[Number(value % BASE62_LENGTH)] + result
    value /= BASE62_LENGTH
  }
  return result
}

function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '') || '_'
}

function sanitizeDocumentName(rawName: string | undefined, usedNames: Set<string>, counter: { value: number }): string {
  const withoutExt = rawName ? rawName.replace(/\.[^./\\]+$/, '') : ''
  const cleaned = withoutExt
    .replace(/\s+/g, ' ')
    .replace(/[^a-zA-Z0-9 ()[\]-]/g, '')
    .trim()
    .slice(0, 200)
    .trim()
  const baseName = cleaned || `document-${++counter.value}`
  let name = baseName
  for (let suffix = 2; usedNames.has(name); suffix++) {
    const suffixText = ` (${suffix})`
    name = `${baseName.slice(0, 200 - suffixText.length).trim()}${suffixText}`
  }
  usedNames.add(name)
  return name
}

function toBedrockToolInput(input: unknown): Record<string, unknown> {
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>
  }
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input) as unknown
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // Malformed string falls through to empty object.
    }
  }
  return {}
}

function isForeignSignature(value: string): boolean {
  return decodeGeminiThoughtSignature(value) !== undefined
}

export function anthropicToBedrockConverse(
  body: AnthropicRequest,
  options: BedrockConverseTransformOptions = {},
): BedrockConverseRequest {
  const compatibility = resolveRequestCompatibility(body, { ...options, protocol: 'bedrock_converse' })
  const isAnthropic = isBedrockAnthropicModel(body.model)
  const isNova = isBedrockNovaModel(body.model)
  const isOpenai = isBedrockOpenaiModel(body.model)
  const isGptOss = isBedrockOpenaiGptOssModel(body.model)
  const isMistral = isBedrockMistralModel(body.model)
  const allowNestedMedia = options.supportsNestedToolResultMedia !== false

  const additionalModelRequestFields: Record<string, unknown> = {}

  // Tools and toolChoice
  const rawTools = (body.tools ?? []).filter((tool) => tool.name !== 'BatchTool' && tool.input_schema)
  const parsedChoice = parseToolChoice(body.tool_choice)
  const toolChoiceNone = parsedChoice?.type === 'none'
  const activeTools = toolChoiceNone ? [] : rawTools
  const hasTools = activeTools.length > 0

  let toolConfig: BedrockToolConfig | undefined
  if (hasTools) {
    const toolSpecs: BedrockToolSpec[] = activeTools.map((tool) => ({
      toolSpec: {
        name: sanitizeToolName(tool.name),
        ...(tool.description?.trim() ? { description: tool.description } : {}),
        inputSchema: { json: tool.input_schema },
      },
    }))

    // For Claude on Bedrock, `disable_parallel_tool_use` must go into
    // `additionalModelRequestFields.tool_choice` instead of `toolConfig.toolChoice`.
    if (isAnthropic && compatibility.parallelToolCalls === false) {
      if (parsedChoice?.type === 'any') {
        additionalModelRequestFields.tool_choice = { type: 'any', disable_parallel_tool_use: true }
      } else if (parsedChoice?.type === 'tool' && parsedChoice.name) {
        additionalModelRequestFields.tool_choice = {
          type: 'tool',
          name: sanitizeToolName(parsedChoice.name),
          disable_parallel_tool_use: true,
        }
      } else {
        additionalModelRequestFields.tool_choice = { type: 'auto', disable_parallel_tool_use: true }
      }
      toolConfig = { tools: toolSpecs }
    } else {
      const toolChoice = toBedrockToolChoice(parsedChoice, toolSpecs.map((spec) => spec.toolSpec.name))
      toolConfig = {
        tools: toolSpecs,
        ...(toolChoice ? { toolChoice } : {}),
      }
    }
  }

  // System prompt (drop rotating billing attribution header for prompt caching)
  const systemBlocks = (typeof body.system === 'string' ? [body.system] : (body.system ?? []).map((b) => b.text))
    .map(stripLeadingBillingHeader)
    .filter(Boolean)
    .map((text) => ({ text }))

  // Inference config
  const inferenceConfig: NonNullable<BedrockConverseRequest['inferenceConfig']> = {}
  if (compatibility.outputBudget.field !== 'omit' && compatibility.outputBudget.effective !== undefined) {
    inferenceConfig.maxTokens = compatibility.outputBudget.effective
  }
  if (compatibility.passSamplingParams) {
    if (body.temperature !== undefined) {
      inferenceConfig.temperature = Math.min(1, Math.max(0, body.temperature))
    }
    if (body.top_p !== undefined) {
      inferenceConfig.topP = body.top_p
    }
  }
  if (body.stop_sequences?.length) {
    inferenceConfig.stopSequences = body.stop_sequences
  }

  // Reasoning / thinking configuration per Bedrock model family
  let anthropicThinkingEnabled = false
  if (compatibility.passReasoning) {
    const thinkingType = body.thinking?.type
    const rawBudget = body.thinking?.budget_tokens
    const budget = typeof rawBudget === 'number' && Number.isSafeInteger(rawBudget) && rawBudget > 0
      ? rawBudget
      : undefined
    const effort = normalizeOpenAIReasoningEffort(body.output_config?.effort)

    if (isAnthropic) {
      if (thinkingType === 'enabled' && budget !== undefined) {
        anthropicThinkingEnabled = true
        additionalModelRequestFields.thinking = {
          type: 'enabled',
          budget_tokens: budget,
        }
        // Bedrock requires maxTokens > budget_tokens. Reserve room for the
        // answer within the endpoint limit or reject the conflicting budgets.
        const hardLimit = compatibility.outputBudget.hardLimit
        if (hardLimit !== undefined && hardLimit <= budget) {
          throw new RequestCompatibilityError(`Bedrock thinking budget (${budget}) must be below the endpoint output limit (${hardLimit})`)
        }
        if (inferenceConfig.maxTokens === undefined || inferenceConfig.maxTokens <= budget) {
          const desired = budget + (inferenceConfig.maxTokens === undefined ? 4096 : 1024)
          inferenceConfig.maxTokens = hardLimit === undefined ? desired : Math.min(desired, hardLimit)
        }
      } else if (thinkingType === 'adaptive') {
        anthropicThinkingEnabled = true
        additionalModelRequestFields.thinking = { type: 'adaptive' }
      } else if (thinkingType === 'disabled' && !isLegacyBedrockClaude(body.model)) {
        additionalModelRequestFields.thinking = { type: 'disabled' }
      }
      if (effort && effort !== 'none') {
        additionalModelRequestFields.output_config = {
          effort,
        }
      }
    } else if (isOpenai) {
      if (effort && effort !== 'none') {
        if (isGptOss) {
          additionalModelRequestFields.reasoning_effort = effort
        } else {
          additionalModelRequestFields.reasoning = { effort }
        }
      }
    } else if (isNova) {
      const novaEffort = effort && effort !== 'none'
        ? (effort === 'low' || effort === 'minimal' ? 'low' : effort === 'medium' ? 'medium' : 'high')
        : budget !== undefined
          ? (budget <= 1024 ? 'low' : budget <= 8192 ? 'medium' : 'high')
          : undefined
      if (thinkingType !== 'disabled' && (thinkingType === 'enabled' || thinkingType === 'adaptive' || novaEffort)) {
        const resolvedEffort = novaEffort ?? 'medium'
        additionalModelRequestFields.reasoningConfig = {
          type: 'enabled',
          maxReasoningEffort: resolvedEffort,
        }
        // Per @ai-sdk/amazon-bedrock: Nova 2 rejects maxTokens when high reasoning is enabled.
        if (isBedrockNova2Model(body.model) && resolvedEffort === 'high') {
          if (compatibility.outputBudget.hardLimit !== undefined) {
            throw new RequestCompatibilityError('Nova 2 high reasoning cannot honor an endpoint output limit')
          }
          delete inferenceConfig.maxTokens
        }
      }
    }
  }

  // Bedrock Anthropic rejects temperature and topP when thinking is enabled,
  // and Claude 4.5+/4.6 rejects specifying both temperature and topP together.
  if (anthropicThinkingEnabled) {
    delete inferenceConfig.temperature
    delete inferenceConfig.topP
  } else if (isAnthropic && inferenceConfig.temperature !== undefined && inferenceConfig.topP !== undefined) {
    delete inferenceConfig.topP
  }

  // OpenAI models on Bedrock reject stopSequences (and non-gpt-oss reject temperature/topP).
  if (isOpenai) {
    delete inferenceConfig.stopSequences
    if (!isGptOss) {
      delete inferenceConfig.temperature
      delete inferenceConfig.topP
    }
  }

  const messages = convertMessages(body, {
    hasTools,
    isMistral,
    allowNestedMedia,
  })

  const result: BedrockConverseRequest = {
    ...(systemBlocks.length > 0 ? { system: systemBlocks } : {}),
    messages,
    ...(Object.keys(inferenceConfig).length > 0 ? { inferenceConfig } : {}),
    ...(toolConfig ? { toolConfig } : {}),
    ...(Object.keys(additionalModelRequestFields).length > 0 ? { additionalModelRequestFields } : {}),
    ...(isAnthropic ? { additionalModelResponseFieldPaths: ['/delta/stop_sequence'] } : {}),
    ...(compatibility.serviceTier && compatibility.serviceTier !== 'auto'
      ? { serviceTier: { type: compatibility.serviceTier } }
      : {}),
  }

  const format = compatibility.structuredOutput
  if (format) {
    result.outputConfig = {
      textFormat: {
        type: 'json_schema',
        structure: {
          jsonSchema: { name: format.name, description: format.description, schema: JSON.stringify(format.schema) },
        },
      },
    }
  }
  return result
}

function parseToolChoice(choice: unknown): { type?: string; name?: string } | undefined {
  if (typeof choice === 'string') return { type: choice }
  if (!isRecord(choice)) return undefined
  return {
    type: typeof choice.type === 'string' ? choice.type : undefined,
    name: typeof choice.name === 'string' ? choice.name : undefined,
  }
}

function toBedrockToolChoice(
  choice: { type?: string; name?: string } | undefined,
  toolNames: string[],
): BedrockToolConfig['toolChoice'] {
  if (!choice?.type) return undefined
  if (choice.type === 'auto') return { auto: {} }
  if (choice.type === 'any') return { any: {} }
  if (choice.type === 'tool' && choice.name) {
    const sanitized = sanitizeToolName(choice.name)
    if (toolNames.includes(sanitized)) return { tool: { name: sanitized } }
  }
  return undefined
}

function convertMessages(
  body: AnthropicRequest,
  context: { hasTools: boolean; isMistral: boolean; allowNestedMedia: boolean },
): BedrockMessage[] {
  const messages: BedrockMessage[] = []
  const usedDocNames = new Set<string>()
  const docCounter = { value: 0 }

  for (const message of body.messages) {
    const blocks: AnthropicContentBlock[] = typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : message.content

    if (message.role === 'assistant') {
      const converted = convertAssistantBlocks(blocks, context)
      if (converted.length === 0) continue
      const prev = messages.at(-1)
      if (prev?.role === 'assistant') {
        prev.content.push(...converted)
      } else {
        messages.push({ role: 'assistant', content: converted })
      }
      continue
    }

    const converted = convertUserBlocks(blocks, context, usedDocNames, docCounter)
    if (converted.length === 0) continue
    const prev = messages.at(-1)
    if (prev?.role === 'user') {
      prev.content.push(...converted)
    } else {
      messages.push({ role: 'user', content: converted })
    }
  }

  // Bedrock rejects trailing whitespace in pre-filled assistant messages AND
  // rejects empty `{ text: "" }` content blocks (`minLength: 1`).
  const last = messages.at(-1)
  if (last?.role === 'assistant') {
    const lastBlock = last.content.at(-1)
    if (lastBlock && 'text' in lastBlock) {
      const trimmed = lastBlock.text.trimEnd()
      if (trimmed.length > 0) {
        lastBlock.text = trimmed
      } else {
        last.content.pop()
        if (last.content.length === 0) messages.pop()
      }
    }
  }

  return messages
}

function convertAssistantBlocks(
  blocks: AnthropicContentBlock[],
  context: { hasTools: boolean; isMistral: boolean },
): BedrockContentBlock[] {
  const content: BedrockContentBlock[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text) content.push({ text: block.text })
    } else if (block.type === 'thinking') {
      // Only replay signed reasoning blocks (excluding foreign Gemini thought signatures).
      // Unsigned reasoning is intentionally skipped, matching `@ai-sdk/amazon-bedrock`.
      if (block.signature && !isForeignSignature(block.signature)) {
        content.push({
          reasoningContent: {
            reasoningText: {
              text: block.thinking,
              signature: block.signature,
            },
          },
        })
      }
    } else if (block.type === 'redacted_thinking') {
      if (block.data && !isForeignSignature(block.data)) {
        content.push({
          reasoningContent: {
            redactedContent: block.data,
          },
        })
      }
    } else if (block.type === 'tool_use') {
      if (context.hasTools) {
        content.push({
          toolUse: {
            toolUseId: normalizeBedrockToolCallId(block.id, context.isMistral),
            name: sanitizeToolName(block.name),
            input: toBedrockToolInput(block.input),
          },
        })
      } else {
        // Bedrock rejects `toolUse` when `toolConfig` is absent.
        content.push({
          text: `[Tool call ${block.name}(${JSON.stringify(toBedrockToolInput(block.input))})]`,
        })
      }
    }
  }
  return content
}

function convertUserBlocks(
  blocks: AnthropicContentBlock[],
  context: { hasTools: boolean; isMistral: boolean; allowNestedMedia: boolean },
  usedDocNames: Set<string>,
  docCounter: { value: number },
): BedrockContentBlock[] {
  const toolResults: BedrockContentBlock[] = []
  const others: BedrockContentBlock[] = []

  for (const block of blocks) {
    if (block.type === 'tool_result') {
      const converted = convertToolResult(block, context, usedDocNames, docCounter)
      toolResults.push(...converted.primary)
      others.push(...converted.hoisted)
    } else {
      others.push(...convertUserMediaOrTextBlock(block, usedDocNames, docCounter))
    }
  }

  return [...toolResults, ...others]
}

function convertToolResult(
  block: Extract<AnthropicContentBlock, { type: 'tool_result' }>,
  context: { hasTools: boolean; isMistral: boolean; allowNestedMedia: boolean },
  usedDocNames: Set<string>,
  docCounter: { value: number },
): { primary: BedrockContentBlock[]; hoisted: BedrockContentBlock[] } {
  const items: AnthropicContentBlock[] = typeof block.content === 'string'
    ? [{ type: 'text', text: block.content }]
    : block.content ?? []

  const nestedContent: BedrockToolResultContentBlock[] = []
  const hoisted: BedrockContentBlock[] = []

  for (const item of items) {
    for (const part of convertUserMediaOrTextBlock(item, usedDocNames, docCounter)) {
      if ('image' in part || 'document' in part) {
        if (context.allowNestedMedia && context.hasTools) {
          nestedContent.push(part)
        } else {
          hoisted.push(part)
        }
      } else if ('text' in part) {
        nestedContent.push(part)
      }
    }
  }

  if (hoisted.length > 0) {
    hoisted.unshift({ text: `[Media content for tool call ${block.tool_use_id}]` })
  }

  if (!context.hasTools) {
    // Bedrock rejects `toolResult` when `toolConfig` is absent.
    const textSummary = nestedContent
      .filter((item): item is { text: string } => 'text' in item)
      .map((item) => item.text)
      .join('\n')
    return {
      primary: [{
        text: `[Tool result ${block.tool_use_id}${block.is_error ? ' (error)' : ''}]: ${textSummary || '(empty)'}`,
      }],
      hoisted,
    }
  }

  if (nestedContent.length === 0) {
    // Bedrock Converse enforces `minLength: 1` on `ToolResultContentBlock.text`.
    nestedContent.push({
      text: hoisted.length > 0 ? 'Media result attached after this tool result.' : '(empty)',
    })
  }

  return {
    primary: [{
      toolResult: {
        toolUseId: normalizeBedrockToolCallId(block.tool_use_id, context.isMistral),
        content: nestedContent,
        ...(block.is_error ? { status: 'error' } : {}),
      },
    }],
    hoisted,
  }
}

function convertUserMediaOrTextBlock(
  block: AnthropicContentBlock,
  usedDocNames: Set<string>,
  docCounter: { value: number },
): Array<{ text: string } | BedrockImageBlock | BedrockDocumentBlock> {
  switch (block.type) {
    case 'text':
      return block.text ? [{ text: block.text }] : []
    case 'image':
      return [convertImageBlock(block.source)]
    case 'search_result': {
      const text = searchResultToText(block)
      return text ? [{ text }] : []
    }
    case 'document':
      return convertDocumentBlock(block, usedDocNames, docCounter)
    default:
      return []
  }
}

function convertImageBlock(source: AnthropicImageSource): { text: string } | BedrockImageBlock {
  if (source.type === 'base64') {
    if (!source.data) return { text: '[Image omitted: empty base64 image payload.]' }
    const format = BEDROCK_IMAGE_MIME_TYPES[source.media_type.trim().toLowerCase()]
    if (!format) {
      return { text: `[Image omitted: unsupported Bedrock image format ${source.media_type}.]` }
    }
    return {
      image: {
        format,
        source: { bytes: source.data },
      },
    }
  }
  if (source.type === 'url') return { text: `[Image: ${source.url}]` }
  return { text: '[Image omitted: file-based image source is not supported by this endpoint.]' }
}

function convertDocumentBlock(
  block: Extract<AnthropicContentBlock, { type: 'document' }>,
  usedDocNames: Set<string>,
  docCounter: { value: number },
): Array<{ text: string } | BedrockImageBlock | BedrockDocumentBlock> {
  const provenance = documentProvenanceText(block)
  const source = block.source
  if (source.type === 'text') {
    return [{ text: `${provenance}${source.data}` }]
  }
  if (source.type === 'base64') {
    if (!source.data) {
      const label = block.title ?? 'document'
      return [{ text: `${provenance}[Document: ${label} omitted — empty base64 payload]` }]
    }
    const format = BEDROCK_DOCUMENT_MIME_TYPES[source.media_type.trim().toLowerCase()]
    if (!format) {
      const label = block.title ?? 'document'
      return [{ text: `${provenance}[Document: ${label} omitted — unsupported Bedrock document type ${source.media_type}]` }]
    }
    return [
      ...(provenance ? [{ text: provenance }] : []),
      {
        document: {
          format,
          name: sanitizeDocumentName(block.title, usedDocNames, docCounter),
          source: { bytes: source.data },
        },
      },
    ]
  }
  if (source.type === 'content') {
    const parts: Array<{ text: string } | BedrockImageBlock | BedrockDocumentBlock> = provenance
      ? [{ text: provenance }]
      : []
    if (typeof source.content === 'string') {
      return [...parts, { text: source.content }]
    }
    for (const item of source.content) {
      if (item.type === 'text') {
        if (item.text) parts.push({ text: item.text })
      } else {
        parts.push(convertImageBlock(item.source))
      }
    }
    return parts
  }
  const contextPrefix = block.context ? `[Document context: ${block.context}]\n` : ''
  const label = block.title ?? (source.type === 'url' ? source.url : 'file')
  return [{
    text: source.type === 'url'
      ? `${contextPrefix}[Document: ${label}](${source.url})`
      : `${contextPrefix}[Document: ${label} omitted — file-based source]`,
  }]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
