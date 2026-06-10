export type NormalizedBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id?: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId?: string; content: unknown; isError?: boolean }
  | { type: 'image'; mediaType?: string; dataUrl?: string }

export type NormalizedMessage = {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: NormalizedBlock[]
}

export type NormalizedUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
}
