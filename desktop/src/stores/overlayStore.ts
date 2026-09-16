import { useEffect } from 'react'
import { create } from 'zustand'

/**
 * Tracks how many fullscreen DOM overlays (image preview modals, etc.) are
 * currently mounted. A native child webview (e.g. the in-app browser preview)
 * always renders ABOVE the DOM, so it covers any fullscreen overlay; surfaces
 * driving such webviews read this count and hide the webview while count > 0.
 *
 * Reusable: any fullscreen overlay can opt in via `push()` / `pop()` (or the
 * helper hook `useSuppressBrowserOverlay()` below).
 */
type OverlayStore = {
  count: number
  snapshotCount: number
  push: (preserveSnapshot?: boolean) => void
  pop: (preserveSnapshot?: boolean) => void
}

export const useOverlayStore = create<OverlayStore>((set) => ({
  count: 0,
  snapshotCount: 0,
  push: (preserveSnapshot = false) => set((state) => ({
    count: state.count + 1,
    snapshotCount: state.snapshotCount + (preserveSnapshot ? 1 : 0),
  })),
  pop: (preserveSnapshot = false) => set((state) => ({
    count: Math.max(0, state.count - 1),
    snapshotCount: Math.max(0, state.snapshotCount - (preserveSnapshot ? 1 : 0)),
  })),
}))

/**
 * Mount-scoped helper: increments the overlay count on mount, decrements on
 * unmount. Pairs cleanly with strict-mode double-invoke because each effect
 * run does exactly one inc + one dec.
 */
export function useSuppressBrowserOverlay({ preserveSnapshot = false }: { preserveSnapshot?: boolean } = {}) {
  useEffect(() => {
    const { push, pop } = useOverlayStore.getState()
    push(preserveSnapshot)
    return () => pop(preserveSnapshot)
  }, [preserveSnapshot])
}
