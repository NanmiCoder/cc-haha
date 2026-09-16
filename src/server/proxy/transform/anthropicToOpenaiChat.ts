/**
 * Request transformation: Anthropic Messages → OpenAI Chat Completions
 * Derived from cc-switch (https://github.com/farion1231/cc-switch)
 * Original work by Jason Young, MIT License
 */

import type {
  AnthropicRequest,
  AnthropicContentBlock,
  AnthropicMessage,
  OpenAIChatRequest,
  OpenAIChatMessage,
  OpenAIChatContentPart,
  OpenAIToolCall,
  OpenAITool,
} from './types.js'
import { stripLeadingBillingHeader } from './billingHeader.js'
import { normalizeOpenAIReasoningEffort } from './effort.js'
import { resolveRequestCompatibility, type RequestCompatibilityOptions } from './requestCompatibility.js'

type OpenAIChatImageContentMode = 'vision' | 'text_only'

// Synthetic text parts (degraded documents, search results) carry an internal
// marker so serializers can preserve their boundaries. The marker is removed
// before content parts reach the wire.
type UserTextPart = OpenAIChatContentPart & { synthetic?: boolean }

export type OpenAIChatTransformOptions = RequestCompatibilityOptions & {
  roundTripReasoningContent?: boolean
  passThinkingToggle?: boolean
  passSamplingParams?: boolean
  imageContentMode?: OpenAIChatImageContentMode
}

// Synthetic degradation text carries its own separators: the parts are
// joined without a separator, so a notice must not glue itself to the
// surrounding user text.
const OMITTED_IMAGE_TEXT = '\n[Image omitted: this OpenAI-compatible chat endpoint only supports text content.]\n'
const FILE_IMAGE_OMITTED_TEXT = '\n[Image omitted: file-based image source is not supported by this endpoint.]\n'
const MEDIA_RESULT_ATTACHED_TEXT = 'Media result attached after this tool result.'
const DOCUMENT_TEXT_INLINE_LIMIT = 2000

/**
 * Convert Anthropic Messages request to OpenAI Chat Completions request.
 */
export function anthropicToOpenaiChat(
  body: AnthropicRequest,
  options: OpenAIChatTransformOptions = {},
): OpenAIChatRequest {
  const compatibility = resolveRequestCompatibility(body, { ...options, protocol: 'openai_chat' })
  const messages: OpenAIChatMessage[] = []

  // Convert system prompt, minus the leading billing attribution: its
  // rotating cch= signature would change the prefix every turn and defeat
  // upstream prompt caching.
  if (body.system) {
    const text = typeof body.system === 'string'
      ? stripLeadingBillingHeader(body.system)
      : body.system.map((b) => stripLeadingBillingHeader(b.text)).filter(Boolean).join('\n')
    if (text) {
      messages.push({ role: 'system', content: text })
    }
  }

  // Convert messages
  const messageOptions = compatibility.passReasoning ? options : { ...options, roundTripReasoningContent: false }
  for (const msg of body.messages) {
    convertMessage(msg, messages, messageOptions)
  }

  // Build request
  const result: OpenAIChatRequest = {
    model: body.model,
    messages,
    stream: body.stream === true,
  }

  // Many OpenAI-compatible servers omit usage on streams unless asked.
  if (result.stream) {
    result.stream_options = { include_usage: true }
  }

  const { outputBudget } = compatibility
  if (outputBudget.field === 'max_tokens' || outputBudget.field === 'max_completion_tokens') {
    result[outputBudget.field] = outputBudget.effective
  }

  // Claude Code sends Anthropic sampling params that some compatible
  // providers reject. Keep them opt-in for providers known to accept them.
  if (compatibility.passSamplingParams) {
    if (body.temperature !== undefined) result.temperature = body.temperature
    if (body.top_p !== undefined) result.top_p = body.top_p
  }

  // stop_sequences → stop
  if (body.stop_sequences && body.stop_sequences.length > 0) {
    result.stop = body.stop_sequences
  }

  // tools
  if (body.tools && body.tools.length > 0) {
    const tools = body.tools
      .filter((t) => t.name !== 'BatchTool')
      .map((t): OpenAITool => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        },
      }))
    if (tools.length > 0) result.tools = tools
  }

  // tool_choice
  if (body.tool_choice !== undefined) {
    const choice = convertToolChoice(body.tool_choice)
    const selectedName = typeof choice === 'object' && choice !== null
      ? (choice as { function?: { name?: string } }).function?.name : undefined
    if (result.tools?.length && (!selectedName || result.tools.some(tool => tool.function.name === selectedName))) {
      result.tool_choice = choice
    }
  }

  // thinking → reasoning_effort
  if (compatibility.passReasoning && body.thinking) {
    const budget = body.thinking.budget_tokens
    if (budget !== undefined) {
      if (budget <= 1024) result.reasoning_effort = 'low'
      else if (budget <= 8192) result.reasoning_effort = 'medium'
      else result.reasoning_effort = 'high'
    } else if (body.thinking.type === 'enabled') {
      result.reasoning_effort = 'high'
    }
    if (options.passThinkingToggle) {
      result.thinking = { type: body.thinking.type }
    }
  }
  const outputConfigEffort = normalizeOpenAIReasoningEffort(body.output_config?.effort)
  if (compatibility.passReasoning && outputConfigEffort !== undefined) {
    result.reasoning_effort = outputConfigEffort
  }

  if (compatibility.parallelToolCalls !== undefined && result.tools?.length) {
    result.parallel_tool_calls = compatibility.parallelToolCalls
  }
  if (compatibility.structuredOutput) {
    const { type, ...jsonSchema } = compatibility.structuredOutput
    result.response_format = { type, json_schema: jsonSchema }
  }

  return result
}

