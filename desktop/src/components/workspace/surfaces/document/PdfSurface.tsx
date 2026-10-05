import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useTranslation } from '@/i18n'
import { getDesktopHost } from '@/lib/desktopHost'
import { PanelMessage } from '../PanelMessage'
import { DocumentFailure } from './DocumentFailure'
import type { DocumentViewerProps } from './documentViewers'
import { defaultPdfEngine, type PdfEngine, type PdfError } from './pdfEngine'
import { PdfViewer } from './PdfViewer'
import { usePdfDocument } from './usePdfDocument'

export type PdfSurfaceProps = DocumentViewerProps & {
  /** Overridable so a test can supply a document without loading pdf.js. */
  engine?: PdfEngine
}

/**
 * The PDF viewer `DocumentSurface` loads for `.pdf` files: opening the document,
 * then handing it to {@link PdfViewer}, or saying why it could not be shown.
 */
export default function PdfSurface({
  blob,
  path,
  absolutePath,
  zoom,
  onZoomChange,
  initialView,
  engine = defaultPdfEngine,
}: PdfSurfaceProps) {
  const t = useTranslation()
  const { current, error, retry } = usePdfDocument(engine, blob)

  if (current) {
    return (
      <PdfViewer
        doc={current.doc}
        sizes={current.sizes}
        path={path}
        absolutePath={absolutePath}
        zoom={zoom}
        onZoomChange={onZoomChange}
        initialView={initialView}
        refreshError={error}
      />
    )
  }
  if (error) {
    return (
      <DocumentFailure
        message={failureMessage(error, t)}
        absolutePath={absolutePath}
        // The same bytes fail the same way, unless pdf.js itself was what failed to start.
        onRetry={error.kind === 'unavailable' ? retry : undefined}
        extraActions={error.kind === 'unavailable' && !getDesktopHost().isDesktop ? <OpenInBrowserButton blob={blob} /> : undefined}
      />
    )
  }
  return <PanelMessage busy message={t('workspace.document.loading')} />
}

function failureMessage(error: PdfError, t: ReturnType<typeof useTranslation>): string {
  if (error.kind === 'password') return t('workspace.document.passwordProtected')
  if (error.kind === 'unavailable') return t('workspace.document.engineUnavailable')
  return t('workspace.document.parseFailed')
}

/**
 * A browser that cannot run pdf.js (an old phone) usually still has a PDF viewer
 * of its own. Hand it the bytes we already fetched with the session's credentials,
 * which a plain link to the server could not carry.
 */
function OpenInBrowserButton({ blob }: { blob: Blob }) {
  const t = useTranslation()
  return (
    <Button
      variant="secondary"
      size="sm"
      icon={<ExternalLink size={14} strokeWidth={1.75} aria-hidden="true" />}
      onClick={() => {
        const url = URL.createObjectURL(blob)
        window.open(url, '_blank', 'noopener')
        // Long enough for the new tab to have read it.
        setTimeout(() => URL.revokeObjectURL(url), 60_000)
      }}
    >
      {t('workspace.document.openInBrowser')}
    </Button>
  )
}
