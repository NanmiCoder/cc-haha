import { FileQuestion } from 'lucide-react'
import { Suspense } from 'react'
import type { WorkspaceDocumentPreviewType } from '@/api/sessions'
import { useWorkspaceDocumentBlob } from '@/hooks/useWorkspaceDocumentBlob'
import { useTranslation } from '@/i18n'
import { isRootedLocalPath } from '@/lib/handlePreviewLink'
import {
  useWorkspaceContentStore,
  workspaceFileKey,
  type WorkspaceFileView,
} from '@/stores/workspaceContentStore'
import { OpenInSystemButton } from '../OpenInSystemButton'
import { PanelMessage } from '../PanelMessage'
import { DocumentFailure } from './DocumentFailure'
import { DocumentViewerBoundary } from './DocumentViewerBoundary'
import { documentViewers, type DocumentViewers } from './documentViewers'

export type DocumentSurfaceProps = {
  sessionId: string
  path: string
  absolutePath: string
  previewType: WorkspaceDocumentPreviewType
  /** From the file's metadata; undefined until it has loaded. */
  version: string | undefined
  /** The scroll position this file had when its tab was last open. */
  initialView: WorkspaceFileView | undefined
  /** Overridable so a test can supply a viewer without loading a real engine. */
  viewers?: DocumentViewers
  /** What "try again" does when the viewer itself could not be loaded. Overridable so a test need not reload the window. */
  reloadPage?: () => void
}

/**
 * A viewer that failed to load stays failed until the page is loaded again. Browsers
 * remember a module whose fetch failed for the life of the document, so importing it
 * again in place — even with the network back — is refused, and only a reload asks for
 * it anew (which is also what brings in a newer bundle, after a server update).
 */
function reloadWindow(): void {
  window.location.reload()
}

/**
 * Everything around a document viewer: fetching its bytes, and what to show when
 * there are none yet, when they failed to arrive, or when a newer copy is on its
 * way. The viewers themselves only turn a Blob into pixels.
 *
 * A refresh — the agent rewrote the file — keeps the previous render on screen
 * and says so, instead of blanking a page someone is reading.
 */
export function DocumentSurface({
  sessionId,
  path,
  absolutePath,
  previewType,
  version,
  initialView,
  viewers = documentViewers,
  reloadPage = reloadWindow,
}: DocumentSurfaceProps) {
  const t = useTranslation()
  const Viewer = viewers[previewType]
  // No viewer for this kind: nothing to fetch bytes for.
  const { blob, blobVersion, loading, error, errorStatus, retry } = useWorkspaceDocumentBlob(
    sessionId,
    path,
    Viewer ? version : undefined,
  )
  const zoom = useWorkspaceContentStore((state) => state.fileViewByKey[workspaceFileKey(sessionId, path)]?.zoom)
  const sheet = useWorkspaceContentStore((state) => state.fileViewByKey[workspaceFileKey(sessionId, path)]?.sheet)
  const canOpenInSystem = isRootedLocalPath(absolutePath)

  if (!Viewer) {
    return (
      <PanelMessage
        icon={FileQuestion}
        message={t('workspace.document.unsupported')}
        action={canOpenInSystem ? <OpenInSystemButton absolutePath={absolutePath} /> : undefined}
      />
    )
  }

  if (!blob) {
    if (error) {
      return (
        <DocumentFailure
          message={failureMessage(errorStatus, t)}
          absolutePath={absolutePath}
          // A file outside the workspace or over the limit will not change its mind.
          onRetry={errorStatus === 403 || errorStatus === 413 || errorStatus === 415 ? undefined : retry}
        />
      )
    }
    return <PanelMessage busy message={t('workspace.document.loading')} />
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <DocumentViewerBoundary
        resetKey={`${path}\u0000${blobVersion ?? ''}`}
        fallback={
          <DocumentFailure
            message={t('workspace.document.engineUnavailable')}
            absolutePath={absolutePath}
            onRetry={reloadPage}
          />
        }
      >
        <Suspense fallback={<PanelMessage busy message={t('workspace.document.loading')} />}>
          <Viewer
            path={path}
            absolutePath={absolutePath}
            blob={blob}
            version={blobVersion ?? ''}
            refreshing={loading}
            zoom={zoom}
            onZoomChange={(next) => useWorkspaceContentStore.getState().setFileZoom(sessionId, path, next)}
            sheet={sheet}
            onSheetChange={(next) => useWorkspaceContentStore.getState().setFileSheet(sessionId, path, next)}
            initialView={initialView}
          />
        </Suspense>
      </DocumentViewerBoundary>
      {error ? (
        <p role="status" className="shrink-0 border-t border-[var(--color-border)] px-3 py-1.5 text-[11px] text-[var(--color-text-tertiary)]">
          {/* The server's own words are its response body, JSON and English; a refusal has a status to word. */}
          {t('workspace.files.refreshFailed', { reason: errorStatus === null ? error : failureMessage(errorStatus, t) })}
        </p>
      ) : loading ? (
        <p role="status" className="shrink-0 border-t border-[var(--color-border)] px-3 py-1.5 text-[11px] text-[var(--color-text-tertiary)]">
          {t('workspace.document.updating')}
        </p>
      ) : null}
    </div>
  )
}

function failureMessage(status: number | null, t: ReturnType<typeof useTranslation>): string {
  if (status === 403) return t('workspace.document.outsideWorkspace')
  if (status === 404) return t('workspace.previewState.missing')
  if (status === 413) return t('workspace.previewState.tooLarge')
  return t('workspace.document.parseFailed')
}
