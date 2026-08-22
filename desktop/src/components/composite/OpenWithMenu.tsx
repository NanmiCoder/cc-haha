import { createPortal } from 'react-dom'
import { useCallback, useRef } from 'react'
import { Globe, ExternalLink, FileText, Copy } from 'lucide-react'
import { useAnchoredPosition } from '@/hooks/useAnchoredPosition'
import { useDismissable } from '@/hooks/useDismissable'
import { TargetIcon } from './TargetIcon'
import type { OpenWithItem } from '../../lib/openWithItems'

type Props = {
  items: OpenWithItem[]
  anchor: { top: number; bottom: number; left: number; right: number }
  onClose: () => void
  // Optional trigger element to exclude from outside-close detection. When the
  // user clicks the same trigger that opened this menu, the trigger's own
  // click handler is responsible for toggling — don't double-close here.
  triggerEl?: HTMLElement | null
}

function ItemIcon({ item }: { item: OpenWithItem }) {
  if (item.target) return <TargetIcon target={item.target} size={20} />
  if (item.icon === 'in-app-browser') return <Globe size={18} strokeWidth={1.9} />
  if (item.icon === 'preview') return <FileText size={18} strokeWidth={1.9} />
  if (item.icon === 'copy') return <Copy size={18} strokeWidth={1.9} />
  return <ExternalLink size={18} strokeWidth={1.9} />
}

export function OpenWithMenu({ items, anchor, onClose, triggerEl }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const { style: positionStyle } = useAnchoredPosition({
    open: true,
    anchorRect: anchor,
    floatingRef: ref,
    placement: 'bottom-end',
  })

  // The hook takes a ref; this component is handed the raw trigger element by
  // its callers. Only the dismiss handler reads it, and it does so at event
  // time, so mirroring it into a ref here is safe.
  const triggerRef = useRef<HTMLElement | null>(null)
  triggerRef.current = triggerEl ?? null

  const dismiss = useCallback(() => onClose(), [onClose])

  useDismissable({
    open: true,
    refs: [ref],
    triggerRef,
    onDismiss: dismiss,
    // Kept on `mousedown` rather than the hook's `pointerdown` default: the
    // callers in `chat/` document this contract, so switching input events is
    // a separate change that has to land with them.
    event: 'mousedown',
    capture: false,
    closeOnViewportChange: true,
  })

  return createPortal(
    <div
      ref={ref}
      role="menu"
      className="min-w-[min(220px,calc(100vw-16px))] max-w-[min(300px,calc(100vw-16px))] overflow-hidden rounded-[12px] border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-[var(--shadow-dropdown)]"
      style={{ ...positionStyle, zIndex: 'var(--z-dropdown)' }}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          onClick={() => { item.onSelect(); onClose() }}
          className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm font-medium text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-hover)]"
        >
          <span className="flex h-6 w-6 items-center justify-center text-[var(--color-text-secondary)]"><ItemIcon item={item} /></span>
          <span className="min-w-0 truncate">{item.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  )
}