function convertMessage(
  msg: AnthropicMessage,
  output: OpenAIChatMessage[],
  options: OpenAIChatTransformOptions,
): void {
  const content = msg.content

  // Simple string content
  if (typeof content === 'string') {
    output.push({ role: msg.role, content })
    return
  }

  // Array content blocks
  if (!Array.isArray(content) || content.length === 0) {
    output.push({ role: msg.role, content: '' })
    return
  }

  if (msg.role === 'user') {
    convertUserMessage(content, output, options.imageContentMode ?? 'vision')
  } else {
    convertAssistantMessage(content, output, options)
  }
}

/**
 * Convert an Anthropic user message to OpenAI Chat messages.
 *
 * OpenAI Chat's official schema only allows text in `role: "tool"` messages, so
 * tool-result media cannot stay inside the tool message. The conversion keeps
 * the Anthropic content order as closely as the protocol allows:
 *
 * - ordinary user content (text/image/document) accumulates in one user message;
 * - every tool_result becomes a text-only tool message;
 * - tool-result media is lifted into one user message after the tool messages,
 *   grouped per tool call with a `tool_use_id` marker, preserving group order;
 * - text after the last tool_result is emitted after the lifted media, so media
 *   stays ahead of the text that follows it (matching Anthropic's ordering).
 */
