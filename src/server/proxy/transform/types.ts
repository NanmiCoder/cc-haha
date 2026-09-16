/**
 * OpenAI API type definitions for protocol transformation.
 * Derived from cc-switch (https://github.com/farion1231/cc-switch)
 * Original work by Jason Young, MIT License
 */

// ─── OpenAI Chat Completions ────────────────────────────────

export type OpenAIReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'

export type OpenAIChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | OpenAIChatContentPart[] | null
  name?: string
  reasoning_content?: string
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
}

export type OpenAIChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } }

export type OpenAIToolCall = {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: unknown
  }
}

export type OpenAITool = {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

export type OpenAIChatRequest = {
  model: string
  messages: OpenAIChatMessage[]
  max_tokens?: number
  max_completion_tokens?: number
  temperature?: number
  top_p?: number
  stop?: string | string[]
  stream?: boolean
  stream_options?: { include_usage: boolean }
  tools?: OpenAITool[]
  tool_choice?: unknown
  reasoning_effort?: OpenAIReasoningEffort
  thinking?: { type: string }
  parallel_tool_calls?: boolean
  response_format?: { type: 'json_schema'; json_schema: { name: string; description?: string; schema: Record<string, unknown>; strict: boolean } }
}

/**
 * Usage shape accepted from OpenAI-compatible upstreams.
 * Responses API uses input_tokens/input_tokens_details, Chat Completions uses
 * prompt_tokens/prompt_tokens_details, and some compatible servers return
 * Anthropic-style cache fields directly.
 */
export type OpenAICompatibleUsage = {
  input_tokens?: number
  output_tokens?: number
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  input_tokens_details?: { cached_tokens?: number }
  prompt_tokens_details?: { cached_tokens?: number }
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export type OpenAIChatResponse = {
  id: string
  object: string
  created: number
  model: string
  choices: Array<{
    index: number
    message: {
      role: string
      content: string | null
      tool_calls?: OpenAIToolCall[]
    }
    finish_reason: string | null
  }>
  usage?: OpenAICompatibleUsage
}

export type OpenAIChatStreamChunk = {
  id: string
  object: string
  created: number
  model: string
  choices: Array<{
    index: number
    delta: {
      role?: string
      content?: string | null
      tool_calls?: Array<{
        index: number
        id?: string
        type?: string
        function?: {
          name?: string
          arguments?: unknown
        }
      }>
    }
    finish_reason: string | null
  }>
  usage?: OpenAIChatResponse['usage']
}

// ─── OpenAI Responses API ───────────────────────────────────

export type OpenAIResponsesInputContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string }
  | { type: 'input_file'; file_url?: string; file_data?: string; filename?: string }

export type OpenAIResponsesInputItem =
  | { type: 'message'; role: 'user' | 'assistant' | 'system'; content: string | OpenAIResponsesInputContentPart[] }
  | { type: 'function_call'; call_id: string; name: string; arguments: unknown }
  | { type: 'function_call_output'; call_id: string; output: string | OpenAIResponsesInputContentPart[] }
  | OpenAIResponsesReasoningItem

export type OpenAIResponsesRequest = {
  model: string
  input: OpenAIResponsesInputItem[]
  instructions?: string
  store?: boolean
  max_output_tokens?: number
  temperature?: number
  top_p?: number
  stream?: boolean
  tools?: Array<{
    type: 'function'
    name: string
    description?: string
    parameters?: Record<string, unknown>
    strict?: boolean
  }>
  tool_choice?: unknown
  reasoning?: { effort?: OpenAIReasoningEffort }
  include?: string[]
  prompt_cache_key?: string
  parallel_tool_calls?: boolean
  text?: { format: { type: 'json_schema'; name: string; description?: string; schema: Record<string, unknown>; strict: boolean } }
}

export type OpenAIResponsesReasoningItem = {
  type: 'reasoning'
  id?: string
  summary?: Array<{ type: string; text: string }>
  content?: Array<{ type: string; text: string }>
  encrypted_content?: string
}

export type OpenAIResponsesOutputItem =
  | { type: 'message'; role: string; content: Array<{ type: string; text?: string; refusal?: string }> }
  | { type: 'function_call'; id: string; call_id: string; name: string; arguments: unknown }
  | OpenAIResponsesReasoningItem

export type OpenAIResponsesResponse = {
  id: string
  object: string
  created_at: number
  model: string
  status: string
  incomplete_details?: { reason?: string } | null
  error?: { code?: string; type?: string; message?: string } | null
  output: OpenAIResponsesOutputItem[]
  usage?: OpenAICompatibleUsage
}

// ─── Anthropic Types (subset used by transforms) ───────────

export type AnthropicImageSource =
  | { type: 'base64'; media_type: string; data: string }
  | { type: 'url'; url: string }
  | { type: 'file'; file_id: string }

/**
 * A text block inside a custom-content document (`source.type: 'content'`).
 * Mirrors the Anthropic `TextBlockParam` fields the wire protocol allows
 * (cache_control, citations) so degradation keeps them instead of dropping
 * them silently.
 */
export type AnthropicDocumentContentTextBlock = {
  type: 'text'
  text: string
  cache_control?: unknown
  citations?: unknown
}

export type AnthropicDocumentSource =
  | { type: 'base64'; media_type: string; data: string }
  | { type: 'url'; url: string }
  | { type: 'text'; media_type: string; data: string }
  | { type: 'file'; file_id: string }
  | {
      type: 'content'
      content: string | Array<AnthropicDocumentContentTextBlock | { type: 'image'; source: AnthropicImageSource; cache_control?: unknown }>
    }

export type AnthropicContentBlock =
  | { type: 'text'; text: string; cache_control?: unknown }
  | { type: 'image'; source: AnthropicImageSource; cache_control?: unknown }
  | { type: 'document'; source: AnthropicDocumentSource; title?: string; context?: string; citations?: unknown; cache_control?: unknown }
  | { type: 'search_result'; source: string; title: string; content: Array<{ type: 'text'; text: string }>; citations?: unknown; cache_control?: unknown }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown>; cache_control?: unknown }
  | { type: 'server_tool_use'; id: string; name: string; input: unknown; cache_control?: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string | AnthropicContentBlock[]; is_error?: boolean; cache_control?: unknown }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'redacted_thinking'; data: string }

export type AnthropicMessage = {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

export type AnthropicRequest = {
  model: string
  system?: string | Array<{ type: 'text'; text: string; cache_control?: unknown }>
  messages: AnthropicMessage[]
  metadata?: { user_id?: string; session_id?: string }
  max_tokens: number
  temperature?: number
  top_p?: number
  stop_sequences?: string[]
  stream?: boolean
  tools?: Array<{
    name: string
    description?: string
    input_schema: Record<string, unknown>
    cache_control?: unknown
  }>
  tool_choice?: unknown
  thinking?: {
    type: string
    budget_tokens?: number
  }
  output_format?: unknown
  output_config?: {
    effort?: unknown
    [key: string]: unknown
  }
}

export type AnthropicResponse = {
  id: string
  type: 'message'
  role: 'assistant'
  content: AnthropicContentBlock[]
  model: string
  stop_reason: string | null
  stop_sequence: string | null
  usage: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
}
