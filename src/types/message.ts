export type Message = Record<string, unknown>
export type MessageContent = unknown
export type MessageRole = 'user' | 'assistant' | 'system'
export const enum QuerySource {
  USER = 'user',
  SYSTEM = 'system',
  TOOL = 'tool',
}