import { create } from 'zustand'
import { normalizeTabBehavior, persistTabBehavior, readTabBehavior, type TabBehavior } from '@/lib/tabBehavior'

type TabBehaviorState = {
  behavior: TabBehavior
  setBehavior: (patch: Partial<TabBehavior>) => void
}

export const useTabBehaviorStore = create<TabBehaviorState>((set, get) => ({
  behavior: readTabBehavior(),
  setBehavior: (patch) => {
    const behavior = normalizeTabBehavior({ ...get().behavior, ...patch })
    persistTabBehavior(behavior)
    set({ behavior })
  },
}))
