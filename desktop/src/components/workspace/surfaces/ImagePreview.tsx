import { useState } from 'react'
import { ExternalLink, ImageOff } from 'lucide-react'
import { IconButton } from '@/components/ui/IconButton'
import { ZoomableImage, type ImageZoom } from '@/components/ui/ZoomableImage'
import { useTranslation } from '@/i18n'
import { openLocalFileWithSystem, reportOpenFailure } from '@/lib/systemFileOpen'
import { useWorkspaceContentStore, workspaceFileKey, type WorkspaceFileView } from '@/stores/workspaceContentStore'
import { OpenInSystemButton } from './OpenInSystemButton'
import { PanelMessage } from './PanelMessage'

/**
 * The workspace's image viewer: fit-to-window by default, zoom and pan, and a way
 * to hand the original to the system's image app.
 *
 * `sessionId` lets the zoom survive a tab switch (the tab remounts this component);
 * without it the zoom is local. `absolutePath` enables the system-app action.
 * `initialView` is where the reader left the picture: a zoomed one is scrolled back
 * there once it is laid out, which is not before it has loaded.
 */
export function ImagePreview({
  sessionId,
  dataUrl,
  path,
  absolutePath,
  error,
  initialView,
}: {
  sessionId?: string
  dataUrl?: string
  path: string
  absolutePath?: string
  error?: string
  initialView?: WorkspaceFileView
}) {
  const t = useTranslation()
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const storedZoom = useWorkspaceContentStore((state) => (
    sessionId ? state.fileViewByKey[workspaceFileKey(sessionId, path)]?.zoom : undefined
  ))

  if (!dataUrl || failedUrl === dataUrl) {
    return (
      <PanelMessage
        icon={ImageOff}
        message={(!dataUrl && error) || t('workspace.imagePreviewUnavailable')}
        action={absolutePath ? <OpenInSystemButton absolutePath={absolutePath} /> : undefined}
      />
    )
  }

  const onZoomChange = (next: ImageZoom) => {
    if (sessionId) useWorkspaceContentStore.getState().setFileZoom(sessionId, path, next === 'fit' ? undefined : next)
  }

  return (
    <ZoomableImage
      // The measured natural size belongs to one picture, so a new picture is a new viewer.
      key={dataUrl}
      src={dataUrl}
      alt={path}
      zoom={sessionId ? storedZoom ?? 'fit' : undefined}
      onZoomChange={onZoomChange}
      initialScroll={sessionId && initialView ? { left: initialView.scrollLeft, top: initialView.scrollTop } : undefined}
      onError={() => setFailedUrl(dataUrl)}
      labels={{
        group: t('workspace.zoom.group'),
        zoomIn: t('workspace.zoom.in'),
        zoomOut: t('workspace.zoom.out'),
        fit: t('workspace.zoom.fitWindow'),
      }}
      actions={absolutePath ? (
        <IconButton
          icon={<ExternalLink size={14} strokeWidth={1.75} />}
          label={t('workspace.openInSystemApp')}
          size="sm"
          tone="secondary"
          onClick={() => {
            void openLocalFileWithSystem(absolutePath).catch(() => reportOpenFailure(absolutePath))
          }}
        />
      ) : undefined}
    />
  )
}
