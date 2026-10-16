import { useEffect, useRef, useState } from 'react'
import { useTranslation } from '@/i18n'
import type { PdfDocumentHandle } from './pdfEngine'
import { PDF_CSS_UNITS } from './pdfLayout'
import './pdfPage.css'

export type PdfPageProps = {
  doc: PdfDocumentHandle
  /** 1-based, as in the PDF. */
  pageNumber: number
  /** Pages in the document, for the page's accessible name. */
  total: number
  /** The zoom the sheet is sized at: follows a gesture live. */
  scale: number
  /**
   * The zoom the bitmap and the text were drawn at. It settles a beat after a
   * gesture ends, so a wheel zoom does not re-rasterise the page dozens of times.
   */
  drawScale: number
}

function isAbort(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === 'AbortError'
}

/** Give a canvas's backing store back now, rather than whenever the collector gets to it. */
function shrink(canvas: HTMLCanvasElement): void {
  canvas.width = 0
  canvas.height = 0
}

function releaseChildren(host: HTMLElement): void {
  host.querySelectorAll('canvas').forEach(shrink)
  host.replaceChildren()
}

/**
 * Give a page back to the engine. Tidying up after a drawing that is already gone
 * or replaced: whatever goes wrong here is no reason to fail anything that is on screen.
 */
function handBack(drawn: { doc: PdfDocumentHandle; pageNumber: number } | null): void {
  if (!drawn) return
  try {
    drawn.doc.releasePage(drawn.pageNumber)
  } catch {
    // The document is closed, or closing.
  }
}

/**
 * One page of a PDF: paper, the canvas drawn on it, and the transparent text
 * laid over the canvas so the words can be selected and copied.
 *
 * The page is drawn into elements that are not yet on screen and swapped in when
 * both are done. Drawing into the visible canvas instead would clear it the moment
 * its size is set, and every zoom would flash the page white before it came back.
 * The same holds when the document itself is replaced (the agent rewrote the file):
 * the previous drawing stays until the new one is ready.
 *
 * The parent mounts a page only while it is near the viewport, so unmounting is
 * how a page lets go of its bitmap.
 */
export function PdfPage({ doc, pageNumber, total, scale, drawScale }: PdfPageProps) {
  const t = useTranslation()
  const hostRef = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)
  // What is on the sheet right now. Releasing asks pdf.js for the page it is about
  // to clean up, which parses it: for a page that never finished drawing that is
  // work done only to throw it away.
  const drawnFor = useRef<{ doc: PdfDocumentHandle; pageNumber: number } | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const controller = new AbortController()
    const canvas = document.createElement('canvas')
    const textLayer = document.createElement('div')
    textLayer.className = 'textLayer'

    void (async () => {
      try {
        await doc.renderPage(pageNumber, { canvas, scale: drawScale, signal: controller.signal })
        await doc.renderTextLayer(pageNumber, { container: textLayer, scale: drawScale, signal: controller.signal })
      } catch (error) {
        // Nothing of this drawing is on the sheet yet, so what is there stays: a
        // cancelled draw is not a failure, and a failed redraw leaves the previous,
        // still-valid drawing in place.
        shrink(canvas)
        if (!isAbort(error)) setFailed(true)
        return
      }
      if (controller.signal.aborted) {
        shrink(canvas)
        return
      }

      // From here the drawing is on the sheet, and nothing below may undo it.
      // The sentinel that keeps a drag-selection from collapsing when the pointer
      // leaves the last span (what pdf.js' own viewer appends to its text layer).
      const endOfContent = document.createElement('div')
      endOfContent.className = 'endOfContent'
      textLayer.append(endOfContent)
      releaseChildren(host)
      host.append(canvas, textLayer)
      setFailed(false)

      const previous = drawnFor.current
      drawnFor.current = { doc, pageNumber }
      if (previous && (previous.doc !== doc || previous.pageNumber !== pageNumber)) handBack(previous)
    })()

    return () => {
      controller.abort()
    }
  }, [doc, pageNumber, drawScale])

  useEffect(() => {
    const host = hostRef.current
    return () => {
      // Scrolled far away, or the panel closed: a page is megabytes of bitmap.
      if (host) releaseChildren(host)
      const drawn = drawnFor.current
      drawnFor.current = null
      handBack(drawn)
    }
  }, [])

  useEffect(() => {
    const endSelection = () => hostRef.current?.querySelector('.textLayer')?.classList.remove('selecting')
    window.addEventListener('mouseup', endSelection)
    return () => window.removeEventListener('mouseup', endSelection)
  }, [])

  return (
    <div
      role="group"
      data-document-page={pageNumber}
      aria-label={t('workspace.pdf.pageOfTotal', { page: pageNumber, total })}
      className="cc-pdf-page h-full w-full shadow-[var(--shadow-card)]"
      style={{ ['--scale-factor' as string]: scale * PDF_CSS_UNITS }}
    >
      <div
        ref={hostRef}
        className="absolute inset-0"
        onMouseDown={() => hostRef.current?.querySelector('.textLayer')?.classList.add('selecting')}
      />
      {failed ? (
        <p role="status" className="absolute inset-x-0 top-1/3 px-4 text-center text-xs text-[var(--color-document-ink)]">
          {t('workspace.pdf.pageFailed')}
        </p>
      ) : null}
    </div>
  )
}
