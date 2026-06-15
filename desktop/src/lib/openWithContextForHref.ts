import { classifyPreviewLink } from './previewLinkRouter'
import { shouldOfferStaticHtmlPreview } from './htmlPreviewPolicy'
import { isAbsoluteLocalPath, localFileUrl, previewFsUrl } from './handlePreviewLink'
import type { OpenWithContext } from './openWithItems'

/**
 * Build an open-with context for a workspace file (we have both its relative +
 * absolute path).
 *
 * `siblingFiles` is the rest of the same change-set (the turn's changed files).
 * It lets {@link shouldOfferStaticHtmlPreview} tell a hand-authored single-page
 * `index.html` (→ offer a static browser preview) from a framework template
 * that ships with a `package.json` / `vite.config.*` (→ source view only).
 */
export function openWithContextForWorkspaceFile(
  relPath: string,
  absolutePath: string,
  opts: { sessionId: string; serverBaseUrl: string; siblingFiles?: string[] },
): OpenWithContext {
  // A changed file that could not be relativized against the workdir arrives with
  // an absolute `relPath` — it lives outside the session workspace (e.g. another
  // drive). Such a file is served by the $HOME/registered-root /local-file route,
  // not the workdir-sandboxed /preview-fs route.
  const outsideWorkspace = isAbsoluteLocalPath(relPath)
  const inAppBrowserUrl = shouldOfferStaticHtmlPreview(relPath, { siblingFiles: opts.siblingFiles })
    ? outsideWorkspace
      ? localFileUrl(opts.serverBaseUrl, absolutePath)
      : previewFsUrl(opts.serverBaseUrl, opts.sessionId, relPath)
    : undefined
  return {
    kind: 'file',
    absolutePath,
    relPath,
    previewable: true,
    inAppBrowserUrl,
  }
}

function resolveAbsolute(workDir: string | undefined, p: string): string {
  // Tilde paths are home-relative, not workspace-relative — pass them through
  // for the backend (which knows the home dir and platform) to expand.
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) return p
  if (!workDir || p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p)) return p
  return `${workDir.replace(/[\\/]+$/, '')}/${p.replace(/^[/\\]+/, '')}`
}

export function openWithContextForHref(
  href: string,
  opts: { sessionId: string; serverBaseUrl: string; workDir?: string },
): OpenWithContext | null {
  const c = classifyPreviewLink(href)
  if ((c.kind === 'browser-localhost' || c.kind === 'remote') && c.url) {
    return { kind: 'url', url: c.url }
  }
  if (c.kind === 'file-preview' && c.path) {
    return { kind: 'file', absolutePath: resolveAbsolute(opts.workDir, c.path), relPath: c.path, previewable: true }
  }
  if (c.kind === 'browser-file' && c.path) {
    // Absolute paths may be outside the session workspace → serve via the
    // $HOME-sandboxed /local-file route; relative paths stay workspace-scoped.
    const absolutePath = resolveAbsolute(opts.workDir, c.path)
    if (isAbsoluteLocalPath(c.path)) {
      return { kind: 'file', absolutePath, inAppBrowserUrl: localFileUrl(opts.serverBaseUrl, c.path) }
    }
    if (shouldOfferStaticHtmlPreview(c.path)) {
      return { kind: 'file', absolutePath, inAppBrowserUrl: previewFsUrl(opts.serverBaseUrl, opts.sessionId, c.path) }
    }
    return { kind: 'file', absolutePath, relPath: c.path, previewable: true }
  }
  return null
}
