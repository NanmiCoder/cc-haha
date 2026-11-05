export type WindowOpenHandlerResult = { action: 'deny' } | { action: 'allow' }

export type NavigationGuardWebContents = {
  setWindowOpenHandler(handler: (details: { url: string }) => WindowOpenHandlerResult): void
  on(
    event: 'will-navigate' | 'will-redirect',
    handler: (event: { preventDefault: () => void; isMainFrame?: boolean }, url: string) => void,
  ): unknown
}

export type NavigationGuardOptions = {
  openExternal: (url: string) => void
}

export function isHttpUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

export function isAllowedMainWindowNavigationUrl(url: string, rendererUrl: string): boolean {
  try {
    const parsed = new URL(url)
    const entry = new URL(rendererUrl)
    if (!['file:', 'http:', 'https:'].includes(entry.protocol)) return false
    if (parsed.protocol !== entry.protocol || parsed.host !== entry.host) return false
    if (parsed.username || parsed.password) return false
    // Only the configured document can inherit preload. In particular, file:
    // has a null origin, so comparing origins alone would trust every file.
    // Query/hash changes are used by the SPA and the pet window.
    const pathname = decodeURIComponent(parsed.pathname)
    const entryPathname = decodeURIComponent(entry.pathname)
    return entry.protocol === 'file:' && process.platform === 'win32'
      ? pathname.toLowerCase() === entryPathname.toLowerCase()
      : pathname === entryPathname
  } catch {
    return false
  }
}

/**
 * Main app window guard. The renderer is a single-page app loaded from a fixed
 * entry; it should never spawn an uncontrolled child window. Any window.open /
 * target=_blank with an http(s) URL is routed to the system browser and the
 * Electron popup is denied. Top-level navigation is restricted to local
 * renderer entries so a remote page cannot inherit the privileged preload.
 */
export function installMainWindowNavigationGuards(
  webContents: NavigationGuardWebContents,
  { openExternal, rendererUrl }: NavigationGuardOptions & { rendererUrl: string },
): void {
  webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) openExternal(url)
    return { action: 'deny' }
  })
  const guard = (event: { preventDefault: () => void; isMainFrame?: boolean }, url: string) => {
    if (event.isMainFrame === false) return
    if (isAllowedMainWindowNavigationUrl(url, rendererUrl)) return
    event.preventDefault()
    if (isHttpUrl(url)) openExternal(url)
  }
  webContents.on('will-navigate', guard)
  webContents.on('will-redirect', guard)
}

/**
 * Preview (WebContentsView) guard. The preview renders untrusted remote pages,
 * so it must keep working as a browser: in-page http(s) navigation is allowed.
 * Popups are denied (http(s) ones handed to the system browser), and navigation
 * to any non-http(s) scheme (file:, custom schemes) is blocked outright.
 */
export function installPreviewNavigationGuards(
  webContents: NavigationGuardWebContents,
  { openExternal }: NavigationGuardOptions,
): void {
  webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) openExternal(url)
    return { action: 'deny' }
  })
  webContents.on('will-navigate', (event, url) => {
    if (!isHttpUrl(url)) event.preventDefault()
  })
}