function convertUserMessage(
  blocks: AnthropicContentBlock[],
  output: OpenAIChatMessage[],
  imageContentMode: OpenAIChatImageContentMode,
): void {
  const leadingUserParts: Array<UserTextPart> = []
  const trailingUserParts: Array<UserTextPart> = []
  const toolMessages: OpenAIChatMessage[] = []
  const mediaGroups: Array<{ toolUseId: string; parts: OpenAIChatContentPart[] }> = []
  let sawToolResult = false

  for (const block of blocks) {
    if (block.type === 'text') {
      const target = sawToolResult ? trailingUserParts : leadingUserParts
      target.push({ type: 'text', text: block.text })
      continue
    }

    if (block.type === 'image') {
      const target = sawToolResult ? trailingUserParts : leadingUserParts
      if (block.source.type === 'file') {
        // Files API references cannot be forwarded to OpenAI-compatible endpoints.
        target.push({ type: 'text', text: FILE_IMAGE_OMITTED_TEXT, synthetic: true })
      } else {
        target.push(imageContentMode === 'text_only'
          ? { type: 'text', text: OMITTED_IMAGE_TEXT }
          : { type: 'image_url', image_url: toImageUrl(block) })
      }
      continue
    }

    if (block.type === 'document') {
      // Documents degrade to text where possible — plain text sources keep
      // their data, custom-content documents keep their inline text, and the
      // rest becomes a text reference — so text-only endpoints still receive
      // the content. Only inline images are omitted in text_only mode.
      const target = sawToolResult ? trailingUserParts : leadingUserParts
      if (block.source.type === 'text') {
        // Anthropic text documents carry plain text in `data` — not base64.
        // Title/context are model-visible metadata, kept as a synthetic prefix.
        target.push(syntheticText(`${documentProvenanceText(block)}${block.source.data}`, imageContentMode))
      } else if (block.source.type === 'content') {
        const degraded = documentContentToParts(block)
        if (imageContentMode === 'text_only') {
          // Collapse the document's degraded parts into one synthetic part:
          // the internal text keeps its exact bytes, while the document as a
          // whole gets an explicit boundary against adjacent raw text.
          target.push(syntheticText(
            degraded.map(part => part.type === 'image_url' ? OMITTED_IMAGE_TEXT : part.text).join(''),
            imageContentMode,
          ))
        } else {
          target.push(...degraded)
        }
      } else {
        const reference = documentToTextReference(block)
        target.push({ ...reference, synthetic: true })
      }
      continue
    }

    if (block.type === 'search_result') {
      // Top-level user search results carry their content as text; keep them
      // visible instead of dropping the block.
      const target = sawToolResult ? trailingUserParts : leadingUserParts
      const text = searchResultToText(block)
      if (text) target.push(syntheticText(text, imageContentMode))
      continue
    }

    if (block.type !== 'tool_result') continue

    sawToolResult = true
    const { resultText, mediaParts } = toolResultToParts(block, imageContentMode)
    toolMessages.push({
      role: 'tool',
      tool_call_id: block.tool_use_id,
      content: resultText,
    })
    if (mediaParts.length > 0 && imageContentMode !== 'text_only') {
      mediaGroups.push({ toolUseId: block.tool_use_id, parts: mediaParts })
    }
  }

  if (leadingUserParts.length > 0) {
    output.push(createUserMessage(leadingUserParts, imageContentMode))
  }
  output.push(...toolMessages)
  if (mediaGroups.length > 0) {
    const mediaContent: OpenAIChatContentPart[] = []
    for (const group of mediaGroups) {
      mediaContent.push({
        type: 'text',
        text: `[Media content for tool call ${group.toolUseId}]`,
      })
      mediaContent.push(...group.parts)
    }
    output.push({ role: 'user', content: mediaContent })
  }
  if (trailingUserParts.length > 0) {
    output.push(createUserMessage(trailingUserParts, imageContentMode))
  }
}

function createUserMessage(
  parts: Array<UserTextPart>,
  imageContentMode: OpenAIChatImageContentMode,
): OpenAIChatMessage {
  // Collapse a single text block to a plain string: many OpenAI-compatible
  // endpoints only implement string `content` and reject the multipart array
  // form, so the array is reserved for messages that actually carry media or
  // multiple blocks. Joining multiple blocks would inject separators the
  // original prompt never had, so they keep their array shape. In text_only
  // mode the parts must collapse to a string — raw text blocks keep their
  // exact bytes (no separator), while synthetic parts get an explicit
  // boundary against the surrounding text.
  const textParts = parts.filter(
    (part): part is Extract<UserTextPart, { type: 'text' }> => part.type === 'text',
  )
  const wireParts: OpenAIChatContentPart[] = parts.map(part => part.type === 'text'
    ? { type: 'text', text: part.text }
    : part)
  const content = imageContentMode === 'text_only'
    ? joinUserTextParts(textParts)
    : textParts.length === parts.length
      && (parts.length === 1 || textParts.every(part => !part.synthetic))
      ? textParts.map(part => part.text).join('')
      : wireParts
  return { role: 'user', content }
}

