import { useEffect } from 'react'
import { useWorkspaceStore } from '../stores/workspaceStore'

/**
 * Return focus to the title-bar entry point that a panel was hidden from.
 *
 * This cannot live inside the panel. Hiding the workspace unmounts the whole
 * surface, so the `side-toggle` request raised by that action would never be
 * consumed there — and worse, it would survive in the store and fire on the
 * next reopen, parking focus on the button that hides the panel again.
 *
 * The toggles are looked up by attribute rather than by ref because they belong
 * to a sibling subtree, and threading a ref across that boundary would couple
 * the title bar to the panel's lifecycle in exactly the way that broke this.
 */
export function useWorkspaceFocusReturn(sessionId: string | null) {
  const focus = useWorkspaceStore((state) =>
    sessionId ? state.bySession[sessionId]?.focus ?? null : null,
  )

  useEffect(() => {
    if (!sessionId || !focus) return
    if (focus.target !== 'side-toggle' && focus.target !== 'bottom-toggle') return

    const toggle = document.querySelector<HTMLElement>(
      `[data-workspace-focus="${focus.target}"]`,
    )
    // Consume either way: an unconsumed request outlives the moment it was
    // about and would be honoured at some unrelated later mount.
    toggle?.focus({ preventScroll: true })
    useWorkspaceStore.getState().consumeFocusRequest(sessionId)
  }, [focus, sessionId])
}
