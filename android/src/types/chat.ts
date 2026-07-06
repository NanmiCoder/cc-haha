export type MessageRole = 'user' | 'assistant'

export interface ChatMessage {
  id: string
  role: MessageRole
  content: string
  timestamp: number
}

export interface Session {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

export interface ClientMessage {
  type: string
  [key: string]: any
}

export interface ServerMessage {
  type: string
  [key: string]: any
}
