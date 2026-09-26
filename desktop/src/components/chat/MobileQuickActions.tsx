import { useCallback, useRef, useState } from 'react'
import { useTranslation } from '../../i18n'
import { useDismissable } from '@/hooks/useDismissable'

type Props = {
  onOpenTasks: () => void
  onOpenTerminal: () => void
  onOpenFiles: () => void
  onOpenReview: () => void
}

/**
 * Floating action button anchored at the top-right of the mobile composer.
 * Tapping it expands a horizontal row of four entries (tasks / terminal /
 * files / review); tapping the FAB again or outside dismisses it.
 *
 * Ported from the older fork's tasks/terminal/files set, with review (a git
 * worktree comparison) added because it has no other mobile entry point.
 */
export function MobileQuickActions({ onOpenTasks, onOpenTerminal, onOpenFiles, onOpenReview }: Props) {
  const t = useTranslation()
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useDismissable({
    open,
    refs: [containerRef],
    onDismiss: () => setOpen(false),
    stopEscapePropagation: true,
  })

  const run = useCallback((action: () => void) => {
    setOpen(false)
    action()
  }, [])

  const itemClass =
    'pointer-events-auto flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-3 h-9 text-[12.5px] font-medium text-[var(--color-text-primary)] shadow-[var(--shadow-overlay)] transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]'

  return (
    <div
      ref={containerRef}
      data-testid="mobile-quick-actions"
      className="pointer-events-none absolute -top-[14px] right-2.5 z-[var(--z-dropdown)] flex items-center gap-1.5"
    >
      {open && (
        <>
          <button
            type="button"
            className={itemClass}
            onClick={() => run(onOpenTasks)}
            aria-label={t('chat.openTasks')}
          >
            <span className="material-symbols-outlined text-[16px] text-[var(--color-text-secondary)]">assignment</span>
            {t('chat.openTasks')}
          </button>
          <button
            type="button"
            className={itemClass}
            onClick={() => run(onOpenTerminal)}
            aria-label={t('chat.openTerminal')}
          >
            <span className="material-symbols-outlined text-[16px] text-[var(--color-text-secondary)]">terminal</span>
            {t('chat.openTerminal')}
          </button>
          <button
            type="button"
            className={itemClass}
            onClick={() => run(onOpenFiles)}
            aria-label={t('chat.openFiles')}
          >
            <span className="material-symbols-outlined text-[16px] text-[var(--color-text-secondary)]">folder</span>
            {t('chat.openFiles')}
          </button>
          <button
            type="button"
            className={itemClass}
            onClick={() => run(onOpenReview)}
            aria-label={t('chat.openReview')}
          >
            <span className="material-symbols-outlined text-[16px] text-[var(--color-text-secondary)]">rate_review</span>
            {t('chat.openReview')}
          </button>
        </>
      )}
      <button
        type="button"
        aria-label={t('chat.quickActions')}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="pointer-events-auto flex h-[39px] w-[39px] shrink-0 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] text-[var(--color-text-secondary)] shadow-[var(--shadow-overlay)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
      >
        <span className={`material-symbols-outlined text-[23px] transition-transform duration-200 ${open ? 'rotate-45' : ''}`}>
          bolt
        </span>
      </button>
    </div>
  )
}

