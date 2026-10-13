import { create } from 'zustand'

/**
 * Deliberately its own key rather than a field on `cc-haha-chat-appearance`:
 * the bubble position is not a reading style, so changing it must not rewrite
 * the appearance record, and "Reset chat appearance" must not clear it.
 */
export const SELECTION_MENU_PLACEMENT_STORAGE_KEY = 'cc-haha-selection-menu-placement'

/**
 * Where the action menu goes after a text selection. `auto` is the upstream
 * rule from #351: a multi-line selection gets the slot beside where it ends,
 * which is also where the reader's eye is going next. `above` drops that slot
 * and floats the menu over the selection instead, so it never covers the text
 * that follows.
 */
export type SelectionMenuPlacement = 'auto' | 'above'

export const DEFAULT_SELECTION_MENU_PLACEMENT: SelectionMenuPlacement = 'auto'

type PlacementStorage = Pick<Storage, 'getItem' | 'setItem'>

export function normalizeSelectionMenuPlacement(value: unknown): SelectionMenuPlacement {
  return value === 'above' ? 'above' : 'auto'
}

function getPlacementStorage(): PlacementStorage | null {
  try { return globalThis.localStorage ?? null } catch { return null }
}

export function readSelectionMenuPlacement(
  storage: PlacementStorage | null = getPlacementStorage(),
): SelectionMenuPlacement {
  try {
    return normalizeSelectionMenuPlacement(storage?.getItem(SELECTION_MENU_PLACEMENT_STORAGE_KEY))
  } catch {
    return DEFAULT_SELECTION_MENU_PLACEMENT
  }
}

export function persistSelectionMenuPlacement(
  placement: SelectionMenuPlacement,
  storage: PlacementStorage | null = getPlacementStorage(),
): void {
  if (!storage) return
  try {
    storage.setItem(SELECTION_MENU_PLACEMENT_STORAGE_KEY, normalizeSelectionMenuPlacement(placement))
  } catch { /* Keep the control usable when storage is unavailable. */ }
}

type SelectionMenuPlacementState = {
  placement: SelectionMenuPlacement
  setPlacement: (placement: SelectionMenuPlacement) => void
}

export const useSelectionMenuPlacementStore = create<SelectionMenuPlacementState>((set) => ({
  placement: readSelectionMenuPlacement(),
  setPlacement: (placement) => {
    const normalized = normalizeSelectionMenuPlacement(placement)
    persistSelectionMenuPlacement(normalized)
    set({ placement: normalized })
  },
}))

/** True when the bubble should float over the selection instead of beside it. */
export function prefersSelectionMenuAbove(): boolean {
  return useSelectionMenuPlacementStore.getState().placement === 'above'
}
