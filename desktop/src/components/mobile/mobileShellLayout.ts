import { useEffect, useState } from 'react'

/**
 * Which shell the app draws.
 *
 * - `desktop`: Electron, or a desktop browser at least a tablet wide.
 * - `phone`: anything narrower than a tablet outside Electron. One page at a
 *   time, a stack you go back through.
 * - `tablet`: a browser at least a tablet wide whose primary pointer is touch
 *   (iPad, Android tablets). A laptop with a touch screen still has a mouse or
 *   trackpad as its primary pointer and keeps the desktop app; its touch
 *   styling comes from `data-touch-h5` (touchH5.ts), not from the layout.
 */
export type MobileShellLayout = 'desktop' | 'phone' | 'tablet'

export const TABLET_MIN_WIDTH_PX = 768
const PHONE_QUERY = `(max-width: ${TABLET_MIN_WIDTH_PX - 1}px)`

export function resolveMobileShellLayout({
  desktopRuntime,
  coarsePointer,
  narrow,
}: {
  desktopRuntime: boolean
  /** The primary pointer is touch: `(pointer: coarse)`. */
  coarsePointer: boolean
  narrow: boolean
}): MobileShellLayout {
  if (desktopRuntime) return 'desktop'
  if (narrow) return 'phone'
  return coarsePointer ? 'tablet' : 'desktop'
}

/** Mirrored by the phone fast path in index.html. */
export const COARSE_POINTER_QUERY = '(pointer: coarse)'

function matchesCoarsePointer(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia(COARSE_POINTER_QUERY).matches
  } catch {
    return false
  }
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

  return resolveMobileShellLayout({ desktopRuntime, coarsePointer: matchesCoarsePointer(), narrow })
}
