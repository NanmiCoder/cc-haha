import { create } from 'zustand'
import { sideChatsApi, type SideChatSession } from '@/api/sideChats'
import { registerSideChatSession, unregisterSideChatSession } from '@/lib/sideChatSessions'
import { resolveDefaultRuntimeSelection } from '@/lib/runtimeSelection'
import { useChatStore } from '@/stores/chatStore'
import { useSessionRuntimeStore } from '@/stores/sessionRuntimeStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useProviderStore } from '@/stores/providerStore'
import { useWorkspaceChatContextStore, type WorkspaceChatReference } from '@/stores/workspaceChatContextStore'

type OpenOptions = { submit?: boolean; question?: string; reference?: Omit<WorkspaceChatReference, 'id'> & { id?: string } }
type SideChatStore = {
  entries: Record<string, SideChatSession | undefined>
  open: (parentSessionId: string, options?: OpenOptions) => Promise<string>
  close: (sideChatId: string) => Promise<void>
}
const creating = new Map<string, Promise<string>>()
const closing = new Map<string, Promise<void>>()

// Side conversations and their drafts live only for this app lifetime. The
// workspace owns tab activation; this store owns the independent child runtime.
export const useSideChatStore = create<SideChatStore>((set, get) => ({
  entries: {},
  open: async (parentSessionId, options = {}) => {
    let id = Object.values(get().entries).find(entry => entry?.parentSessionId === parentSessionId && !closing.has(entry.sessionId))?.sessionId
    if (!id) {
      let pending = creating.get(parentSessionId)
      if (!pending) {
        pending = (async () => {
          const child = await sideChatsApi.create(parentSessionId)
          const parent = useSessionStore.getState().sessions.find(session => session.id === parentSessionId)
          const settings = useSettingsStore.getState()
          const providers = useProviderStore.getState()
          const selection = useSessionRuntimeStore.getState().selections[parentSessionId]
            ?? (parent?.runtimeModelId ? { providerId: parent.runtimeProviderId ?? null, modelId: parent.runtimeModelId, effortLevel: parent.effortLevel }
              : resolveDefaultRuntimeSelection(providers.activeId, settings.activeProviderName, providers.providers, settings.currentModel?.id))
          registerSideChatSession(child.sessionId, parentSessionId)
          useSessionRuntimeStore.getState().setSelection(child.sessionId, { ...selection })
          set(state => ({ entries: { ...state.entries, [child.sessionId]: {
            ...child, permissionMode: child.permissionMode ?? parent?.permissionMode as SideChatSession['permissionMode'],
          } } }))
          useChatStore.getState().connectToSession(child.sessionId, { prewarm: false, applyRuntimeSelection: false })
          return child.sessionId
        })().finally(() => { creating.delete(parentSessionId) })
        creating.set(parentSessionId, pending)
      }
      id = await pending
    }
    if (options.reference) {
      useWorkspaceChatContextStore.getState().addReference(id, options.reference)
      useChatStore.getState().queueComposerPrefill(id, { text: '', mode: 'append' })
    }
    if (options.question?.trim()) {
      const chat = useChatStore.getState()
      const text = options.question.trim()
      if (options.submit) {
        if ((chat.sessions[id]?.chatState ?? 'idle') === 'idle') chat.sendMessage(id, text)
        else chat.queueUserMessage(id, { content: text, displayContent: text })
      } else chat.queueComposerInsertion(id, { text })
    }
    return id
  },
  close: async id => {
    const existing = closing.get(id)
    if (existing) return existing
    const entry = get().entries[id]
    if (!entry) return
    const pending = (async () => {
      // Keep the registry until cleanup finishes so late WebSocket messages
      // cannot make the temporary session eligible for persistence.
      await sideChatsApi.discard(entry.parentSessionId, id)
      useChatStore.getState().disconnectSession(id)
      useWorkspaceChatContextStore.getState().clearSession(id)
      useSessionRuntimeStore.getState().clearSelection(id)
      unregisterSideChatSession(id)
      set(state => { const { [id]: _removed, ...entries } = state.entries; return { entries } })
    })().finally(() => { closing.delete(id) })
    closing.set(id, pending)
    return pending
  },
}))
