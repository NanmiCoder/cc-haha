import { useEffect, useRef, useState } from 'react'

/**
 * The phone app: the Expo web build of `mobile/`, which the desktop server
 * hosts under `/m/` next to this app (see `src/server/staticH5.ts`). Phone and
 * tablet browsers use it instead of this app's own phone shell, so the H5 and
 * the native phone app are one implementation.
 *
 * This app still owns the way in: the H5 token page and remote pairing run here
 * first, and leave the credential the phone app reads (the stored H5 token, or
 * the remote device cookie).
 */
export const MOBILE_H5_PATH = '/m/'
/** Written by `mobile/scripts/export-h5.ts`; present only when the phone app was built. */
export const MOBILE_H5_MARKER_PATH = '/m/h5.json'
export const MOBILE_H5_MARKER_APP = 'cc-haha-mobile'

type MarkerFetch = (
  input: string,
  init: { cache: 'no-store'; credentials: 'same-origin' },
) => Promise<{ ok: boolean; headers: { get(name: string): string | null }; json(): Promise<unknown> }>

/** Whether the server that served this page also serves the phone app. */
export async function isMobileH5Available(fetchMarker: MarkerFetch = (input, init) => fetch(input, init)): Promise<boolean> {
  try {
    const response = await fetchMarker(MOBILE_H5_MARKER_PATH, { cache: 'no-store', credentials: 'same-origin' })
    // A dev server answers unknown paths with its own index page.
    if (!response.ok || !response.headers.get('content-type')?.includes('json')) return false
    const marker = await response.json() as { app?: unknown } | null
    return marker?.app === MOBILE_H5_MARKER_APP
  } catch {
    return false
  }
}

/**
 * The phone app only talks to the computer that served it. A page pointed at a
 * different server (`?serverUrl=`, a dev launcher) stays on this app.
 */
export function servesItsOwnServer(serverUrl: string, pageOrigin: string): boolean {
  try {
    return new URL(serverUrl).origin === pageOrigin
  } catch {
    return false
  }
}

/**
 * Whether the phone app will find the credential this page connected with.
 * It is a new page that reads the LAN token from this origin's storage, so a
 * token held only in memory (storage full, or denied and replaced in memory by
 * index.html) would send it straight back to the token page. A remote
 * browser's device cookie and a loopback page need nothing stored. Mirrors
 * `storedH5Token` in mobile/src/core/h5Session.ts.
 */
export function phoneAppCanAuthenticate({
  storagePersistent,
  authToken,
  stored,
  pageOrigin,
}: {
  /** False when this browser denied web storage (see lib/browserStorage.ts). */
  storagePersistent: boolean
  /** The bearer token this page uses; null for the remote cookie and loopback. */
  authToken: string | null
  stored: { serverUrl: string | null; token: string | null }
  pageOrigin: string
}): boolean {
  if (!storagePersistent) return false
  if (!authToken) return true
  if (stored.token !== authToken || !stored.serverUrl) return false
  try {
    return new URL(stored.serverUrl).origin === pageOrigin
  } catch {
    return false
  }
}

export type MobileH5Handoff = 'checking' | 'leaving' | 'unavailable'

/**
 * Decides once, when the connection first becomes ready, whether this page
 * leaves for the phone app. Only the layout at that moment counts: a desktop
 * window narrowed later keeps this app (its own phone layout, reversible),
 * instead of being torn down mid-use. `unavailable` covers every way of
 * staying: not a phone or tablet, another server, a token the phone app could
 * not read, or no phone build.
 */
export function useMobileH5Handoff({
  ready,
  eligible,
  serverUrl,
  available = isMobileH5Available,
  leave = () => window.location.replace(MOBILE_H5_PATH),
}: {
  ready: boolean
  /** Read once, when `ready` first turns true. */
  eligible: () => boolean
  serverUrl: () => string
  available?: () => Promise<boolean>
  leave?: () => void
}): MobileH5Handoff {
  const [state, setState] = useState<MobileH5Handoff>('checking')
  const decided = useRef(false)
  const eligibleRef = useRef(eligible)
  eligibleRef.current = eligible
  useEffect(() => {
    if (!ready || decided.current) return
    decided.current = true
    if (!eligibleRef.current() || !servesItsOwnServer(serverUrl(), window.location.origin)) {
      setState('unavailable')
      return
    }
    // Not cancelled on unmount or re-render: the decision is made exactly once.
    void available().then((ok) => {
      if (!ok) {
        setState('unavailable')
        return
      }
      setState('leaving')
      leave()
    })
  }, [ready, serverUrl, available, leave])
  return state
}
