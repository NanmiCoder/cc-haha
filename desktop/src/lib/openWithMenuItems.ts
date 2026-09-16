import {
  buildOpenWithItems,
  type OpenWithContext,
  type OpenWithDeps,
  type OpenWithItem,
} from './openWithItems'
import { openWithContextForHref } from './openWithContextForHref'
import { getServerBaseUrl } from './desktopRuntime'
import { getDesktopHost } from './desktopHost'
import { copyTextToClipboard } from './clipboard'
import { sessionsApi } from '../api/sessions'
import type { OpenTarget } from '../stores/openTargetStore'
import { workspaceOpen } from './workspace/openTarget'
import { useOpenTargetStore } from '../stores/openTargetStore'
import { reportOpenFailure } from './systemFileOpen'

type Translate = (key: string, vars?: Record<string, string>) => string

/**
 * Bind {@link OpenWithDeps} to the real stores, once.
 *
 * Same reasoning as `openPreviewLink`: the chat body, the output cards and the
 * workspace file tree all build this menu, and three hand-copied dependency
 * objects is how they drift. Anything added here — the copy entries, say —
 * shows up in all three at once.
 *
 * Only the dependency wiring is shared, not how `targets` are fetched: the file
 * tree already has them from a selector and must stay synchronous so its menu
 * does not render a frame short.
 */
export type OpenWithMenuOptions = {
  sessionId: string
  t: Translate
  /**
   * Set where the surrounding menu already offers one — the workspace file tree
   * has its own "copy path" / "copy absolute path" pair above this block, and a
   * third entry with the same label reads as a bug.
   */
  omitCopyPath?: boolean
}

export function openWithMenuDeps(
  ctx: OpenWithContext,
  { sessionId, t, omitCopyPath }: OpenWithMenuOptions,
): OpenWithDeps {
  return {
    openInAppBrowser: (url) => { workspaceOpen.browser(sessionId, url) },
    openSystem: (target) => {
      void getDesktopHost().shell.openPath(target).catch(() => window.open(target, '_blank'))
    },
    openWorkspacePreview: (relPath) => {
      workspaceOpen.file(sessionId, relPath)
    },
    openTarget: (id, absolutePath) => {
      void useOpenTargetStore.getState().openTarget(id, absolutePath)
    },
    // Read at build time rather than passed down: every caller would otherwise
    // have to remember to thread it, and the one that forgot would silently show
    // a different editor than the settings page promises.
    ...(useOpenTargetStore.getState().editorTargetId
      ? { preferredEditorTargetId: useOpenTargetStore.getState().editorTargetId ?? undefined }
      : {}),
    // A URL context has no path and no readable contents, so the copy entries are
    // left out entirely rather than shown disabled.
    ...(ctx.kind === 'file'
      ? {
          ...(omitCopyPath
            ? {}
            : {
                copyPath: (absolutePath: string) => {
                  void copyTextToClipboard(absolutePath)
                },
              }),
          copyFileContent: (path: string) => {
            void (async () => {
              const result = await sessionsApi.getWorkspaceFile(sessionId, path)
              if (result.state !== 'ok' || typeof result.content !== 'string') return
              await copyTextToClipboard(result.content)
            })().catch(() => {})
          },
        }
      : {}),
    t,
  }
}

/** Build the menu from targets the caller already holds. */
export function buildOpenWithMenuItems(
  ctx: OpenWithContext,
  targets: OpenTarget[],
  opts: OpenWithMenuOptions,
): OpenWithItem[] {
  return buildOpenWithItems(ctx, targets, openWithMenuDeps(ctx, opts))
}

/**
 * Build the menu for a reference written in the prose (`src/app.ts:42`, a URL, …),
 * resolving the open targets first.
 */
export async function buildOpenWithMenuItemsForHref(
  href: string,
  opts: OpenWithMenuOptions & { workDir?: string },
): Promise<OpenWithItem[]> {
  const ctx = openWithContextForHref(href, {
    sessionId: opts.sessionId,
    serverBaseUrl: getServerBaseUrl(),
    workDir: opts.workDir,
  })
  if (!ctx) return []

  if (ctx.kind !== 'file') return buildOpenWithMenuItems(ctx, [], opts)

  let targets: OpenTarget[]
  try {
    targets = await useOpenTargetStore.getState().getTargetsForPath(ctx.absolutePath)
  } catch {
    // The server refuses a path that is not there, and this used to reject into a
    // floating promise: the menu simply never opened, with nothing said. A
    // reference the assistant wrote can outlive the file, so say which one and why
    // rather than leaving the click looking broken.
    reportOpenFailure(ctx.absolutePath)
    return []
  }
  return buildOpenWithMenuItems(ctx, targets, opts)
}
