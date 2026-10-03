import { useCallback } from 'react'
import { setWorkspaceBrowserGuestLayer } from '@/lib/workspace/browserGuests'

/**
 * Where every workspace browser page lives, for the life of the window.
 *
 * It must be mounted once and never re-parented: a `<webview>` reloads when
 * moved and dies when removed. It sits after the session content in the same
 * stacking context, so a page paints over the workspace like the placeholder it
 * covers and under every dropdown, dialog and toast, and it fades with the
 * session panel when another page takes the window.
 */
export function WorkspaceBrowserGuestLayer() {
  const register = useCallback((element: HTMLDivElement | null) => {
    setWorkspaceBrowserGuestLayer(element)
  }, [])
  return (
    <div
      ref={register}
      data-testid="workspace-browser-guest-layer"
      className="pointer-events-none absolute inset-0 z-0"
    />
  )
}
