import { MessageCircle } from 'lucide-react'
import { useTranslation } from '@/i18n'
import type { FloatingSelectionMenuState } from './textSelection'

export function FloatingSelectionMenu({
  selection,
  onAdd,
  popoverRef,
}: {
  selection: FloatingSelectionMenuState | null
  onAdd: () => void
  popoverRef: { current: HTMLButtonElement | null }
}) {
  const t = useTranslation()
  if (!selection) return null

  return (
    <button
      ref={popoverRef}
      type="button"
      onMouseDown={(event) => {
        if (event.button === 0 && !event.ctrlKey) event.preventDefault()
      }}
      onClick={onAdd}
      className="fixed z-[var(--z-popover)] inline-flex h-8 items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-3 text-[13px] font-medium text-[var(--color-text-primary)] shadow-[var(--shadow-dropdown)] transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
      style={{ left: selection.x, top: selection.y }}
    >
      <MessageCircle size={14} strokeWidth={1.75} className="shrink-0 text-[var(--color-text-secondary)]" aria-hidden="true" />
      <span>{t('workspace.addSelectionToChat')}</span>
    </button>
  )
}
