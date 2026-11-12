/**
 * App Whether still in the foreground. During iOS inactive (pulling down Notification Center, Control Center, Face ID, app switcher)
 * the process keeps running and the connection stays up, so it is not leaving; only background counts.
 * The argument is the AppState state; early-launch `unknown`/empty is treated as not foreground until the first event.
 */
export function isAppForeground(state: string | null | undefined) {
  return state === 'active' || state === 'inactive'
}

/**
 * Fold AppState changes into "leave" and "return": entering background counts as leaving, and the first active
 * afterwards counts as returning. Flickering between active ↔ inactive (Control Center, Face ID) is neither, 
 * and must not reset cooldowns or renegotiate on every flicker. `initial` is AppState.currentState at subscription.
 */
export function foregroundTransitions(initial?: string | null) {
  let away = initial === 'background'
  return (state: string | null | undefined): 'left' | 'returned' | null => {
    if (state === 'background') {
      if (away) return null
      away = true
      return 'left'
    }
    if (state !== 'active' || !away) return null
    away = false
    return 'returned'
  }
}
