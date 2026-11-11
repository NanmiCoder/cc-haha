import { sessionsApi } from '@/api/sessions'
import { useChatStore } from '@/stores/chatStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useTabStore } from '@/stores/tabStore'
import { isPublicAccessRuntime } from './publicAccessRuntime'

export const MOBILE_CAPTURE_EVENT = 'cc-haha-mobile-capture'
export const MOBILE_RESTORE_EVENT = 'cc-haha-mobile-restore'
const MAX_TEXT_BYTES = 16_384
const sessionIdPattern = /^[\w-]{1,64}$/
export type MobileResumeSnapshot = {
  version: 1
  sessionId: string | null
  drafts: Array<{ sessionId: string, text: string }>
}
type MobileResumeBridge = { capture(): MobileResumeSnapshot | null, restore(value: unknown): boolean }
declare global { interface Window { __ccHahaMobileState?: MobileResumeBridge } }

/** Only bounded text and session selection may cross verified origins. Never cookies, files or commands. */
export function parseMobileResumeSnapshot(value: unknown): MobileResumeSnapshot | null {
  if (!value || typeof value !== 'object') return null
  const data = value as MobileResumeSnapshot
  if (data.version !== 1 || !(data.sessionId === null || (typeof data.sessionId === 'string' && sessionIdPattern.test(data.sessionId))) ||
    !Array.isArray(data.drafts) || data.drafts.length > 5) return null
  const seen = new Set<string>()
  const drafts: MobileResumeSnapshot['drafts'] = []
  for (const draft of data.drafts) {
    if (!draft || typeof draft.sessionId !== 'string' || !sessionIdPattern.test(draft.sessionId) || seen.has(draft.sessionId) ||
      typeof draft.text !== 'string' || new TextEncoder().encode(draft.text).byteLength > MAX_TEXT_BYTES) return null
    seen.add(draft.sessionId)
    drafts.push({ sessionId: draft.sessionId, text: draft.text })
  }
  return { version: 1, sessionId: data.sessionId, drafts }
}

export function installMobileResumeState(): () => void {
  if (!isPublicAccessRuntime()) return () => {}
  let disposed = false
  let restoring = false
  let restored = false
  const bridge: MobileResumeBridge = {
    capture() {
      if (disposed || restoring) return null
      // ChatInput keeps the live editor value in refs; flush it before reading the store.
      window.dispatchEvent(new Event(MOBILE_CAPTURE_EVENT))
      const { activeTabId, tabs } = useTabStore.getState()
      const active = tabs.find(tab => tab.sessionId === activeTabId && tab.type === 'session')
      const sessionId = active && sessionIdPattern.test(active.sessionId) ? active.sessionId : null
      const entries = Object.entries(useChatStore.getState().sessions)
        .sort(([a], [b]) => a === sessionId ? -1 : b === sessionId ? 1 : 0)
      const drafts = entries.flatMap(([id, session]) => {
        const text = session.composerDraft?.input
        if (!sessionIdPattern.test(id) || !text || new TextEncoder().encode(text).byteLength > MAX_TEXT_BYTES) return []
        return [{ sessionId: id, text }]
      }).slice(0, 5)
      return { version: 1, sessionId, drafts }
    },
    restore(value) {
      const snapshot = parseMobileResumeSnapshot(value)
      if (!snapshot || disposed || restoring || restored) return false
      restoring = true
      const startingTab = useTabStore.getState().activeTabId
      void (async () => {
        try {
          const summary = snapshot.sessionId ? await sessionsApi.getSummary(snapshot.sessionId) : null
          if (disposed) return
          window.dispatchEvent(new Event(MOBILE_CAPTURE_EVENT))
          for (const draft of snapshot.drafts) {
            const current = useChatStore.getState().sessions[draft.sessionId]?.composerDraft
            if (!current?.input && !current?.attachments.length) {
              useChatStore.getState().setComposerDraft(draft.sessionId, { input: draft.text, attachments: [], mentions: [] })
            }
          }
          // A slow lookup must not navigate away after the user has picked another chat.
          if (summary && useTabStore.getState().activeTabId === startingTab) {
            useSessionStore.getState().openHistoricalSession(summary)
            useChatStore.getState().connectToSession(summary.id)
          }
          window.dispatchEvent(new Event(MOBILE_RESTORE_EVENT))
          restored = true
        } catch { /* Keep the native snapshot available for a later connection. */ }
        finally { restoring = false }
      })()
      return true
    },
  }
  window.__ccHahaMobileState = bridge
  return () => {
    disposed = true
    if (window.__ccHahaMobileState === bridge) delete window.__ccHahaMobileState
  }
}
