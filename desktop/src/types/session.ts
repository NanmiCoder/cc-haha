// Source: src/server/services/sessionService.ts

export type SessionListItem = {
  id: string
  title: string
  createdAt: string
  modifiedAt: string
  messageCount: number
  projectPath: string
  projectRoot?: string | null
  workDir: string | null
  workDirExists: boolean
  permissionMode?: string
  /** Absolute path of the .jsonl file on disk. Optional so older servers /
   *  test fixtures that omit it remain compatible; sidebar context-menu
   *  actions fall back to a "not available" message when missing. */
  filePath?: string
}

export type MessageUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export type MessageEntry = {
  id: string
  type: 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result'
  content: unknown
  toolUseResult?: unknown
  timestamp: string
  model?: string
  usage?: MessageUsage
  parentUuid?: string
  parentToolUseId?: string
  isSidechain?: boolean
}

export type SessionDetail = SessionListItem & {
  messages: MessageEntry[]
}
