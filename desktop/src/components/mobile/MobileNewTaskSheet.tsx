import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useTranslation } from '../../i18n'
import { EmptySession } from '../../pages/EmptySession'

/** How far the sheet must be pulled down to close on release. */
export const SHEET_DISMISS_DISTANCE_PX = 120
/** A quick flick closes it from a shorter pull, in px per ms. */
const SHEET_DISMISS_VELOCITY = 0.6
const SHEET_FLICK_MIN_DISTANCE_PX = 24

type Props = {
  /** The folder the task starts in; the person can change it at the top. */
  workDir: string
  /** Leaves without starting anything. The shell routes it through history. */
  onCancel: () => void
}

/**
 * The phone's new task: a full-height sheet over the session list, with the
 * project at the top and the composer docked to the bottom. Cancel, the system
 * back gesture or pulling the bar down closes it; sending opens the new
 * session, and the shell takes the sheet away as the page changes.
 *
 * Only the bar at the top is draggable. The page under it scrolls and holds a
 * text field, and a pull that starts there belongs to them.
 */
export function MobileNewTaskSheet({ workDir, onCancel }: Props) {
  const t = useTranslation()
  const [dragY, setDragY] = useState(0)
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<{ pointerId: number; startY: number; startTime: number } | null>(null)

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || (event.target as Element).closest('button')) return
    dragRef.current = { pointerId: event.pointerId, startY: event.clientY, startTime: event.timeStamp }
    event.currentTarget.setPointerCapture?.(event.pointerId)
    setDragging(true)
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    setDragY(Math.max(0, event.clientY - drag.startY))
  }

  const handlePointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    setDragging(false)
    const distance = Math.max(0, event.clientY - drag.startY)
    const elapsed = Math.max(1, event.timeStamp - drag.startTime)
    const flicked = distance >= SHEET_FLICK_MIN_DISTANCE_PX && distance / elapsed >= SHEET_DISMISS_VELOCITY
    if (event.type === 'pointerup' && (distance >= SHEET_DISMISS_DISTANCE_PX || flicked)) {
      onCancel()
      return
    }
    setDragY(0)
  }

  return (
    <div data-testid="mobile-new-task-sheet" className="absolute inset-0 z-[var(--z-sheet)]">
      <div aria-hidden="true" className="animate-overlay-in absolute inset-0 bg-[var(--color-overlay-scrim)]" onClick={onCancel} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('mobile.newTask.title')}
        style={dragY > 0 ? { transform: `translateY(${dragY}px)` } : undefined}
        className={`animate-sheet-rise absolute inset-x-0 bottom-0 top-[calc(env(safe-area-inset-top,0px)+8px)] flex flex-col overflow-hidden rounded-t-[var(--radius-xl)] bg-[var(--color-surface)] shadow-[var(--shadow-overlay)] ${
          dragging ? '' : 'transition-transform duration-200 ease-out'
        }`}
      >
        <div
          data-testid="mobile-new-task-grabber"
          className="shrink-0 touch-none select-none"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
        >
          <div aria-hidden="true" className="mx-auto mt-2 h-1 w-9 rounded-[var(--radius-full)] bg-[var(--color-outline)]" />
          <div className="grid h-12 grid-cols-[1fr_auto_1fr] items-center px-1">
            <button
              type="button"
              onClick={onCancel}
              className="h-11 justify-self-start rounded-[var(--radius-md)] px-3 text-[15px] text-[var(--color-text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
            >
              {t('common.cancel')}
            </button>
            <h2 className="text-[15px] font-semibold text-[var(--color-text-primary)]">{t('mobile.newTask.title')}</h2>
            <span aria-hidden="true" />
          </div>
        </div>
        <div className="relative flex min-h-0 flex-1 flex-col">
          <EmptySession initialWorkDir={workDir} />
        </div>
      </div>
    </div>
  )
}
