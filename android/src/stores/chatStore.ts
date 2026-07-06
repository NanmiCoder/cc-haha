import { create } from 'zustand'
import { ChatMessage, Session } from '../types/chat'

interface ChatStore {
  sessions: Session[]
  currentSessionId: string | null
  messages: ChatMessage[]
  setSessions: (sessions: Session[]) => void
  setCurrentSession: (sessionId: string | null) => void
  addMessage: (message: ChatMessage) => void
  setMessages: (messages: ChatMessage[]) => void
  clearMessages: () => void
}

export const useChatStore = create<ChatStore>((set) => ({
  sessions: [],
  currentSessionId: null,
  messages: [],
  
  setSessions: (sessions) => set({ sessions }),
  setCurrentSession: (sessionId) => set({ currentSessionId: sessionId }),
  addMessage: (message) => set((state) => ({
    messages: [...state.messages, message],
  })),
  setMessages: (messages) => set({ messages }),
  clearMessages: () => set({ messages: [] }),
}))
