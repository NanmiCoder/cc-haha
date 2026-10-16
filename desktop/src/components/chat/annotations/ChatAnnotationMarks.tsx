import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from '../../../i18n'
import { ANNOTATION_BADGE_SIZE, getAnnotationLayout, type AnnotationLayout } from './annotationAnchors'

export type ChatAnnotationMark = {
  id: string
  number: number
  quote: string
  startOffset?: number
  endOffset?: number
}

export type ChatAnnotationMarksProps = {
  annotations: ChatAnnotationMark[]
  onActivate: (mark: ChatAnnotationMark, anchorRect: DOMRect) => void
}

type PaintedMark = {
  mark: ChatAnnotationMark
  layout: AnnotationLayout
}

/**
 * Everything that changes which span an annotation points at. Comparing this
 * rather than the array identity keeps the repaint off the streaming re-render
 * path: a message re-renders on every chunk, but its annotations rarely change.
 */
function annotateSignature(annotations: ChatAnnotationMark[]) {
  return annotations
    .map((mark) => `${mark.id}\u0000${mark.number}\u0000${mark.quote}\u0000${mark.startOffset ?? ''}\u0000${mark.endOffset ?? ''}`)
    .join('\u0001')
}

function viewportRectForBadge(container: HTMLElement, badge: { left: number; top: number }): DOMRect {
  const rect = container.getBoundingClientRect()
  const left = rect.left + badge.left - container.scrollLeft
  const top = rect.top + badge.top - container.scrollTop
  return {
    left,
    top,
    right: left + ANNOTATION_BADGE_SIZE,
    bottom: top + ANNOTATION_BADGE_SIZE,
    width: ANNOTATION_BADGE_SIZE,
    height: ANNOTATION_BADGE_SIZE,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect
}

/**
 * Paints pending annotations back onto the message that produced them.
 *
 * The transcript is rendered by `MarkdownRenderer`, so wrapping the annotated
 * text is not ours to do — mutating that React-owned subtree would break the
 * next re-render. Instead the mark is an overlay the message component owns: a
 * tint per painted line, and one numbered badge the user can click to edit or
 * delete. Only the badge takes pointer events, so the text underneath stays
 * selectable — including to annotate the same span twice.
 *
 * Must be rendered as a direct child of the message wrapper, which is the
 * element the marks are measured and positioned against. The wrapper is reached
 * through this overlay's own `parentElement` rather than a ref passed down from
 * the message: a parent's ref is not attached yet when a child's first layout
 * effect runs, which would leave the first paint empty.
 */
export function ChatAnnotationMarks({ annotations, onActivate }: ChatAnnotationMarksProps) {
  const t = useTranslation()
  const [painted, setPainted] = useState<PaintedMark[]>([])
  const overlayRef = useRef<HTMLDivElement>(null)
  const annotationsRef = useRef(annotations)
  const signature = annotateSignature(annotations)

  const repaint = useCallback(() => {
    const container = overlayRef.current?.parentElement ?? null
    if (!container) {
      setPainted((current) => (current.length === 0 ? current : []))
      return
    }

    const next: PaintedMark[] = []
    for (const mark of annotationsRef.current) {
      const layout = getAnnotationLayout(container, mark)
      if (layout) next.push({ mark, layout })
    }

    const nextSignature = JSON.stringify(next.map(({ mark, layout }) => [mark.id, layout.rects, layout.badge]))
    setPainted((current) =>
      JSON.stringify(current.map(({ mark, layout }) => [mark.id, layout.rects, layout.badge])) === nextSignature
        ? current
        : next,
    )
  }, [])

  useLayoutEffect(() => {
    annotationsRef.current = annotations
  })

  useLayoutEffect(() => {
    repaint()
  }, [repaint, signature])

  // Images finishing their load and streaming text both resize the message
  // without changing the annotation set.
  useEffect(() => {
    const container = overlayRef.current?.parentElement
    if (!container || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => repaint())
    observer.observe(container)
    return () => observer.disconnect()
  }, [repaint])

  const container = overlayRef.current?.parentElement ?? null

  return (
    <div
      ref={overlayRef}
      data-testid="chat-annotation-marks"
      className="pointer-events-none absolute inset-0 z-[var(--z-raised)]"
    >
      {container && painted.map(({ mark, layout }) => (
        <Fragment key={mark.id}>
          {layout.rects.map((rect, index) => (
            <span
              key={index}
              aria-hidden="true"
              className="absolute rounded-t-[var(--radius-xs)] bg-[var(--color-brand-soft)]"
              style={{
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
                borderBottom: '1.5px solid var(--color-selection-bg)',
              }}
            />
          ))}
          <button
            type="button"
            data-annotation-id={mark.id}
            aria-label={t('chat.annotationEditLabel', { number: mark.number })}
            onClick={() => onActivate(mark, viewportRectForBadge(container, layout.badge))}
            className="pointer-events-auto absolute flex items-center justify-center rounded-[var(--radius-full)] bg-[var(--color-brand)] font-semibold tabular-nums text-[var(--color-on-primary)] shadow-[0_0_0_2px_var(--color-surface)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
            style={{
              left: layout.badge.left,
              top: layout.badge.top,
              width: ANNOTATION_BADGE_SIZE,
              height: ANNOTATION_BADGE_SIZE,
              fontSize: 11,
              lineHeight: 1,
            }}
          >
            {mark.number}
          </button>
        </Fragment>
      ))}
    </div>
  )
}
