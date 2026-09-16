import { getDesktopHost } from './desktopHost'

/** Public H5 never accepts a query-selected server or a legacy bearer token. */
export function isPublicAccessRuntime(): boolean {
  return typeof window !== 'undefined' && !getDesktopHost().isDesktop &&
    (window.location.pathname === '/remote' || window.location.pathname.startsWith('/remote/'))
}