/**
 * A synthetic text part (degraded document or search result) carries an
 * internal marker so serializers can preserve boundaries without sending the
 * marker to the upstream endpoint.
 */
function syntheticText(text: string, _imageContentMode: OpenAIChatImageContentMode): UserTextPart {
  return { type: 'text', text, synthetic: true }
}

/**
 * Whether two adjacent text fragments need a line boundary inserted between
 * them: the boundary must exist, but a fragment that already ends (left) or
 * starts (right) with a line break provides it. Checking both '\r' and '\n'
 * covers CRLF and lone-CR line breaks as well.
 */
function needsLineBoundary(left: string, right: string): boolean {
  return (
    !left.endsWith('\n') && !left.endsWith('\r') &&
    !right.startsWith('\n') && !right.startsWith('\r')
  )
}

/**
 * Join text parts into one string for text_only mode. Raw text blocks keep
 * their exact bytes — no separator is injected between them. A synthetic part
 * (degraded document, search result) gets a line boundary on each side so a
 * structured block cannot glue itself to the surrounding user text — but only
 * when the adjacent text does not already provide one, so the serializer never
 * rewrites bytes the prompt already carries.
 */
function joinUserTextParts(parts: Array<Extract<UserTextPart, { type: 'text' }>>): string {
  let content = ''
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    if (i > 0 && (parts[i - 1]!.synthetic || part.synthetic) && needsLineBoundary(content, part.text)) {
      content += '\n'
    }
    content += part.text
  }
  return content
}

function toolResultToParts(
  block: Extract<AnthropicContentBlock, { type: 'tool_result' }>,
  imageContentMode: OpenAIChatImageContentMode,
): { resultText: string; mediaParts: OpenAIChatContentPart[] } {
  const content = typeof block.content === 'string' ? [{ type: 'text' as const, text: block.content }] : block.content
  const textParts: string[] = []
  const mediaParts: OpenAIChatContentPart[] = []
  // A document is a discrete block: keep a newline on *both* sides of it.
  // This flag marks that the previous block was a document, so the next text
  // block gets the trailing separator. Text blocks *inside* one document keep
  // their boundaries — the final join uses no separator, so no text is
  // rewritten.
  let pendingDocumentBoundary = false

  for (const resultBlock of content) {
    if (resultBlock.type === 'text') {
      if (pendingDocumentBoundary) {
        // The previous block's boundary newline is only needed when this
        // text does not already start with one.
        if (needsLineBoundary('', resultBlock.text)) {
          textParts.push('\n')
        }
        pendingDocumentBoundary = false
      }
      textParts.push(resultBlock.text)
    } else if (resultBlock.type === 'search_result') {
      // Search results carry their content as text; keep it visible instead
      // of dropping it. Like a document, a search result is a discrete block:
      // keep a newline on both sides so it cannot glue itself to the
      // surrounding tool output — unless the adjacent text already provides
      // the boundary.
      const text = searchResultToText(resultBlock)
      if (text) {
        if (pendingDocumentBoundary) {
          if (needsLineBoundary('', text)) {
            textParts.push('\n')
          }
          pendingDocumentBoundary = false
        } else if (textParts.length > 0 && !textParts[textParts.length - 1].endsWith('\n')) {
          textParts.push('\n')
        }
        textParts.push(text)
        pendingDocumentBoundary = true
      }
    } else if (resultBlock.type === 'image') {
      if (resultBlock.source.type === 'file') {
        // Files API references cannot be forwarded to OpenAI-compatible
        // endpoints; the degraded notice carries its own separators.
        pendingDocumentBoundary = false
        textParts.push(FILE_IMAGE_OMITTED_TEXT)
      } else if (imageContentMode === 'text_only') {
        // The degraded notice carries its own separators.
        pendingDocumentBoundary = false
        textParts.push(OMITTED_IMAGE_TEXT)
      } else {
        mediaParts.push({ type: 'image_url', image_url: toImageUrl(resultBlock) })
      }
    } else if (resultBlock.type === 'document') {
      // Documents degrade to text where possible. Plain text sources and text
      // references stay in the tool message (external tool output belongs
      // behind the tool role); only real media lifts with the other
      // tool-result images.
      if (textParts.length > 0 && !textParts[textParts.length - 1].endsWith('\n')) {
        textParts.push('\n')
      }
      if (resultBlock.source.type === 'text') {
        // Anthropic text documents carry plain text in `data` — not base64.
        // Title/context are model-visible metadata, kept as a synthetic prefix.
        textParts.push(`${documentProvenanceText(resultBlock)}${resultBlock.source.data}`)
      } else if (resultBlock.source.type === 'content') {
        // Custom-content documents carry inline text and image blocks
        // (citations/RAG); keep the text in the tool message and lift the
        // images with the other tool-result media. Text/image order within
        // each group is preserved.
        for (const part of documentContentToParts(resultBlock)) {
          if (part.type === 'image_url') {
            if (imageContentMode === 'text_only') textParts.push(OMITTED_IMAGE_TEXT)
            else mediaParts.push(part)
          } else {
            textParts.push(part.text)
          }
        }
      } else {
        textParts.push(documentToTextReference(resultBlock).text)
      }
      pendingDocumentBoundary = true
    }
  }

  // Adjacent text blocks carry no separator in the Anthropic wire shape, so
  // joining with '\n' would inject separators the tool output never had.
  // Concatenate without a separator to keep the text unchanged.
  const resultText = textParts.join('')
  return {
    resultText: resultText || (mediaParts.length > 0 ? MEDIA_RESULT_ATTACHED_TEXT : ''),
    mediaParts,
  }
}

