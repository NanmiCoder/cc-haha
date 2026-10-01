import { handlePreviewLink, isAbsoluteLocalPath, isRootedLocalPath } from './handlePreviewLink'
import { getServerBaseUrl } from './desktopRuntime'
import { getDesktopHost } from './desktopHost'
import { isWithinWorkDir } from './assistantOutputTargets'
import { isWorkspaceDocumentFile } from './fileCapabilities'
import { useWorkspaceContentStore } from '../stores/workspaceContentStore'
import { sessionsApi } from '../api/sessions'
import { workspaceOpen } from './workspace/openTarget'
import { openLocalFileWithSystem, reportOpenFailure, resolveAbsoluteOpenPath } from './systemFileOpen'

/**
 * Cheap, synchronous guess at whether the workspace preview can reach this document.
 *
 * The file routes serve the session workdir and the roots registered for files a
 * turn changed; a document elsewhere (`~/thesis.docx`, another drive) would open
 * a tab that goes straight to a 403. A relative path is resolved against the
 * workdir by the server, which is reachable unless its `../` climbs out of the
 * workdir — `../shared/spec.pdf` is as far outside as its absolute form.
 *
 * This is only a string comparison, so a `false` is not final: the workdir the
 * server reports is canonical (`/private/tmp/app`), while the path in the chat is
 * whatever form the model wrote (`/tmp/app/report.pdf`). Symlinked folders, registered
 * access roots and a workdir that has not loaded yet all look "outside" here. Only
 * the server, which resolves real paths, can settle those — see
 * {@link documentReachableOnServer}.
 */
function documentReachableInWorkspace(path: string, workDir: string | undefined): boolean {
  if (!isRootedLocalPath(path)) return !workDir || isWithinWorkDir(resolveAbsoluteOpenPath(path, workDir), workDir)
  if (!workDir || !isAbsoluteLocalPath(path)) return false
  return isWithinWorkDir(path, workDir)
}

/**
 * Ask the server whether it will serve this document in the workspace. It resolves
 * real paths and registered roots, so it answers what the string check above cannot;
 * a refusal (403) or an unreachable server means "keep it with the system app".
 */
async function documentReachableOnServer(sessionId: string, path: string): Promise<boolean> {
  try {
    await sessionsApi.getWorkspaceFile(sessionId, path)
    return true
  } catch {
    return false
  }
}

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
  const currentWorkDir = () => useWorkspaceContentStore.getState().statusBySession[sessionId]?.workDir
  const openSystemFile = (path: string) => {
    const absolutePath = resolveAbsoluteOpenPath(path, currentWorkDir())
    void openLocalFileWithSystem(absolutePath).catch(() => reportOpenFailure(absolutePath))
  }

  return handlePreviewLink(href, {
    sessionId,
    serverBaseUrl: getServerBaseUrl(),
    openBrowser: (id, url) => { workspaceOpen.browser(id, url) },
    openFilePreview: (id, path, reveal) => {
      const openInWorkspace = () => {
        workspaceOpen.file(id, path, {
          ...(reveal ? { line: reveal.line, ...(reveal.column ? { column: reveal.column } : {}) } : {}),
        })
      }
      if (!isWorkspaceDocumentFile(path) || documentReachableInWorkspace(path, currentWorkDir())) {
        openInWorkspace()
        return
      }
      void documentReachableOnServer(id, path).then((reachable) => {
        if (reachable) openInWorkspace()
        else openSystemFile(path)
      })
    },
    openSystemFile,
    openExternal: (url) => {
      void getDesktopHost().shell.open(url)
        .catch(() => window.open(url, '_blank'))
    },
  })
}
