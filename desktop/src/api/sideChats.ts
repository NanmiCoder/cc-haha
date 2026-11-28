import { api } from '@/api/client'
import type { PermissionMode, ReasoningEffortLevel } from '@/types/settings'

export type SideChatSession = {
  sessionId: string
  parentSessionId: string
  workDir: string
  title: string
  ephemeral: true
  permissionMode?: PermissionMode
  runtimeProviderId?: string | null
  runtimeModelId?: string
  effortLevel?: ReasoningEffortLevel
}
export const sideChatsApi = {
  create(parentSessionId: string) {
    return api.post<SideChatSession>(`/api/sessions/${encodeURIComponent(parentSessionId)}/side-chats`, { sideChatId: crypto.randomUUID() })
  },
  discard(parentSessionId: string, sideChatId: string) {
    return api.delete(`/api/sessions/${encodeURIComponent(parentSessionId)}/side-chats/${encodeURIComponent(sideChatId)}`)
  },
}
