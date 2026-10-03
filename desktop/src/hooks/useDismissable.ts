import { useEffect } from 'react'

export type DismissReason = 'outside' | 'escape' | 'scroll' | 'resize'

export type UseDismissableOptions = {
  open: boolean
  /** Elements that count as "inside". A click within any of them is ignored. */
  refs: ReadonlyArray<{ current: HTMLElement | null }>
  /**
   * The element that opens the overlay. Clicks on it are not treated as
   * outside, because its own handler already toggles — without this the
   * overlay closes here and reopens on the same click.
   */
  triggerRef?: { current: HTMLElement | null }
  onDismiss: (reason: DismissReason) => void
  /**
   * Defaults to `pointerdown`. The 21 hand-rolled versions were split across
   * `mousedown` (14), `click` (3) and `pointerdown` (3); `mousedown` does not
   * fire reliably for touch input, which is the shape of the "tapping outside
   * doesn't close the menu" reports on the H5 build.
   */
  event?: 'pointerdown' | 'mousedown' | 'click'
  /**
   * Listen during capture. Defaults to true so a nested overlay closes its own
   * layer first instead of the outermost one swallowing the event.
   */
  capture?: boolean
  closeOnEscape?: boolean
  /**
   * Handle Escape during capture and stop it there. Set this for an overlay
   * that can appear inside a dialog: otherwise one Escape closes both, since
   * the dialog's own handler sees the same event.
   */
  stopEscapePropagation?: boolean
  /** Close when the page scrolls or the window resizes — for anchored overlays. */
  closeOnViewportChange?: boolean
  /** Escape hatch for portals rendered outside `refs`, e.g. a nested picker. */
  isExempt?: (target: EventTarget | null) => boolean
}

/**
 * Closes an overlay on an outside interaction, Escape, or (optionally) a
 * viewport change.
 *
 * This behavior was reimplemented 21 times across the app, no two the same:
 * some listened on `mousedown`, some on `click`; some handled Escape, most did
 * not; only a handful excluded the trigger, so the rest flickered when the
 * trigger was clicked twice. `ChatInput.tsx` and `EmptySession.tsx` carried
 * 59 byte-identical lines of it.
 *
 * Ported from `composite/OpenWithMenu.tsx`, which had the most complete
 * version. No floating-ui dependency.
 */
export function useDismissable({
  open,
  refs,
  triggerRef,
  onDismiss,
  event = 'pointerdown',
  capture = true,
  closeOnEscape = true,
  stopEscapePropagation = false,
  closeOnViewportChange = false,
  isExempt,
}: UseDismissableOptions): void {
  useEffect(() => {
    if (!open) return

    const handlePointer = (nativeEvent: Event) => {
      const target = nativeEvent.target as Node | null
      if (!target) return
      if (isExempt?.(target)) return
      if (refs.some((ref) => ref.current?.contains(target))) return
      if (triggerRef?.current?.contains(target)) return
      onDismiss('outside')
    }

    const handleKey = (nativeEvent: KeyboardEvent) => {
      if (nativeEvent.key !== 'Escape') return
      if (stopEscapePropagation) {
        nativeEvent.preventDefault()
        nativeEvent.stopPropagation()
      }
      onDismiss('escape')
    }

    // Scrolling *the overlay* is not a viewport change. The listener is on
    // capture (nested scroll containers do not bubble), so without this an
    // overlay tall enough to need its own scrollbar closes the instant the user
    // reaches for it — the scrollbar renders, and is unusable.
    const handleScroll = (nativeEvent: Event) => {
      // A page scroll targets `document` or `window`, neither of which is a Node,
      // so the containment check has to be guarded rather than cast into place.
      const target = nativeEvent.target
      if (target instanceof Node && refs.some((ref) => ref.current?.contains(target))) return
      onDismiss('scroll')
    }
    const handleResize = () => onDismiss('resize')

    // A page inside a `<webview>` or `<iframe>` never reports its pointer
    // events to this document: clicking into it only takes focus away from
    // the window. Focus landing in embedded content outside the overlay is
    // that same outside click. Read after the blur settles — Chromium blurs
    // the window before it moves `activeElement` onto the frame.
    let blurTimer: ReturnType<typeof setTimeout> | undefined
    const handleWindowBlur = () => {
      clearTimeout(blurTimer)
      blurTimer = setTimeout(() => {
        const active = document.activeElement
        if (!active || (active.tagName !== 'WEBVIEW' && active.tagName !== 'IFRAME')) return
        if (refs.some((ref) => ref.current?.contains(active))) return
        if (triggerRef?.current?.contains(active)) return
        onDismiss('outside')
      }, 0)
    }

    document.addEventListener(event, handlePointer, capture)
    window.addEventListener('blur', handleWindowBlur)
    if (closeOnEscape) document.addEventListener('keydown', handleKey, stopEscapePropagation)
    if (closeOnViewportChange) {
      // Capture on scroll: scroll events from nested containers do not bubble.
      window.addEventListener('scroll', handleScroll, true)
      window.addEventListener('resize', handleResize)
    }

    return () => {
      clearTimeout(blurTimer)
      window.removeEventListener('blur', handleWindowBlur)
      document.removeEventListener(event, handlePointer, capture)
      document.removeEventListener('keydown', handleKey, stopEscapePropagation)
      window.removeEventListener('scroll', handleScroll, true)
      window.removeEventListener('resize', handleResize)
    }
    // `refs` is typically a fresh array literal each render; depending on it
    // would re-subscribe every render. The ref objects it holds are stable, so
    // reading them inside the handler stays correct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, event, capture, closeOnEscape, stopEscapePropagation, closeOnViewportChange, onDismiss, triggerRef, isExempt])
}
