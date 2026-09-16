import { cloneElement, useCallback, useId, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import { useAnchoredPosition, type AnchoredPlacement } from '@/hooks/useAnchoredPosition'
import { cx } from '@/lib/cx'

export type TooltipProps = {
  content: ReactNode
  /**
   * The element the tooltip describes. Receives the hover/focus handlers and
   * `aria-describedby`, so it must forward props to a DOM node.
   */
  children: ReactElement<Record<string, unknown>>
  placement?: AnchoredPlacement
  /** Delay before showing, in ms. Prevents flicker when sweeping the cursor. */
  delay?: number
  disabled?: boolean
  className?: string
  appearance?: 'inverse' | 'surface'
}

/**
 * A hover/focus tooltip.
 *
 * Replaces five implementations that differed in trigger (hover only, hover
 * plus focus, click), in z-index (four values), and in whether they were
 * reachable by keyboard at all.
 *
 * Uses `aria-describedby` rather than `aria-label`: a tooltip supplements the
 * element's name, it does not replace it. Overwriting the name is how an icon
 * button ends up announced as its tooltip text instead of its action.
 *
 * For a plain text hint on an icon button, prefer `IconButton`'s built-in
 * `title` — it costs no JavaScript. Reach for this when the content is rich or
 * the anchor needs flipping.
 */
export function Tooltip({
  content,
  children,
  placement = 'top-start',
  delay = 300,
  disabled = false,
  className,
  appearance = 'inverse',
}: TooltipProps) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLElement | null>(null)
  const floatingRef = useRef<HTMLDivElement | null>(null)
  const timerRef = useRef<number | null>(null)
  const tooltipId = useId()

  const { style } = useAnchoredPosition({
    open,
    anchorRef,
    floatingRef,
    placement,
    offset: 6,
  })

  const cancelTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const show = useCallback(() => {
    if (disabled) return
    cancelTimer()
    if (delay <= 0) {
      setOpen(true)
      return
    }
    timerRef.current = window.setTimeout(() => setOpen(true), delay)
  }, [cancelTimer, delay, disabled])

  const hide = useCallback(() => {
    cancelTimer()
    setOpen(false)
  }, [cancelTimer])

  const trigger = cloneElement(children, {
    ref: (node: HTMLElement | null) => {
      anchorRef.current = node
      const forwarded = (children as unknown as { ref?: unknown }).ref
      if (typeof forwarded === 'function') forwarded(node)
      else if (forwarded && typeof forwarded === 'object') {
        (forwarded as { current: HTMLElement | null }).current = node
      }
    },
    onMouseEnter: show,
    onMouseLeave: hide,
    // Focus, not just hover: a keyboard user never generates a mouseenter.
    onFocus: show,
    onBlur: hide,
    // Escape dismisses without moving focus away.
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key === 'Escape' && open) hide()
      ;(children.props.onKeyDown as ((e: React.KeyboardEvent) => void) | undefined)?.(event)
    },
    'aria-describedby': open ? tooltipId : undefined,
  })

  return (
    <>
      {trigger}
      {open && createPortal(
        <div
          ref={floatingRef}
          id={tooltipId}
          role="tooltip"
          style={{ ...style, zIndex: 'var(--z-tooltip)' }}
          className={cx(
            'pointer-events-none max-w-xs rounded-[var(--radius-md)] px-2 py-1',
            appearance === 'surface'
              ? 'border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] text-[var(--color-text-primary)] text-[13px] leading-5'
              : 'bg-[var(--color-inverse-surface)] text-[var(--color-inverse-on-surface)] text-xs leading-5 shadow-[var(--shadow-dropdown)]',
            'animate-overlay-in',
            className,
          )}
        >
          {content}
        </div>,
        document.body,
      )}
    </>
  )
}
