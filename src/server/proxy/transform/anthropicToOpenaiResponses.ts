/**
 * Request transformation: Anthropic Messages → OpenAI Responses API
 * Derived from cc-switch (https://github.com/farion1231/cc-switch)
 * Original work by Jason Young, MIT License
 */

import type {
  AnthropicRequest,
  AnthropicContentBlock,
  AnthropicMessage,
  OpenAIResponsesRequest,
  OpenAIResponsesInputItem,
  OpenAIResponsesInputContentPart,
} from './types.js'
import { stripLeadingBillingHeader } from './billingHeader.js'
import { normalizeOpenAIReasoningEffort } from './effort.js'
import { decodeOpenAIReasoningEnvelope } from './openaiReasoning.js'
import { resolveRequestCompatibility, type RequestCompatibilityOptions } from './requestCompatibility.js'

export type OpenAIResponsesTransformOptions = RequestCompatibilityOptions & {
  /** Stable cache routing key, forwarded as `prompt_cache_key`. */
  cacheKey?: string
  passSamplingParams?: boolean
  /** Restore only cc-haha namespaced OpenAI reasoning envelopes. */
  preserveOpenAIReasoning?: boolean
}

/**
 * Convert Anthropic Messages request to OpenAI Responses API request.
 */
export function anthropicToOpenaiResponses(
  body: AnthropicRequest,
  options: OpenAIResponsesTransformOptions = {},
): OpenAIResponsesRequest {
  const compatibility = resolveRequestCompatibility(body, { ...options, protocol: 'openai_responses' })
  const input: OpenAIResponsesInputItem[] = []

  // Convert messages to input items
  for (const msg of body.messages) {
    convertMessageToInputItems(msg, input, options)
  }

  const result: OpenAIResponsesRequest = {
    model: body.model,
    input,
    stream: body.stream,
    store: false,
  }

  // system → instructions, minus the leading billing attribution: its
  // rotating cch= signature would change the prefix every turn and defeat
  // upstream prompt caching.
  if (body.system) {
    const instructions = typeof body.system === 'string'
      ? stripLeadingBillingHeader(body.system)
      : body.system.map((b) => stripLeadingBillingHeader(b.text)).filter(Boolean).join('\n')
    if (instructions) {
      result.instructions = instructions
    }
  }

  if (options.cacheKey) {
    result.prompt_cache_key = options.cacheKey
  }

  if (compatibility.outputBudget.field === 'max_output_tokens') {
    result.max_output_tokens = compatibility.outputBudget.effective
  }

  // Claude Code sends Anthropic sampling params that some compatible
  // providers reject. Keep them opt-in for providers known to accept them.
  if (compatibility.passSamplingParams) {
    if (body.temperature !== undefined) result.temperature = body.temperature
    if (body.top_p !== undefined) result.top_p = body.top_p
  }

  // tools — an empty array after filtering is dropped, not sent as `[]`, so it
  // reads as "no tools" to strict upstreams instead of "an empty tool set".
  if (body.tools && body.tools.length > 0) {
    const tools = body.tools
      .filter((t) => t.name !== 'BatchTool')
      .map((t) => ({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
        // Responses otherwise normalizes optional properties to required.
        // Preserve Anthropic/MCP omission semantics, including alternative
        // selectors and compatibility aliases that cannot coexist.
        strict: false,
      }))
    if (tools.length > 0) {
      result.tools = tools
    }
  }

  // tool_choice — only meaningful next to the tools it selects from. A choice
  // that outlives its tool (BatchTool filtered above, or a client that sends
  // tool_choice with no tools at all) is an orphan that strict Responses
  // upstreams reject.
  if (body.tool_choice !== undefined) {
    const toolChoice = convertToolChoice(body.tool_choice)
    if (isSelectableToolChoice(toolChoice, result.tools)) {
      result.tool_choice = toolChoice
    }
  }

  // thinking → reasoning
  if (compatibility.passReasoning && body.thinking) {
    const budget = body.thinking.budget_tokens
    if (budget !== undefined) {
      if (budget <= 1024) result.reasoning = { effort: 'low' }
      else if (budget <= 8192) result.reasoning = { effort: 'medium' }
      else result.reasoning = { effort: 'high' }
    } else if (body.thinking.type === 'enabled') {
      result.reasoning = { effort: 'high' }
    }
  }
  const outputConfigEffort = normalizeOpenAIReasoningEffort(body.output_config?.effort)
  if (compatibility.passReasoning && outputConfigEffort !== undefined) {
    result.reasoning = { ...(result.reasoning ?? {}), effort: outputConfigEffort }
  }

  if (compatibility.parallelToolCalls !== undefined && result.tools?.length) {
    result.parallel_tool_calls = compatibility.parallelToolCalls
  }
  if (compatibility.structuredOutput) {
    result.text = { format: compatibility.structuredOutput }
  }

  // stop_sequences not supported in Responses API, dropped

  return result
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

function convertContentBlock(
  block: Extract<AnthropicContentBlock, { type: 'text' | 'image' | 'document' | 'search_result' }>,
): OpenAIResponsesInputContentPart[] {
  if (block.type === 'text') {
    return [{ type: 'input_text', text: block.text }]
  }

  if (block.type === 'search_result') {
    // Search results carry their content as text; keep it visible instead of
    // dropping the block. `source` is a URL string per the official schema.
    const contentText = Array.isArray(block.content)
      ? block.content.filter((part): part is { type: 'text'; text: string } => part.type === 'text').map(part => part.text)
      : []
    const text = [
      block.title,
      ...contentText,
      block.source,
    ].filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join(' — ')
    return [{ type: 'input_text', text }]
  }

  if (block.type === 'document') {
    const source = block.source
    if (source.type === 'text') {
      // Anthropic text documents carry plain text in `data` — not base64.
      // Title/context are model-visible metadata, kept as a synthetic prefix.
      return [{ type: 'input_text', text: `${documentProvenanceText(block)}${source.data}` }]
    }
    if (source.type === 'content') {
      // Custom-content documents carry inline text and image blocks
      // (citations/RAG). Keep both visible. Title/context are synthesized
      // metadata, so they may carry their own separator (unlike the
      // document's text blocks, which are never rewritten).
      const parts: OpenAIResponsesInputContentPart[] = []
      const provenance = documentProvenanceText(block)
      if (provenance) parts.push({ type: 'input_text', text: provenance })
      if (typeof source.content === 'string') {
        parts.push({ type: 'input_text', text: source.content })
      } else {
        for (const part of source.content) {
          if (part.type === 'text') {
            parts.push({ type: 'input_text', text: part.text })
          } else {
            parts.push(...convertContentBlock(part))
          }
        }
      }
      return parts
    }
    if (source.type === 'url') {
      // The input_file carries the title as filename, so the synthetic
      // provenance prefix keeps the model-visible title/context text.
      const provenance = documentProvenanceText(block)
      return [
        ...(provenance ? [{ type: 'input_text' as const, text: provenance }] : []),
        { type: 'input_file', file_url: source.url, ...(block.title ? { filename: block.title } : {}) },
      ]
    }
    if (source.type === 'file') {
      // Files API references cannot be forwarded to a third-party endpoint.
      // The omission notice already carries the title, so only context needs
      // a synthetic prefix.
      const contextPrefix = block.context ? `[Document context: ${block.context}]\n` : ''
      return [{ type: 'input_text', text: `${contextPrefix}[Document: ${block.title ?? 'file'} omitted — file-based source]` }]
    }
    const base64Provenance = documentProvenanceText(block)
    return [
      ...(base64Provenance ? [{ type: 'input_text' as const, text: base64Provenance }] : []),
      {
        type: 'input_file',
        file_data: `data:${source.media_type};base64,${source.data}`,
        ...(block.title ? { filename: block.title } : {}),
      },
    ]
  }

  const source = block.source
  if (source.type === 'file') {
    return [{ type: 'input_text', text: '[Image omitted: file-based image source is not supported by this endpoint.]' }]
  }
  return [{
    type: 'input_image',
    image_url: source.type === 'url'
      ? source.url
      : `data:${source.media_type};base64,${source.data}`,
  }]
}

function convertMessageToInputItems(
  msg: AnthropicMessage,
  output: OpenAIResponsesInputItem[],
  options: OpenAIResponsesTransformOptions,
): void {
  const content = msg.content

  // Simple string content
  if (typeof content === 'string') {
    output.push({ type: 'message', role: msg.role, content })
    return
  }

  if (!Array.isArray(content) || content.length === 0) {
    output.push({ type: 'message', role: msg.role, content: '' })
    return
  }

  // Collect text/image parts and handle tool blocks separately
  const contentParts: OpenAIResponsesInputContentPart[] = []

  const flushContentParts = (): void => {
    if (contentParts.length === 0) return

    if (contentParts.every((part) => part.type === 'input_text')) {
      const messageContent = contentParts.map((part) => part.text).join('')
      if (messageContent) {
        output.push({ type: 'message', role: msg.role, content: messageContent })
      }
    } else {
      output.push({ type: 'message', role: msg.role, content: [...contentParts] })
    }
    contentParts.length = 0
  }

  for (const block of content) {
    if (block.type === 'text' || block.type === 'image' || block.type === 'document' || block.type === 'search_result') {
      contentParts.push(...convertContentBlock(block))
    } else if (block.type === 'tool_use') {
      // Flush any accumulated content first
      flushContentParts()
      // Lift to function_call item
      output.push({
        type: 'function_call',
        call_id: block.id,
        name: block.name,
        arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input),
      })
    } else if (block.type === 'tool_result') {
      // Flush any accumulated content first
      flushContentParts()
      // Lift to function_call_output item
      const sourceBlocks = Array.isArray(block.content) ? block.content : []
      const resultContent = typeof block.content === 'string'
        ? block.content
        : sourceBlocks
            .filter((part): part is Extract<AnthropicContentBlock, { type: 'text' | 'image' | 'document' | 'search_result' }> => (
              part.type === 'text' || part.type === 'image' || part.type === 'document' || part.type === 'search_result'
            ))
            .flatMap(convertContentBlock)
      // Adjacent *text* blocks carry no separator in the Anthropic wire shape,
      // so joining with '\n' would inject separators the tool output never
      // had. Concatenate without a separator to keep the text unchanged, and
      // only when every source block was text — anything degraded from another
      // block type keeps its array shape so block boundaries stay visible.
      const onlyTextBlocks = sourceBlocks.every(part => part.type === 'text')
      const resultOutput = onlyTextBlocks
        && Array.isArray(resultContent)
        && resultContent.every((part): part is Extract<OpenAIResponsesInputContentPart, { type: 'input_text' }> => part.type === 'input_text')
        ? resultContent.map((part) => part.text).join('')
        : resultContent
      output.push({
        type: 'function_call_output',
        call_id: block.tool_use_id,
        output: resultOutput,
      })
    } else if (block.type === 'redacted_thinking' && options.preserveOpenAIReasoning) {
      flushContentParts()
      const reasoning = decodeOpenAIReasoningEnvelope(block.data)
      if (reasoning) output.push(reasoning)
    }
    // Skip thinking blocks
  }

  // Flush remaining content
  flushContentParts()
}

function convertToolChoice(choice: unknown): unknown {
  if (typeof choice === 'string') return choice === 'any' ? 'required' : choice
  if (typeof choice === 'object' && choice !== null) {
    const c = choice as Record<string, unknown>
    if (c.type === 'auto') return 'auto'
    if (c.type === 'any') return 'required'
    if (c.type === 'none') return 'none'
    if (c.type === 'tool' && typeof c.name === 'string') {
      // Responses names the function inline: {type:'function', name}. The
      // nested {function:{name}} form belongs to Chat Completions and is
      // rejected here (see anthropicToOpenaiChat for that shape).
      return { type: 'function', name: c.name }
    }
  }
  return 'auto'
}

/**
 * A named tool_choice is only valid while its target survives into the request.
 * Anything else — a choice with no tools at all — is dropped so the upstream
 * never sees a selector pointing at nothing.
 */
function isSelectableToolChoice(
  choice: unknown,
  tools: { name: string }[] | undefined,
): boolean {
  if (!tools || tools.length === 0) return false
  if (typeof choice !== 'object' || choice === null) return true
  const name = (choice as Record<string, unknown>).name
  if (typeof name !== 'string') return true
  return tools.some((tool) => tool.name === name)
}
