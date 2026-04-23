/**
 * OpenAI API type definitions for protocol transformation.
 * Derived from cc-switch (https://github.com/farion1231/cc-switch)
 * Original work by Jason Young, MIT License
 */

// ─── OpenAI Chat Completions ────────────────────────────────

export type OpenAIChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | OpenAIChatContentPart[] | null
  name?: string
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
    arguments: string
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
  tools?: OpenAITool[]
  tool_choice?: unknown
  reasoning_effort?: 'low' | 'medium' | 'high'
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
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens?: number
    }
  }
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
          arguments?: string
        }
      }>
    }
    finish_reason: string | null
  }>
  usage?: OpenAIChatResponse['usage']
}

// ─── OpenAI Responses API ───────────────────────────────────

export type OpenAIResponsesInputItem =
  | { type: 'message'; role: 'user' | 'assistant' | 'system'; content: string | OpenAIChatContentPart[] }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }

export type OpenAIResponsesRequest = {
  model: string
  input: OpenAIResponsesInputItem[]
  instructions?: string
  max_output_tokens?: number
  temperature?: number
  top_p?: number
  stream?: boolean
  tools?: OpenAITool[]
  tool_choice?: unknown
  reasoning?: { effort?: 'low' | 'medium' | 'high' }
}

export type OpenAIResponsesOutputItem =
  | { type: 'message'; role: string; content: Array<{ type: string; text?: string; refusal?: string }> }
  | { type: 'function_call'; id: string; call_id: string; name: string; arguments: string }
  | { type: 'reasoning'; id: string; summary?: Array<{ type: string; text: string }> }

export type OpenAIResponsesResponse = {
  id: string
  object: string
  created_at: number
  model: string
  status: string
  output: OpenAIResponsesOutputItem[]
  usage?: {
    input_tokens: number
    output_tokens: number
    total_tokens: number
  }
}

// ─── Anthropic Types (subset used by transforms) ───────────

export type AnthropicContentBlock =
  | { type: 'text'; text: string; cache_control?: unknown }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string }; cache_control?: unknown }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown>; cache_control?: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string | AnthropicContentBlock[]; is_error?: boolean; cache_control?: unknown }
  | { type: 'thinking'; thinking: string; signature?: string }

export type AnthropicMessage = {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

export type AnthropicRequest = {
  model: string
  system?: string | Array<{ type: 'text'; text: string; cache_control?: unknown }>
  messages: AnthropicMessage[]
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
