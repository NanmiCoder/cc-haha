import { create } from 'zustand'
import {
  applyChatAppearance,
  CHAT_APPEARANCE_STORAGE_KEY,
  DEFAULT_CHAT_APPEARANCE,
  getAppearanceStorage,
  normalizeChatAppearance,
  persistChatAppearance,
  readChatAppearance,
  type ChatAppearance,
} from '@/lib/chatAppearance'

type ChatAppearanceState = {
  appearance: ChatAppearance
  setAppearance: (patch: Partial<ChatAppearance>) => void
  resetAppearance: () => void
}

export const useChatAppearanceStore = create<ChatAppearanceState>((set, get) => ({
  appearance: readChatAppearance(),
  setAppearance: (patch) => {
    const appearance = normalizeChatAppearance({ ...get().appearance, ...patch })
    persistChatAppearance(appearance)
    applyChatAppearance(appearance)
    set({ appearance })
  },
  resetAppearance: () => get().setAppearance(DEFAULT_CHAT_APPEARANCE),
}))

/** Called after persistence migrations, before the app renders. */
export function initializeChatAppearance(): () => void {
  const refresh = () => {
    const appearance = readChatAppearance()
    applyChatAppearance(appearance)
    useChatAppearanceStore.setState({ appearance })
  }
  refresh()
  if (typeof window === 'undefined') return () => {}
  const onStorage = (event: StorageEvent) => {
    if (event.storageArea !== null && event.storageArea !== getAppearanceStorage()) return
    if (event.key === CHAT_APPEARANCE_STORAGE_KEY || event.key === null) refresh()
  }
  window.addEventListener('storage', onStorage)
  return () => window.removeEventListener('storage', onStorage)
}
