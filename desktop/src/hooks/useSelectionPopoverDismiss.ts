import { useEffect } from 'react'

type ElementRef = {
  current: HTMLElement | null
}

const VIEWPORT_MARGIN = 12

type SelectionRect = {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

type SelectionGeometry = {
  rect: SelectionRect | DOMRect
  clientRects: DOMRect[]
  isMultiLine: boolean
}

type SelectionFocus = {
  node: Node | null
  offset: number
}

function clampValue(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max))
}

function isUsableRect(rect: SelectionRect | DOMRect) {
  return rect.width > 0 || rect.height > 0
}

function getRangeSelectionGeometry(range: Range): SelectionGeometry | null {
  const clientRects = typeof range.getClientRects === 'function'
    ? Array.from(range.getClientRects()).filter(isUsableRect)
    : []
  const boundingRect = typeof range.getBoundingClientRect === 'function'
    ? range.getBoundingClientRect()
    : null

  if (clientRects.length > 0) {
    const left = Math.min(...clientRects.map((rect) => rect.left))
    const top = Math.min(...clientRects.map((rect) => rect.top))
    const right = Math.max(...clientRects.map((rect) => rect.right))
    const bottom = Math.max(...clientRects.map((rect) => rect.bottom))
    const unionRect = {
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top,
    }
    const maxLineHeight = Math.max(...clientRects.map((rect) => rect.height))
    return {
      rect: boundingRect && isUsableRect(boundingRect) ? boundingRect : unionRect,
      clientRects,
      isMultiLine: clientRects.length > 1 || unionRect.height > maxLineHeight * 1.6,
    }
  }

  if (boundingRect && isUsableRect(boundingRect)) {
    return {
      rect: boundingRect,
      clientRects: [],
      isMultiLine: boundingRect.height > 32,
    }
  }

  return null
}

function getSelectionFocusRect(
  range: Range,
  root: HTMLElement,
  geometry: SelectionGeometry,
  focus?: SelectionFocus,
  fallbackPointer?: { clientX: number; clientY: number },
) {
  if (!geometry.isMultiLine) return geometry.rect

  if (focus?.node && root.contains(focus.node)) {
    try {
      const focusRange = document.createRange()
      focusRange.setStart(focus.node, focus.offset)
      focusRange.collapse(true)
      const focusRect = typeof focusRange.getBoundingClientRect === 'function'
        ? focusRange.getBoundingClientRect()
        : null
      if (focusRect && isUsableRect(focusRect)) return focusRect
    } catch {
      // The selection can change between selectionchange and the queued layout read.
    }
  }

  if (geometry.clientRects.length === 0) return geometry.rect
  if (focus?.node === range.startContainer && focus.offset === range.startOffset) {
    return geometry.clientRects[0]!
  }
  if (focus?.node === range.endContainer && focus.offset === range.endOffset) {
    return geometry.clientRects[geometry.clientRects.length - 1]!
  }
  if (!fallbackPointer) return geometry.clientRects[geometry.clientRects.length - 1]!

  return geometry.clientRects.reduce((closest, rect) => {
    const distanceToRect = (candidate: DOMRect) => {
      const dx = fallbackPointer.clientX < candidate.left
        ? candidate.left - fallbackPointer.clientX
        : fallbackPointer.clientX > candidate.right
          ? fallbackPointer.clientX - candidate.right
          : 0
      const dy = fallbackPointer.clientY < candidate.top
        ? candidate.top - fallbackPointer.clientY
        : fallbackPointer.clientY > candidate.bottom
          ? fallbackPointer.clientY - candidate.bottom
          : 0
      return dx * dx + dy * dy
    }
    return distanceToRect(rect) < distanceToRect(closest) ? rect : closest
  })
}

export function clearWindowSelection() {
  window.getSelection()?.removeAllRanges()
}

