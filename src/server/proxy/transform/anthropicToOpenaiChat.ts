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

type OpenAIChatImageContentMode = 'vision' | 'text_only'

type OpenAIChatTransformOptions = {
  roundTripReasoningContent?: boolean
  passThinkingToggle?: boolean
  imageContentMode?: OpenAIChatImageContentMode
}

const OMITTED_IMAGE_TEXT = '[Image omitted: this OpenAI-compatible chat endpoint only supports text content.]'

/**
 * Convert Anthropic Messages request to OpenAI Chat Completions request.
 */
export function anthropicToOpenaiChat(
  body: AnthropicRequest,
  options: OpenAIChatTransformOptions = {},
): OpenAIChatRequest {
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
  for (const msg of body.messages) {
    convertMessage(msg, messages, options)
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

  // max_tokens — omit to let upstream provider use its own default/max.
  // Claude Code sends very large values (e.g. 128K) that exceed many
  // providers' limits (DeepSeek: 8192, etc.).

  // temperature & top_p
  if (body.temperature !== undefined) result.temperature = body.temperature
  if (body.top_p !== undefined) result.top_p = body.top_p

  // stop_sequences → stop
  if (body.stop_sequences && body.stop_sequences.length > 0) {
    result.stop = body.stop_sequences
  }

  // tools
  if (body.tools && body.tools.length > 0) {
    result.tools = body.tools
      .filter((t) => t.name !== 'BatchTool')
      .map((t): OpenAITool => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        },
      }))
  }

  // tool_choice
  if (body.tool_choice !== undefined) {
    result.tool_choice = convertToolChoice(body.tool_choice)
  }

  // thinking → reasoning_effort
  if (body.thinking) {
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

function convertUserMessage(
  blocks: AnthropicContentBlock[],
  output: OpenAIChatMessage[],
  imageContentMode: OpenAIChatImageContentMode,
): void {
  // Separate tool_result blocks from other content
  const contentParts: OpenAIChatContentPart[] = []
  const textOnlyParts: string[] = []

  for (const block of blocks) {
    if (block.type === 'text') {
      if (imageContentMode === 'text_only') {
        textOnlyParts.push(block.text)
      } else {
        contentParts.push({ type: 'text', text: block.text })
      }
    } else if (block.type === 'image') {
      if (imageContentMode === 'text_only') {
        textOnlyParts.push(OMITTED_IMAGE_TEXT)
      } else {
        const url = `data:${block.source.media_type};base64,${block.source.data}`
        contentParts.push({ type: 'image_url', image_url: { url } })
      }
    } else if (block.type === 'tool_result') {
      // tool_result → separate tool message
      const resultContent = typeof block.content === 'string'
        ? block.content
        : Array.isArray(block.content)
          ? block.content.filter((b): b is Extract<AnthropicContentBlock, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('\n')
          : ''
      output.push({
        role: 'tool',
        tool_call_id: block.tool_use_id,
        content: resultContent,
      })
    }
  }

  if (imageContentMode === 'text_only') {
    const content = textOnlyParts.filter(Boolean).join('\n')
    if (content) {
      output.push({
        role: 'user',
        content,
      })
    }
  } else if (contentParts.length > 0) {
    output.push({
      role: 'user',
      content: contentParts.length === 1 && contentParts[0].type === 'text'
        ? contentParts[0].text
        : contentParts,
    })
  }
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
  if (typeof choice === 'string') return choice
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
