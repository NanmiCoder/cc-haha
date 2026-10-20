import { useCallback, useEffect, useRef, useState } from 'react'
import { getSelectionPopoverPosition, useSelectionPopoverDismiss } from '@/hooks/useSelectionPopoverDismiss'
import { prefersSelectionMenuAbove } from '@/stores/selectionMenuPlacementStore'
import { getElementForNode, getSelectionPosition, type FloatingSelectionMenuState } from '@/components/workspace/surfaces/textSelection'
import type { DocumentAnnotationSelection } from '@/components/workspace/surfaces/document/DocumentAnnotation'

type PageSelection = FloatingSelectionMenuState & DocumentAnnotationSelection

/** Reads only ranges wholly inside rendered pages, including sandboxed Word frames. */
export function readPageSelection(root: HTMLElement, frame?: HTMLIFrameElement): PageSelection | null {
  const selection = root.ownerDocument.getSelection()
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null
  const selector = frame ? 'section.docx' : '[data-document-page]'
  const pages = Array.from(root.querySelectorAll(selector))
  const pageFor = (node: Node) => getElementForNode(node)?.closest(selector)
  const start = pageFor(range.startContainer)
  const end = pageFor(range.endContainer)
  if (!start || !end) return null
  const numberOf = (page: Element) => frame ? pages.indexOf(page) + 1 : Number(page.getAttribute('data-document-page'))
  const first = numberOf(start)
  const last = numberOf(end)
  const text = selection.toString().trim()
  if (!text || first < 1 || last < 1 || !Number.isFinite(first) || !Number.isFinite(last)) return null

  let position: { x: number; y: number }
  if (frame) {
    const origin = frame.getBoundingClientRect()
    const translate = (rect: DOMRect) => new DOMRect(rect.x + origin.left, rect.y + origin.top, rect.width, rect.height)
    const translatedRange = {
      getBoundingClientRect: () => translate(range.getBoundingClientRect?.() ?? new DOMRect()),
      getClientRects: () => Array.from(range.getClientRects?.() ?? []).map(translate),
    } as unknown as Range
    position = getSelectionPopoverPosition(translatedRange, frame, {
      menuWidth: 140, menuHeight: 32, offset: 10, preferAbove: prefersSelectionMenuAbove(),
    })
  } else {
    position = getSelectionPosition(range, root, selection)
  }
  return { ...position, text, location: first === last ? `Page ${first}` : `Pages ${first}–${last}` }
}

export function usePageAnnotation({ rootRef, frame, identity, revision, path, onAnnotate }: {
  rootRef: { current: HTMLElement | null }
  frame?: HTMLIFrameElement
  identity: unknown
  revision?: unknown
  path: string
  onAnnotate?: (selection: DocumentAnnotationSelection) => void
}) {
  const [selection, setSelection] = useState<PageSelection | null>(null)
  const popoverRef = useRef<HTMLButtonElement | null>(null)
  const dragging = useRef(false)
  const dismiss = useCallback(() => {
    setSelection(null)
    const root = frame?.contentDocument?.body ?? rootRef.current
    const active = root?.ownerDocument.getSelection()
    if (active?.anchorNode && root?.contains(active.anchorNode)) active.removeAllRanges()
  }, [frame, rootRef])
  const reposition = useCallback(() => {
    const root = frame?.contentDocument?.body ?? rootRef.current
    if (root && !dragging.current) setSelection(readPageSelection(root, frame))
  }, [frame, rootRef])
  useSelectionPopoverDismiss({ active: !!selection, popoverRef, onDismiss: dismiss, onScroll: reposition })

  useEffect(() => {
    dragging.current = false
    setSelection(null)
    const root = frame?.contentDocument?.body ?? rootRef.current
    if (!root || !onAnnotate) return
    const doc = root.ownerDocument
    const outerDoc = rootRef.current?.ownerDocument
    const update = () => {
      if (!dragging.current) setSelection(readPageSelection(root, frame))
    }
    const pointerdown = (event: PointerEvent) => {
      if (event.button !== 0 || !event.target || !root.contains(event.target as Node)) return
      dragging.current = true
      setSelection(null)
    }
    const pointerup = () => {
      dragging.current = false
      update()
    }
    // Don't activate scroll dismissal until the gesture finishes: scrolling is
    // part of selecting text across pages, including inside the Word iframe.
    const cancel = () => {
      dragging.current = false
      dismiss()
    }
    doc.addEventListener('pointerdown', pointerdown, true)
    doc.addEventListener('pointercancel', cancel, true)
    if (outerDoc && outerDoc !== doc) {
      outerDoc.addEventListener('pointerup', pointerup, true)
      outerDoc.addEventListener('pointercancel', cancel, true)
    }
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') cancel() }
    doc.addEventListener('selectionchange', update)
    doc.addEventListener('pointerup', pointerup, true)
    doc.addEventListener('keyup', update)
    doc.addEventListener('keydown', keydown)
    return () => {
      dragging.current = false
      doc.removeEventListener('pointerdown', pointerdown, true)
      doc.removeEventListener('pointercancel', cancel, true)
      if (outerDoc && outerDoc !== doc) {
        outerDoc.removeEventListener('pointerup', pointerup, true)
        outerDoc.removeEventListener('pointercancel', cancel, true)
      }
      doc.removeEventListener('selectionchange', update)
      doc.removeEventListener('pointerup', pointerup, true)
      doc.removeEventListener('keyup', update)
      doc.removeEventListener('keydown', keydown)
      // React may already have removed the iframe before passive cleanup. Do
      // not schedule a selectionchange event on its closed document.
      const active = !frame || frame.isConnected ? doc.getSelection() : null
      if (active?.anchorNode && root.contains(active.anchorNode)) active.removeAllRanges()
    }
  }, [rootRef, frame, identity, revision, path, onAnnotate, dismiss])

  const add = () => {
    if (!selection || !onAnnotate) return
    onAnnotate({ text: selection.text, location: selection.location })
    dismiss()
    rootRef.current?.ownerDocument.getSelection()?.removeAllRanges()
  }
  return { selection, popoverRef, add }
}
