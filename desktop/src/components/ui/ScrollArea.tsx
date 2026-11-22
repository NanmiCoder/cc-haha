import { forwardRef, type HTMLAttributes, type ReactNode } from 'react'

import { cx } from '@/lib/cx'

export type ScrollAreaOrientation = 'vertical' | 'horizontal' | 'both'

export type ScrollAreaProps = HTMLAttributes<HTMLDivElement> & {
  orientation?: ScrollAreaOrientation
  /** Applies auto-hiding 6px pill scrollbars that appear on hover or focus. */
  autohide?: boolean
  /** Soft 24px top scroll-edge mask preserving the 6px scrollbar lane. */
  fadeTop?: boolean
  /** Soft 24px bottom scroll-edge mask preserving the 6px scrollbar lane. */
  fadeBottom?: boolean
  /**
   * Uses the 7-stop `.topbar-scroll-fade` mask for scroll views gliding under
   * a translucent titlebar. Takes precedence over `fadeTop` / `fadeBottom`.
   */
  topbarFade?: boolean
  children: ReactNode
}

const ORIENTATION_CLASSES: Record<ScrollAreaOrientation, string> = {
  vertical: 'overflow-y-auto overflow-x-hidden',
  horizontal: 'overflow-x-auto overflow-y-hidden',
  both: 'overflow-auto',
}

/**
 * Lightweight single-node scrollable container with auto-hiding 6px pill
 * scrollbars and optional edge fades. Renders a single `<div>` with a
 * forwarded ref so virtualizers and scroll-position hooks can attach directly
 * without wrapper indirection.
 */
export const ScrollArea = forwardRef<HTMLDivElement, ScrollAreaProps>(function ScrollArea({
  orientation = 'vertical',
  autohide = true,
  fadeTop = false,
  fadeBottom = false,
  topbarFade = false,
  className,
  children,
  ...props
}, ref) {
  const useEdgeFade = !topbarFade && (fadeTop || fadeBottom)

  return (
    <div
      ref={ref}
      data-fade-top={useEdgeFade ? (fadeTop ? 'true' : 'false') : undefined}
      data-fade-bottom={useEdgeFade ? (fadeBottom ? 'true' : 'false') : undefined}
      className={cx(
        ORIENTATION_CLASSES[orientation],
        autohide && 'scrollbar-autohide',
        topbarFade && 'topbar-scroll-fade',
        useEdgeFade && 'scroll-edge-fade',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  )
})
