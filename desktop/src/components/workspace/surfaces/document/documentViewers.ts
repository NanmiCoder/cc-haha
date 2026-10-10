import { lazy, type ComponentType, type LazyExoticComponent } from 'react'
import type { WorkspaceDocumentPreviewType } from '@/api/sessions'
import type { WorkspaceReveal } from '@/lib/workspace/types'
import type { WorkspaceFileView } from '@/stores/workspaceContentStore'
import type { WorkspaceTextSelection } from '../textSelection'

/**
 * What a document that is really text needs to show its source and take comments on it,
 * the same way the panel does for any other text file.
 */
export type DocumentSourceActions = {
  reveal?: WorkspaceReveal
  revealScroll?: boolean
  onAddLineComment: (lineStart: number, lineEnd: number, note: string, quote: string) => void
  onAddSelection: (selection: WorkspaceTextSelection) => void
}

/**
 * What every document viewer is handed. `DocumentSurface` owns fetching the bytes
 * and every state around them (loading, failed, refreshing); a viewer's job is to
 * turn a `Blob` into pixels and report the zoom the reader chose.
 */
export type DocumentViewerProps = {
  /** The path as the workspace knows it (relative to the workdir when it is inside). */
  path: string
  /** Where the file lives on disk, for handing it to the operating system. */
  absolutePath: string
  /**
   * The document's bytes. Take your own `arrayBuffer()`: an engine may transfer
   * (and so detach) the buffer it is given, and the same Blob is held for the
   * next tab switch.
   */
  blob: Blob
  /** The version `blob` holds. */
  version: string
  /** A newer version is being fetched; `blob` is still the previous one. */
  refreshing: boolean
  /**
   * The zoom the reader chose, as a scale factor, or `undefined` for the viewer's
   * default (fit). Controlled: report a change through `onZoomChange`.
   */
  zoom: number | undefined
  onZoomChange: (zoom: number | undefined) => void
  /** For a workbook: the worksheet it was left on, by name, and how to remember a change. */
  sheet?: string
  onSheetChange?: (sheet: string) => void
  /**
   * The scroll position this file had when its tab was last open. A viewer's
   * content lays out asynchronously, so restoring it is the viewer's job, once
   * there is something to scroll: mark the scroll container
   * `data-workspace-scroll-surface="deferred"` so the panel keeps recording the
   * position but leaves restoring it to you.
   */
  initialView: WorkspaceFileView | undefined
  /** For a document that is text underneath (`.csv`): how to show and annotate its source. */
  source?: DocumentSourceActions
}

export type DocumentViewer = LazyExoticComponent<ComponentType<DocumentViewerProps>>

export type DocumentViewers = Partial<Record<WorkspaceDocumentPreviewType, DocumentViewer>>

/** Whether a file's `previewType` names a document (bytes fetched separately) rather than text or an image. */
export function isDocumentPreviewType(value: string | undefined): value is WorkspaceDocumentPreviewType {
  return value === 'pdf' || value === 'docx' || value === 'xlsx'
}

/**
 * Viewers by document type.
 *
 * A type joins this map when its viewer lands, not before: the server already
 * classifies more documents than the workspace can draw, and `DocumentSurface`
 * answers the rest with "open it in the system app". Each entry is a lazy import
 * so an engine — pdf.js, docx-preview and SheetJS are hundreds of KB apiece — is
 * fetched when the first document of its kind is opened, not at startup.
 */
export const documentViewers: DocumentViewers = {
  pdf: lazy(() => import('./PdfSurface')),
  docx: lazy(() => import('./DocxSurface')),
  xlsx: lazy(() => import('./SpreadsheetSurface')),
}
