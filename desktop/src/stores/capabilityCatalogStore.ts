import { create } from 'zustand'
import { safeMentionIcon } from '../lib/composerMentions'
import type { ComposerReferenceCandidate } from '../types/composerReference'

/**
 * Names and icons of the skills and connectors the composer last listed.
 *
 * A sent prompt keeps only the capability's identity (its model text names the
 * skill or plugin id), while the pill the user picked showed the display name
 * and brand icon. Remembering what the composer showed lets a sent bubble and
 * its edit draft show the same pill. In memory only: the composer lists them
 * again on every launch.
 */
export type CapabilityDisplay = { label: string, icon?: string }

type CapabilityCatalogState = {
  entries: Record<string, CapabilityDisplay>
  remember: (items: ComposerReferenceCandidate[]) => void
}

export const capabilityKey = (kind: 'skill' | 'plugin', id: string) => `${kind}:${id}`

export const useCapabilityCatalogStore = create<CapabilityCatalogState>((set) => ({
  entries: {},
  remember: (items) => set((state) => {
    let changed = false
    const entries = { ...state.entries }
    for (const item of items) {
      const key = capabilityKey(item.kind, item.id)
      const label = item.displayName || item.name
      const icon = safeMentionIcon(item.icon)
      const previous = entries[key]
      if (!label || (previous?.label === label && previous.icon === icon)) continue
      entries[key] = icon ? { label, icon } : { label }
      changed = true
    }
    return changed ? { entries } : state
  }),
}))
