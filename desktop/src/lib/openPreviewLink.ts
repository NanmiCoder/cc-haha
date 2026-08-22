import { handlePreviewLink } from './handlePreviewLink'
import { getServerBaseUrl } from './desktopRuntime'
import { getDesktopHost } from './desktopHost'
import { useBrowserPanelStore } from '../stores/browserPanelStore'
import { useWorkspacePanelStore } from '../stores/workspacePanelStore'
import { openLocalFileWithSystem, resolveAbsoluteOpenPath } from './systemFileOpen'

/**
 * Route a clicked link the way the chat surface always has: a loopback URL opens
 * the workbench browser on the right, a workspace file opens its preview, and a
 * remote URL goes to the system browser.
 *
 * {@link handlePreviewLink} stays dependency-injected for testing; this is the
 * one place that binds it to the real stores, so the markdown body, the output
 * cards and the user prompt bubble cannot drift apart.
 *
 * Returns true when the link was handled (the caller should preventDefault).
 */
export function openPreviewLink(href: string, sessionId: string): boolean {
  return handlePreviewLink(href, {
    sessionId,
    serverBaseUrl: getServerBaseUrl(),
    openBrowser: (id, url) => useBrowserPanelStore.getState().open(id, url),
    openFilePreview: (id, path, reveal) => {
      void useWorkspacePanelStore.getState().openPreview(id, path, 'file', undefined, reveal)
    },
    openSystemFile: (path) => {
      const workDir = useWorkspacePanelStore.getState().statusBySession[sessionId]?.workDir
      void openLocalFileWithSystem(resolveAbsoluteOpenPath(path, workDir))
    },
    openExternal: (url) => {
      void getDesktopHost().shell.open(url)
        .catch(() => window.open(url, '_blank'))
    },
  })
}
