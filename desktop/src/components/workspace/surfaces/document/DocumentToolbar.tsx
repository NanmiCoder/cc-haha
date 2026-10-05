import type { ReactNode } from 'react'
import { ExternalLink } from 'lucide-react'
import { IconButton } from '@/components/ui/IconButton'
import { ZoomControls, type ZoomControlsProps } from '@/components/ui/ZoomControls'
import { useTranslation } from '@/i18n'
import { isRootedLocalPath } from '@/lib/handlePreviewLink'
import { openLocalFileWithSystem, reportOpenFailure } from '@/lib/systemFileOpen'

export type DocumentZoomState = Omit<ZoomControlsProps, 'labels' | 'surface' | 'flat' | 'fitMode' | 'className'>

/**
 * The bar above a rendered document: whatever is specific to the kind of document
 * on the left (page number, sheet tabs), then zoom, then the way out to the app
 * that made the file.
 *
 * Kept as one bar for PDF, Word and Excel so switching between tabs of different
 * kinds does not move the controls.
 */
export function DocumentToolbar({
  leading,
  zoom,
  absolutePath,
  note,
}: {
  leading?: ReactNode
  /** Omit for a document with nothing to zoom. */
  zoom?: DocumentZoomState
  absolutePath: string
  /** A line saying what this preview leaves out; shown under the bar. */
  note?: string
}) {
  const t = useTranslation()
  const canOpenInSystem = isRootedLocalPath(absolutePath)

  return (
    <div className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="flex h-10 items-center gap-2 pl-3 pr-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">{leading}</div>
        {zoom ? (
          <ZoomControls
            {...zoom}
            flat
            fitMode="width"
            labels={{
              group: t('workspace.zoom.group'),
              zoomIn: t('workspace.zoom.in'),
              zoomOut: t('workspace.zoom.out'),
              fit: t('workspace.zoom.fitWidth'),
            }}
          />
        ) : null}
        {canOpenInSystem ? (
          <IconButton
            icon={<ExternalLink size={14} strokeWidth={1.75} />}
            label={t('workspace.openInSystemApp')}
            size="sm"
            tone="secondary"
            onClick={() => {
              void openLocalFileWithSystem(absolutePath).catch(() => reportOpenFailure(absolutePath))
            }}
          />
        ) : null}
      </div>
      {note ? (
        <p title={note} className="truncate px-3 pb-1.5 text-[12px] text-[var(--color-text-tertiary)]">
          {note}
        </p>
      ) : null}
    </div>
  )
}
