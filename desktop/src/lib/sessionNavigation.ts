import { useSessionStore } from '@/stores/sessionStore'
import { useTabStore } from '@/stores/tabStore'

export function sessionSourceTitle(sessionId: string): string {
  return useSessionStore.getState().sessions.find(session => session.id === sessionId)?.title || sessionId
}

export function openSessionSource(sessionId: string, knownTitle?: string): void {
  useTabStore.getState().openTab(sessionId, knownTitle || sessionSourceTitle(sessionId))
}