export function getSelectionPopoverPosition(
  range: Range,
  root: HTMLElement,
  {
    menuWidth,
    menuHeight,
    offset,
    fallbackPointer,
    selectionFocus,
    preferAbove = false,
  }: {
    menuWidth: number
    menuHeight: number
    offset: number
    fallbackPointer?: { clientX: number; clientY: number }
    selectionFocus?: SelectionFocus
    /**
     * False keeps the upstream rule: a multi-line selection gets the slot beside
     * where it ends. True drops that slot so the menu goes above the selection
     * instead. See `SelectionMenuPlacement` in
     * stores/selectionMenuPlacementStore.ts.
     */
    preferAbove?: boolean
  },
) {
  const geometry = getRangeSelectionGeometry(range)
  const rootRect = root.getBoundingClientRect()
  const pointerInsideRoot = fallbackPointer
    && fallbackPointer.clientX >= rootRect.left
    && fallbackPointer.clientX <= rootRect.right
    && fallbackPointer.clientY >= rootRect.top
    && fallbackPointer.clientY <= rootRect.bottom
  const fallbackX = pointerInsideRoot ? fallbackPointer.clientX : rootRect.left + 24
  const fallbackY = pointerInsideRoot ? fallbackPointer.clientY : rootRect.top + 24
  const selectionRect = geometry?.rect ?? {
    left: fallbackX,
    top: fallbackY,
    right: fallbackX,
    bottom: fallbackY,
    width: 0,
    height: 0,
  }
  const anchorRect = geometry
    ? getSelectionFocusRect(range, root, geometry, selectionFocus, fallbackPointer)
    : selectionRect
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || rootRect.right + VIEWPORT_MARGIN
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || rootRect.bottom + VIEWPORT_MARGIN
  const minX = VIEWPORT_MARGIN
  const maxX = Math.max(minX, viewportWidth - menuWidth - VIEWPORT_MARGIN)
  const minY = VIEWPORT_MARGIN
  const maxY = Math.max(minY, viewportHeight - menuHeight - VIEWPORT_MARGIN)
  const clampPosition = (position: { x: number; y: number }) => ({
    x: clampValue(position.x, minX, maxX),
    y: clampValue(position.y, minY, maxY),
  })
  const centerX = anchorRect.left + anchorRect.width / 2
  const centerY = anchorRect.top + anchorRect.height / 2
  // Preferring above changes where the slot is measured from. The default
  // anchors on the focus line, which is what the right-side slot below needs;
  // measuring above from there would drop the menu onto the earlier selected
  // lines, so that mode measures from the whole selection instead.
  const aboveAnchor = preferAbove ? selectionRect : anchorRect
  const above = {
    x: aboveAnchor.left + aboveAnchor.width / 2 - menuWidth / 2,
    y: aboveAnchor.top - menuHeight - offset,
  }

  const right = {
    x: anchorRect.right + offset,
    y: centerY - menuHeight / 2,
  }
  if (!preferAbove && geometry?.isMultiLine && right.x + menuWidth <= viewportWidth - VIEWPORT_MARGIN) return clampPosition(right)

  if (above.y >= VIEWPORT_MARGIN) return clampPosition(above)

  if (right.x + menuWidth <= viewportWidth - VIEWPORT_MARGIN) return clampPosition(right)

  const below = {
    x: centerX - menuWidth / 2,
    y: anchorRect.bottom + offset,
  }
  if (below.y + menuHeight <= viewportHeight - VIEWPORT_MARGIN) return clampPosition(below)

  return clampPosition(above)
}

export function useSelectionPopoverDismiss({
  active,
  popoverRef,
  onDismiss,
  onScroll,
}: {
  active: boolean
  popoverRef: ElementRef
  onDismiss: () => void
  /** Override scroll handling for selections that should survive viewport movement. */
  onScroll?: () => void
}) {
  useEffect(() => {
    if (!active) return

    const dismiss = () => {
      onDismiss()
      clearWindowSelection()
    }

    const handlePointerDown = (event: PointerEvent) => {
      const isContextMenuPointer = event.button === 2 || (event.pointerType === 'mouse' && event.ctrlKey)
      const popover = popoverRef.current
      const target = event.target
      if (popover && target instanceof Node && popover.contains(target) && !isContextMenuPointer) {
        return
      }
      if (isContextMenuPointer) {
        onDismiss()
        return
      }

      dismiss()
    }

    const handleContextMenu = () => {
      onDismiss()
    }

    const handleScroll = () => {
      if (onScroll) onScroll()
      else dismiss()
    }

    document.addEventListener('pointerdown', handlePointerDown, true)
    document.addEventListener('contextmenu', handleContextMenu, true)
    document.addEventListener('scroll', handleScroll, true)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
      document.removeEventListener('contextmenu', handleContextMenu, true)
      document.removeEventListener('scroll', handleScroll, true)
    }
  }, [active, onDismiss, onScroll, popoverRef])
}
