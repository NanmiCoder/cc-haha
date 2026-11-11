import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { useTranslation } from '@/i18n'
import { useDismissable } from '@/hooks/useDismissable'

type Props = { onClose: () => void, children: ReactNode }
type Drag = { id: number, x: number, y: number, time: number, horizontal: boolean, cancelled: boolean }

/** Navigation covers part of the phone; the conversation underneath stays alive. */
export function MobileSessionDrawer({ onClose, children }: Props) {
  const t = useTranslation()
  const panelRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<Drag | null>(null)
  const [offset, setOffset] = useState(0)
  useDismissable({
    open: true,
    refs: [panelRef],
    onDismiss: onClose,
    closeOnEscape: false,
    // Rename/delete sheets are portals belonging to this drawer.
    isExempt: () => Boolean(document.querySelector('[role="dialog"]:not([data-testid="mobile-session-drawer-panel"])')),
  })
  useEffect(() => {
    const opener = document.activeElement
    panelRef.current?.focus({ preventScroll: true })
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('[role="dialog"]:not([data-testid="mobile-session-drawer-panel"])')) return
      onClose()
    }
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('keydown', escape)
      if (opener instanceof HTMLButtonElement && opener.isConnected) opener.focus({ preventScroll: true })
    }
  }, [onClose])

  const move = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.id !== event.pointerId || drag.cancelled) return
    if (document.querySelector('[role="dialog"]:not([data-testid="mobile-session-drawer-panel"])')) {
      drag.cancelled = true
      setOffset(0)
      return
    }
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    if (!drag.horizontal) {
      if (Math.abs(dy) > 8 && Math.abs(dy) >= Math.abs(dx)) {
        drag.cancelled = true
        return
      }
      if (dx >= -8 || Math.abs(dx) < Math.abs(dy) * 1.2) return
      drag.horizontal = true
      event.currentTarget.setPointerCapture?.(event.pointerId)
    }
    setOffset(Math.min(0, dx))
  }
  const end = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    dragRef.current = null
    setOffset(0)
    if (!drag || !drag.horizontal || drag.cancelled || event.type !== 'pointerup') return
    const distance = drag.x - event.clientX
    const velocity = distance / Math.max(1, event.timeStamp - drag.time)
    if (distance >= 64 || (distance >= 28 && velocity >= 0.5)) onClose()
  }

  return (
    <div data-testid="mobile-session-drawer" className="animate-overlay-in absolute inset-0 z-[var(--z-drawer)] bg-[var(--color-overlay-scrim)]">
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label={t('mobile.home.title')} tabIndex={-1}
        data-testid="mobile-session-drawer-panel"
        className="animate-mobile-drawer absolute inset-y-0 left-0 flex w-[min(86vw,340px)] touch-pan-y flex-col overflow-hidden bg-[var(--color-surface)] shadow-[var(--shadow-overlay)] focus:outline-none"
        style={offset < 0 ? { transform: `translateX(${offset}px)` } : undefined}
        onPointerDown={event => {
          // Portalled rename/delete sheets bubble through the React tree but
          // are not drawer gestures. Never capture their input/selection drags.
          if (!event.isPrimary || event.button !== 0 || !event.currentTarget.contains(event.target as Node) ||
            document.querySelector('[role="dialog"]:not([data-testid="mobile-session-drawer-panel"])')) return
          event.currentTarget.getAnimations?.().forEach(animation => animation.cancel())
          dragRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, time: event.timeStamp, horizontal: false, cancelled: false }
        }}
        onPointerMove={move} onPointerUp={end} onPointerCancel={end}
        onKeyDown={event => {
          if (event.key !== 'Tab' || event.defaultPrevented) return
          // React portal events still reach us: trap a nested sheet in its own
          // dialog, rather than sending its focus into the drawer underneath.
          const scope = (event.target as Element).closest<HTMLElement>('[role="dialog"]') ?? panelRef.current
          const targets = Array.from(scope?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex="0"]') ?? [])
          const first = targets[0]
          const last = targets[targets.length - 1]
          if (event.shiftKey && (document.activeElement === first || document.activeElement === scope)) {
            event.preventDefault()
            last?.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first?.focus()
          }
        }}
      >{children}</div>
    </div>
  )
}
