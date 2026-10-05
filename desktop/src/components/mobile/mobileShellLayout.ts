import { useEffect, useState } from 'react'
import { isTouchH5Document } from '../../lib/touchH5'

/**
 * Which shell the app draws.
 *
 * - `desktop`: Electron, or a desktop browser at least a tablet wide.
 * - `phone`: anything narrower than a tablet outside Electron. One page at a
 *   time, a stack you go back through.
 * - `tablet`: a touch browser at least a tablet wide. The session list stays on
 *   the left and the page sits beside it, with the phone's touch controls —
 *   a touch screen gets no hover-only buttons or drag handles at any width.
 */
export type MobileShellLayout = 'desktop' | 'phone' | 'tablet'

export const TABLET_MIN_WIDTH_PX = 768
const PHONE_QUERY = `(max-width: ${TABLET_MIN_WIDTH_PX - 1}px)`

export function resolveMobileShellLayout({
  desktopRuntime,
  touch,
  narrow,
}: {
  desktopRuntime: boolean
  touch: boolean
  narrow: boolean
}): MobileShellLayout {
  if (desktopRuntime) return 'desktop'
  if (narrow) return 'phone'
  return touch ? 'tablet' : 'desktop'
}

function matchesPhoneWidth(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(PHONE_QUERY).matches
}

export function useMobileShellLayout(desktopRuntime: boolean): MobileShellLayout {
  const [narrow, setNarrow] = useState(matchesPhoneWidth)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia(PHONE_QUERY)
    const update = () => setNarrow(query.matches)
    update()
    query.addEventListener?.('change', update)
    return () => query.removeEventListener?.('change', update)
  }, [])

  return resolveMobileShellLayout({ desktopRuntime, touch: isTouchH5Document(), narrow })
}
