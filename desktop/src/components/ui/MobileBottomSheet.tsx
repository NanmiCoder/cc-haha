import { useEffect, useRef, type ReactNode, type Ref } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { isTouchH5Document } from '@/lib/touchH5'

const NON_TEXT_INPUT_TYPES = new Set(['button', 'checkbox', 'color', 'file', 'image', 'radio', 'range', 'reset', 'submit'])

/**
 * On a touch device, focusing a field raises the soft keyboard, so focus is not
 * handed back to one unasked. A keyboard user on a narrow desktop window has no
 * soft keyboard and wants to land back in the field they left.
 */
function wouldRaiseSoftKeyboard(element: Element): boolean {
  if (!isTouchH5Document()) return false
  if (element instanceof HTMLTextAreaElement) return true
  if (element instanceof HTMLInputElement) return !NON_TEXT_INPUT_TYPES.has(element.type)
  return element.closest('[contenteditable]:not([contenteditable="false"])') !== null
}

type Props = {
  open: boolean
  onClose: () => void
  title: ReactNode
  children: ReactNode
  closeLabel?: string
  headerExtra?: ReactNode
  footer?: ReactNode
  id?: string
  role?: string
  ariaLabel?: string
  contentClassName?: string
  panelClassName?: string
  panelRef?: Ref<HTMLDivElement>
  testId?: string
  /**
   * Nearly the full screen, for content read in full before acting on it (a
   * plan to approve, a set of questions). The default stops at 78% so the page
   * it was opened from stays in view above it.
   */
  tall?: boolean
}

export function MobileBottomSheet({
  open,
  onClose,
  title,
  children,
  closeLabel = 'Close',
  headerExtra,
  footer,
  id,
  role = 'dialog',
  ariaLabel,
  contentClassName = '',
  panelClassName = '',
  panelRef,
  testId,
  tall = false,
}: Props) {
  const scrimRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  // A modal dialog takes focus when it opens (so a keyboard or screen reader
  // user lands in it, not on the page it covers) and gives it back when it
  // closes. A child that already took focus keeps it.
  useEffect(() => {
    if (!open) return
    const opener = document.activeElement
    const panel = scrimRef.current?.firstElementChild
    if (panel instanceof HTMLElement && !panel.contains(document.activeElement)) panel.focus({ preventScroll: true })
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected && !wouldRaiseSoftKeyboard(opener)) opener.focus({ preventScroll: true })
    }
  }, [open])

  if (!open) return null

  return createPortal(
    <div ref={scrimRef} className="fixed inset-0 z-[var(--z-sheet)] bg-[var(--color-overlay-scrim)]" onClick={onClose}>
      <div
        ref={panelRef}
        id={id}
        role={role}
        aria-modal={role === 'dialog' ? true : undefined}
        aria-label={ariaLabel ?? (typeof title === 'string' ? title : undefined)}
        data-testid={testId}
        tabIndex={-1}
        className={`absolute inset-x-0 bottom-0 flex ${tall ? 'max-h-[92dvh]' : 'max-h-[min(78dvh,640px)]'} min-h-0 flex-col overflow-hidden rounded-t-[var(--radius-xl)] border-x-0 border-y border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] shadow-[var(--shadow-overlay)] focus:outline-none ${panelClassName}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="shrink-0 border-b border-[var(--color-border)] px-4 py-3">
          <div className="flex min-h-10 items-center justify-between gap-3">
            <div className="min-w-0 text-[13px] font-semibold text-[var(--color-text-primary)]">
              {title}
            </div>
            <button
              type="button"
              aria-label={closeLabel}
              onClick={onClose}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
            >
              <X size={18} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </div>
          {headerExtra && (
            <div className="mt-3">
              {headerExtra}
            </div>
          )}
        </div>

        <div className={`min-h-0 flex-1 overflow-y-auto ${contentClassName}`}>
          {children}
        </div>

        {footer && (
          <div className="shrink-0 border-t border-[var(--color-border)]">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