/**
 * Documents cannot be represented in OpenAI Chat's content part schema, so they
 * are kept visible as a text reference instead of being silently dropped.
 * Endpoints that need the actual file content should use the Responses/Azure
 * paths, which map documents to input_file.
 */
function documentToTextReference(
  block: Extract<AnthropicContentBlock, { type: 'document' }>,
): { type: 'text'; text: string } {
  const source = block.source
  // The reference text already carries the title (as its label), so only the
  // model-visible context needs a synthetic prefix here — it would otherwise
  // be silently dropped for URL/base64/file sources.
  const contextPrefix = block.context ? `[Document context: ${block.context}]\n` : ''
  if (source.type === 'url') {
    const label = block.title ?? source.url
    return {
      type: 'text',
      text: `${contextPrefix}[Document: ${label}](${source.url})`,
    }
  }
  if (source.type === 'file') {
    return {
      type: 'text',
      text: `${contextPrefix}[Document: ${block.title ?? 'file'} omitted — file-based source]`,
    }
  }
  if (source.type === 'base64' && source.media_type.startsWith('text/')) {
    // Text documents encoded as base64 carry readable content; inline a
    // bounded excerpt instead of leaving only a placeholder.
    const text = Buffer.from(source.data, 'base64').toString('utf8')
    const label = block.title ?? source.media_type
    const excerpt = text.slice(0, DOCUMENT_TEXT_INLINE_LIMIT)
    const suffix = text.length > DOCUMENT_TEXT_INLINE_LIMIT ? '\n[Document content truncated]' : ''
    return { type: 'text', text: `${contextPrefix}[Document: ${label}]\n${excerpt}${suffix}` }
  }
  if (source.type === 'content') {
    // Callers flatten custom-content documents before this point; keep a
    // visible reference for safety.
    return { type: 'text', text: `${contextPrefix}[Document: ${block.title ?? 'document'}]` }
  }
  const label = block.title ?? source.media_type
  return {
    type: 'text',
    text: `${contextPrefix}[Document: ${label}]`,
  }
}

/**
 * Flatten a custom-content document (source.type === 'content') into ordered
 * content parts, keeping the inline text/image sequence intact. Base64 and URL
 * image sources convert to Chat image_url parts so the media survives, while
 * file-based sources degrade to a text notice.
 */
