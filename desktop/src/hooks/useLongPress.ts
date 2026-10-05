import { useCallback, useEffect, useRef, type MouseEvent, type PointerEvent } from 'react'

export const LONG_PRESS_DELAY_MS = 450
const MOVE_TOLERANCE_PX = 10

export type LongPressPoint = { clientX: number; clientY: number }

type Options = {
  onLongPress: (point: LongPressPoint) => void
  disabled?: boolean
  delayMs?: number
}

/**
 * Press-and-hold for touch rows, the phone's stand-in for a right click.
 *
 * iOS Safari never fires `contextmenu`, so a timer on `pointerdown` does the
 * work there; Android Chrome and desktop mice do fire it, and the handler
 * folds that into the same callback without opening twice. A finger that
 * moves past a few pixels is scrolling, not pressing, and cancels. The click
 * that ends a long press is swallowed so the row's tap action does not run
 * underneath the menu it just opened.
 *
 * Callers add `select-none [-webkit-touch-callout:none]` to the element, or
 * iOS shows its own copy/lookup callout on top.
 *
 * Events from a portal rendered by the element's children (the menu this
 * press opens is one) still bubble to it through React. Only events whose
 * DOM target is inside the element count, or a tap in that menu would be
 * swallowed as the end of the press that opened it.
 */
function fromInside(event: { currentTarget: HTMLElement; target: EventTarget | null }): boolean {
  return event.target instanceof Node && event.currentTarget.contains(event.target)
}

export function useLongPress({ onLongPress, disabled = false, delayMs = LONG_PRESS_DELAY_MS }: Options) {
  const timerRef = useRef<number | null>(null)
  const startRef = useRef<LongPressPoint | null>(null)
  const firedRef = useRef(false)
  const callbackRef = useRef(onLongPress)
  callbackRef.current = onLongPress

  const clear = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    startRef.current = null
  }, [])

  useEffect(() => clear, [clear])

  const fire = useCallback((point: LongPressPoint) => {
    clear()
    firedRef.current = true
    callbackRef.current(point)
  }, [clear])

  const onPointerDown = useCallback((event: PointerEvent<HTMLElement>) => {
    if (!fromInside(event)) return
    firedRef.current = false
    if (disabled || event.pointerType === 'mouse' || event.isPrimary === false) return
    clear()
    const point = { clientX: event.clientX, clientY: event.clientY }
    startRef.current = point
    timerRef.current = window.setTimeout(() => fire(point), delayMs)
  }, [clear, delayMs, disabled, fire])

  const onPointerMove = useCallback((event: PointerEvent<HTMLElement>) => {
    const start = startRef.current
    if (!start) return
    if (
      Math.abs(event.clientX - start.clientX) > MOVE_TOLERANCE_PX
      || Math.abs(event.clientY - start.clientY) > MOVE_TOLERANCE_PX
    ) {
      clear()
    }
  }, [clear])

  const onContextMenu = useCallback((event: MouseEvent<HTMLElement>) => {
    if (disabled || !fromInside(event)) return
    event.preventDefault()
    if (firedRef.current) return
    fire({ clientX: event.clientX, clientY: event.clientY })
  }, [disabled, fire])

  const onClickCapture = useCallback((event: MouseEvent<HTMLElement>) => {
    if (!firedRef.current || !fromInside(event)) return
    firedRef.current = false
    event.preventDefault()
    event.stopPropagation()
  }, [])

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: clear,
    onPointerCancel: clear,
    onPointerLeave: clear,
    onContextMenu,
    onClickCapture,
  }
}
