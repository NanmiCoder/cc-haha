import { Fragment, useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CircleHelp, X } from 'lucide-react'

import { IconButton } from '@/components/ui/IconButton'
import { useAnchoredPosition } from '@/hooks/useAnchoredPosition'
import { useDismissable, type DismissReason } from '@/hooks/useDismissable'

export type SettingsHelpEntry = {
  /** Short label in the left column, e.g. "What it is". */
  label: string
  body: ReactNode
}

export type SettingsHelpProps = {
  /**
   * The question the card answers ("What is Auto-dream?"). It heads the card
   * and names the trigger, so a screen reader hears the same words the card
   * opens with.
   */
  title: string
  entries: SettingsHelpEntry[]
  closeLabel: string
}

/**
 * The "?" beside a setting's title, and the card it opens.
 *
 * For settings whose name says little to someone who has not used Claude
 * Code — Auto-dream, Ultracode, lean mode. The row's description stays the
 * one-line summary; this holds the plain explanation: what it is, when to
 * turn it on, what it costs.
 *
 * A click opens it, not a hover: the explanation runs to several lines that
 * people read rather than glance at, and a hover card vanishes the moment the
 * pointer drifts toward it. The card is non-modal — the page stays usable —
 * and closes on an outside click, Escape, the close button, or a scroll that
 * would leave it detached from its row.
 */
export function SettingsHelp({ title, entries, closeLabel }: SettingsHelpProps) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const cardId = useId()
  const titleId = useId()

  const { style, ready } = useAnchoredPosition({
    open,
    anchorRef: triggerRef,
    floatingRef: cardRef,
    placement: 'top-start',
    offset: 8,
  })

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus()
  }, [])

  // Escape returns focus to the "?" so the keyboard user is back where they
  // started; a click elsewhere leaves focus wherever that click put it.
  const handleDismiss = useCallback((reason: DismissReason) => close(reason === 'escape'), [close])

  useDismissable({
    open,
    refs: [cardRef],
    triggerRef,
    onDismiss: handleDismiss,
    stopEscapePropagation: true,
    closeOnViewportChange: true,
  })

  // Focus the card once it is placed, so a screen reader reads it on open.
  // Before `ready` it is still `visibility: hidden`, and focus would not land.
  // `preventScroll`: a focus-driven scroll would count as a viewport change
  // and close the card it just opened.
  useEffect(() => {
    if (open && ready) cardRef.current?.focus({ preventScroll: true })
  }, [open, ready])

  return (
    <>
      <IconButton
        ref={triggerRef}
        icon={<CircleHelp size={14} strokeWidth={1.75} aria-hidden="true" />}
        label={title}
        showTooltip={false}
        size="2xs"
        // Open: full-strength glyph on the selected fill, so it is clear which
        // "?" the card belongs to. A tone swap rather than a className text
        // override, which would lose to the muted tone's own text class.
        tone={open ? 'default' : 'muted'}
        className={open ? 'bg-[var(--color-surface-selected)]' : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? cardId : undefined}
        onClick={() => setOpen((value) => !value)}
      />
      {open && createPortal(
        <div
          ref={cardRef}
          id={cardId}
          role="dialog"
          aria-labelledby={titleId}
          tabIndex={-1}
          style={{ ...style, zIndex: 'var(--z-popover)' }}
          className="w-[340px] max-w-[calc(100vw-16px)] rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-4 pb-3.5 pt-3 text-left shadow-[var(--shadow-dropdown)] outline-none animate-overlay-in"
        >
          <div className="flex items-start justify-between gap-3">
            <p id={titleId} className="min-w-0 text-[13px] font-semibold leading-5 text-[var(--color-text-primary)]">
              {title}
            </p>
            <IconButton
              icon={<X size={14} strokeWidth={1.75} aria-hidden="true" />}
              label={closeLabel}
              size="2xs"
              tone="muted"
              onClick={() => close(true)}
            />
          </div>
          <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs leading-[1.6]">
            {entries.map((entry) => (
              <Fragment key={entry.label}>
                <dt className="whitespace-nowrap text-[var(--color-text-tertiary)]">{entry.label}</dt>
                <dd className="min-w-0 text-[var(--color-text-primary)]">{entry.body}</dd>
              </Fragment>
            ))}
          </dl>
        </div>,
        document.body,
      )}
    </>
  )
}