function documentContentToParts(
  block: Extract<AnthropicContentBlock, { type: 'document' }>,
): OpenAIChatContentPart[] {
  const source = block.source
  const parts: OpenAIChatContentPart[] = []
  if (source.type !== 'content') return parts
  // Title/context are synthesized metadata, so they may carry their own
  // separator (unlike the document's text blocks, which are never rewritten).
  const provenance = documentProvenanceText(block)
  if (provenance) parts.push({ type: 'text', text: provenance })
  if (typeof source.content === 'string') {
    parts.push({ type: 'text', text: source.content })
  } else {
    for (const part of source.content) {
      if (part.type === 'text') {
        parts.push({ type: 'text', text: part.text })
      } else if (part.source.type === 'file') {
        // Files API references cannot be forwarded to OpenAI-compatible
        // endpoints; the degraded notice carries its own separators.
        parts.push({ type: 'text', text: '\n[Image omitted from document content]\n' })
      } else {
        parts.push({ type: 'image_url', image_url: toImageUrl(part) })
      }
    }
  }
  return parts
}

/**
 * Model-visible document metadata (title/context) as synthetic prefix text.
 * Both fields are visible to the model in the Anthropic protocol, so
 * degradation keeps them instead of dropping them silently. Returns an empty
 * string when neither is set, otherwise a newline-terminated prefix so the
 * document body follows on its own line.
 */
function documentProvenanceText(document: { title?: string; context?: string }): string {
  const lines = [
    ...(document.title ? [`[Document: ${document.title}]`] : []),
    ...(document.context ? [`[Document context: ${document.context}]`] : []),
  ]
  return lines.length > 0 ? `${lines.join('\n')}\n` : ''
}

function toImageUrl(block: Extract<AnthropicContentBlock, { type: 'image' }>): { url: string } {
  const source = block.source
  if (source.type === 'file') {
    // Unreachable: callers degrade file-based sources to a text notice first.
    throw new Error('file-based image source cannot be converted to a URL')
  }
  return source.type === 'url'
    ? { url: source.url }
    : { url: `data:${source.media_type};base64,${source.data}` }
}

/**
 * Flatten an Anthropic search_result block into its visible text (title,
 * body, source URL), matching the official schema where `source` is a string.
 */
function searchResultToText(block: Extract<AnthropicContentBlock, { type: 'search_result' }>): string {
  const contentText = Array.isArray(block.content)
    ? block.content.filter((part): part is { type: 'text'; text: string } => part.type === 'text').map(part => part.text)
    : []
  return [
    block.title,
    ...contentText,
    block.source,
  ].filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' — ')
}

function convertAssistantMessage(
  blocks: AnthropicContentBlock[],
  output: OpenAIChatMessage[],
  options: { roundTripReasoningContent?: boolean },
): void {
  let textContent = ''
  let reasoningContent = ''
  const toolCalls: OpenAIToolCall[] = []

  for (const block of blocks) {
    if (block.type === 'text') {
      textContent += block.text
    } else if (block.type === 'thinking' && options.roundTripReasoningContent) {
      reasoningContent += block.thinking
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input),
        },
      })
    }
  }

  const msg: OpenAIChatMessage = {
    role: 'assistant',
    content: textContent || null,
  }

  if (toolCalls.length > 0) {
    msg.tool_calls = toolCalls
  }
  if (reasoningContent) {
    msg.reasoning_content = reasoningContent
  }

  output.push(msg)
}

function convertToolChoice(choice: unknown): unknown {
  if (typeof choice === 'string') return choice === 'any' ? 'required' : choice
  if (typeof choice === 'object' && choice !== null) {
    const c = choice as Record<string, unknown>
    if (c.type === 'auto') return 'auto'
    if (c.type === 'any') return 'required'
    if (c.type === 'none') return 'none'
    if (c.type === 'tool' && typeof c.name === 'string') {
      return { type: 'function', function: { name: c.name } }
    }
  }
  return 'auto'
}
